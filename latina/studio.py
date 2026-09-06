"""The voice studio: a web GUI for cloning, auditioning and managing voices.

This module is deliberately detachable. `latina/api.py` calls `install()` inside
a try/except, so if anything here fails to import — most likely
`python-multipart`, which FastAPI requires at *decorator* time for any route
taking a file — the GUI is disabled and the TTS service carries on untouched.
`LATINA_STUDIO=0` turns it off outright.

Everything new lives under `/api/...` so it cannot shadow the frozen `/voices`
and `/speak` surfaces that miniclosedai and the Mozart demo depend on.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Optional

from fastapi import (APIRouter, Depends, File, Form, HTTPException, Request,
                     UploadFile)
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import audio_io, config
from .engine import engine

_CHUNK = 1 << 20                      # read uploads a MiB at a time
_analysis_cache: dict[tuple, dict] = {}


class TranscriptBody(BaseModel):
    reference_text: str = Field(default="", max_length=4000)


def _max_bytes() -> int:
    return config.STUDIO_MAX_UPLOAD_MB * 1024 * 1024


def _voice_or_404(voice_id: str):
    """Resolve through the registry — never by joining user text to a path."""
    v = engine.voices.get(voice_id)
    if v is None:
        raise HTTPException(404, f"unknown voice {voice_id!r}")
    return v


async def _read_capped(file: UploadFile, request: Request) -> bytes:
    """Read an upload, refusing to buffer more than the cap.

    Starlette spools an UploadFile over 1 MB to disk, so without an explicit
    ceiling one request can fill the volume. Content-Length gives a fast
    rejection; the chunked read catches a header that lies.
    """
    cap = _max_bytes()
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap + (1 << 20):
        raise HTTPException(413, f"file larger than {config.STUDIO_MAX_UPLOAD_MB} MB")
    buf = bytearray()
    while True:
        chunk = await file.read(_CHUNK)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > cap:
            raise HTTPException(413, f"file larger than {config.STUDIO_MAX_UPLOAD_MB} MB")
    return bytes(buf)


def _decode_and_analyze(raw: bytes, filename: str, normalize: bool) -> tuple:
    """CPU-bound; always called through asyncio.to_thread."""
    y, sr, decoder = audio_io.decode_upload(
        raw, filename, ffmpeg_timeout=config.STUDIO_FFMPEG_TIMEOUT)
    channels = y.shape[1] if y.ndim > 1 else 1
    canon = audio_io.to_canonical(y, sr, config.STUDIO_CANONICAL_SR, normalize)
    a = audio_io.analyze(canon, config.STUDIO_CANONICAL_SR)
    a["source_sample_rate"] = int(sr)
    a["source_channels"] = int(channels)
    a["decoder"] = decoder
    a["stored_sample_rate"] = config.STUDIO_CANONICAL_SR
    grade, errors, warnings = audio_io.verdict(a)
    return canon, a, grade, errors, warnings


def _payload(a, grade, errors, warnings) -> dict:
    return {"analysis": a, "grade": grade, "errors": errors,
            "warnings": warnings, "checks": errors + warnings}


def _voice_summary() -> list[dict]:
    return [{"id": v.id,
             "reference_text": v.text,
             "is_default": v.id == config.DEFAULT_VOICE}
            for v in engine.voices.values()]


def build_router(auth) -> APIRouter:
    """Build the studio router. `auth` is api.require_key, passed in rather
    than imported to keep this module free of a circular dependency."""
    router = APIRouter(prefix="/api", tags=["studio"])

    @router.get("/studio")
    async def studio_config():
        """Open on purpose: the page needs to know whether to ask for a key."""
        return {
            "auth_required": bool(config.API_KEY),
            "sample_rate": engine.sample_rate,
            "default_voice": config.DEFAULT_VOICE,
            "language": config.DEFAULT_LANGUAGE,
            "max_upload_bytes": _max_bytes(),
            "max_voices": config.STUDIO_MAX_VOICES,
            "max_text_chars": 4000,
            "duration_bounds": [audio_io.HARD_MIN_S, audio_io.HARD_MAX_S],
            "recommended_duration": [audio_io.SOFT_MIN_S, audio_io.SOFT_MAX_S],
            "model_band_hz": audio_io.MODEL_BAND_HZ,
            "stored_sample_rate": config.STUDIO_CANONICAL_SR,
        }

    @router.get("/studio/auth", dependencies=[Depends(auth)])
    async def studio_auth():
        return {"ok": True}

    @router.get("/studio/voices", dependencies=[Depends(auth)])
    async def studio_voices():
        return {"voices": _voice_summary(), "default": config.DEFAULT_VOICE}

    @router.post("/voices/analyze", dependencies=[Depends(auth)])
    async def analyze_clip(request: Request,
                           file: UploadFile = File(...),
                           normalize: bool = Form(False)):
        """Measure a clip WITHOUT saving it, so the verdict lands before commit."""
        raw = await _read_capped(file, request)
        try:
            _, a, grade, errors, warnings = await asyncio.to_thread(
                _decode_and_analyze, raw, file.filename or "", normalize)
        except audio_io.AudioRejected as e:
            raise HTTPException(422, {"reasons": e.reasons})
        return _payload(a, grade, errors, warnings)

    @router.post("/voices/upload", status_code=201, dependencies=[Depends(auth)])
    async def upload_voice(request: Request,
                           file: UploadFile = File(...),
                           voice_id: str = Form(""),
                           transcript: str = Form(""),
                           normalize: bool = Form(False),
                           overwrite: bool = Form(False)):
        raw = await _read_capped(file, request)
        stem = Path(file.filename or "voice").stem
        try:
            vid = audio_io.slugify_voice_id(voice_id or stem, fallback="voice")
        except audio_io.AudioRejected as e:
            raise HTTPException(422, {"reasons": e.reasons})

        if vid in engine.voices and not overwrite:
            raise HTTPException(409, f"voice {vid!r} already exists")
        if vid not in engine.voices and len(engine.voices) >= config.STUDIO_MAX_VOICES:
            raise HTTPException(507, f"voice limit reached ({config.STUDIO_MAX_VOICES})")

        try:
            canon, a, grade, errors, warnings = await asyncio.to_thread(
                _decode_and_analyze, raw, file.filename or "", normalize)
        except audio_io.AudioRejected as e:
            raise HTTPException(422, {"reasons": e.reasons})
        if errors:
            raise HTTPException(422, {"reasons": [e["detail"] for e in errors],
                                      "checks": errors, "analysis": a})

        await asyncio.to_thread(audio_io.write_voice_atomic,
                                config.VOICES_DIR, vid, canon,
                                config.STUDIO_CANONICAL_SR, transcript)
        engine.rescan_voices()
        _analysis_cache.clear()
        out = _payload(a, grade, errors, warnings)
        out.update(id=vid, voices=_voice_summary())
        return out

    @router.get("/voices/{voice_id}/audio", dependencies=[Depends(auth)])
    async def voice_audio(voice_id: str):
        v = _voice_or_404(voice_id)
        return FileResponse(str(v.wav), media_type="audio/wav",
                            filename=f"{v.id}.wav")

    @router.get("/voices/{voice_id}/analysis", dependencies=[Depends(auth)])
    async def voice_analysis(voice_id: str):
        """Measure a clip already in the library.

        This is what makes the shipped voice's problem visible instead of
        silently inherited.
        """
        v = _voice_or_404(voice_id)
        try:
            st = v.wav.stat()
        except OSError:
            raise HTTPException(404, f"clip for {voice_id!r} is missing")
        key = (str(v.wav), st.st_mtime_ns, st.st_size)
        if key not in _analysis_cache:
            raw = await asyncio.to_thread(v.wav.read_bytes)
            try:
                _, a, grade, errors, warnings = await asyncio.to_thread(
                    _decode_and_analyze, raw, v.wav.name, False)
            except audio_io.AudioRejected as e:
                raise HTTPException(422, {"reasons": e.reasons})
            _analysis_cache.clear()          # bounded: one entry per request set
            _analysis_cache[key] = _payload(a, grade, errors, warnings)
        return {**_analysis_cache[key], "id": v.id}

    @router.put("/voices/{voice_id}/transcript", dependencies=[Depends(auth)])
    async def set_transcript(voice_id: str, body: TranscriptBody):
        v = _voice_or_404(voice_id)
        txt = Path(v.wav).with_suffix(".txt")
        text = body.reference_text.strip()
        if text:
            tmp = txt.with_suffix(".txt.part")
            await asyncio.to_thread(tmp.write_text, text + "\n", "utf-8")
            import os
            os.replace(tmp, txt)
        elif txt.exists():
            txt.unlink()
        engine.rescan_voices()
        return {"id": voice_id, "reference_text": text or None}

    @router.delete("/voices/{voice_id}", dependencies=[Depends(auth)])
    async def delete_voice(voice_id: str):
        _voice_or_404(voice_id)
        if voice_id == config.DEFAULT_VOICE:
            raise HTTPException(
                409, f"{voice_id!r} is the default voice and cannot be deleted")
        if len(engine.voices) <= 1:
            raise HTTPException(409, "cannot delete the last remaining voice")
        moved = await asyncio.to_thread(audio_io.trash_voice,
                                        config.VOICES_DIR, voice_id)
        engine.rescan_voices()
        _analysis_cache.clear()
        return {"deleted": voice_id, "moved_to_trash": moved,
                "voices": _voice_summary()}

    return router


def install(app, auth) -> None:
    """Attach the studio to an existing FastAPI app.

    Building the router here (not at module import) means the multipart check
    FastAPI runs at decorator time happens inside api.py's try/except.
    """
    app.include_router(build_router(auth))

    static_dir = Path(config.STUDIO_STATIC_DIR)
    if not static_dir.is_dir():
        raise RuntimeError(f"static directory not found: {static_dir}")

    # Mounted at /studio, never at "/" — a root mount would shadow the API.
    app.mount("/studio", StaticFiles(directory=str(static_dir), html=True),
              name="studio")

    @app.get("/", include_in_schema=False)
    async def _root():
        return RedirectResponse("/studio/")
