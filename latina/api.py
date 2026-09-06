"""FastAPI service for the Latina voice.

Endpoints:
    GET  /health          — is the model in memory yet
    GET  /voices          — reference clips this instance serves
    POST /speak           — SSE stream of base64 int16 PCM chunks
    POST /speak.wav       — one WAV file, for curl and quick listening

The SSE shape matches what the Mozart demo's player already consumes:
    data: {"chunk_b64": "...", "sample_rate": 48000, "chunk": 1}
    data: {"end": true, "chunks": 7, "ms": 3120}
"""

from __future__ import annotations

import asyncio
import base64
import json
import queue
from concurrent.futures import ThreadPoolExecutor
import time
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import config
from .engine import engine, to_pcm16, to_wav

# One reusable generation thread instead of a fresh one per request.
# Spawning a new thread per request costs ~26 ms of extra time-to-first-chunk
# (measured: median 181 ms new-thread vs 155 ms reused) because each new thread
# pays CUDA per-thread setup. max_workers=1 keeps the existing serialisation —
# the engine already holds a global lock, so this adds no new contention.
# NOTE: the consumption side below is unchanged on purpose; see the comment in
# `speak` about why queue.Queue + asyncio.to_thread is the only pattern that
# actually streams.
_GEN_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="latina-gen")

app = FastAPI(title="Latina Voice TTS", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


async def require_key(authorization: str = Header(default="")) -> None:
    """No-op unless LATINA_API_KEY is set."""
    if not config.API_KEY:
        return
    if authorization != f"Bearer {config.API_KEY}":
        raise HTTPException(401, "bad or missing bearer token")


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: Optional[str] = None
    language: Optional[str] = None
    # miniclosedai sends `speed`; VoxCPM2 has no speed control, so it is
    # accepted and ignored rather than rejected as an unknown field.
    speed: Optional[float] = None


@app.on_event("startup")
async def _startup() -> None:
    # Loading blocks for a while; a thread keeps the event loop free so
    # /health answers "loading" instead of hanging the socket.
    await asyncio.to_thread(engine.load)


@app.get("/health")
async def health():
    return {
        "ok": engine.is_ready,
        "model": config.MODEL_ID,
        "sample_rate": engine.sample_rate,
        "voices": list(engine.voices),
        "default_voice": config.DEFAULT_VOICE,
        "optimize": config.OPTIMIZE,
        "loaded_at": engine.loaded_at,
    }


@app.get("/voices")
async def voices():
    """Catalog keyed BY LANGUAGE — the shape miniclosedai's voice-backend
    client expects: {"es": [{id, name, gender}, ...]}. Register this service as
    a kind=voice backend there and it shows up in every bot's voice picker.

    A flat list would be friendlier to read, but it would not register.
    `/voices/detail` keeps the extra fields for humans.
    """
    return {config.DEFAULT_LANGUAGE: [
        {"id": v.id, "name": v.id.replace("_", " "), "gender": None}
        for v in engine.voices.values()
    ]}


@app.get("/voices/detail")
async def voices_detail():
    """Everything we know about each clip, including its reference transcript."""
    return {"voices": [v.as_dict() for v in engine.voices.values()],
            "default": config.DEFAULT_VOICE,
            "language": config.DEFAULT_LANGUAGE,
            "sample_rate": engine.sample_rate}


@app.post("/speak", dependencies=[Depends(require_key)])
@app.post("/speak/stream", dependencies=[Depends(require_key)])
async def speak(req: SpeakRequest):
    """Stream audio as it is generated.

    Mounted at both paths on purpose: `/speak/stream` is what miniclosedai's
    voice client calls, `/speak` is the plainer name everything else uses.
    """
    if not engine.is_ready:
        return JSONResponse({"error": "model still loading"}, status_code=503)
    try:
        engine.resolve(req.voice)
    except KeyError as e:
        return JSONResponse({"error": str(e)}, status_code=404)

    async def gen():
        t0 = time.perf_counter()
        n = 0
        # `generate_streaming` is a BLOCKING generator that really does yield
        # progressively (~250 ms apart). Getting those chunks OUT as they
        # arrive is the fiddly part: draining it with `list(...)` in a thread,
        # or bridging with run_coroutine_threadsafe onto a bounded asyncio
        # queue, both ended up delivering everything at the end (measured: 47
        # chunks all landing at 11.8 s). A plain daemon thread writing to a
        # plain queue.Queue, consumed with `await asyncio.to_thread(q.get)`,
        # interleaves properly — each get parks in the executor and leaves the
        # event loop free to flush the chunk it just handed us.
        q: "queue.Queue[object]" = queue.Queue()
        DONE = object()

        def produce():
            try:
                for chunk in engine.synthesize_streaming(
                        req.text, req.voice, req.language):
                    q.put(chunk)
            except Exception as e:                  # travels to the client
                q.put(e)
            finally:
                q.put(DONE)

        _GEN_POOL.submit(produce)
        while True:
            item = await asyncio.to_thread(q.get)
            if item is DONE:
                break
            if isinstance(item, Exception):
                yield f"data: {json.dumps({'error': f'{type(item).__name__}: {item}'})}\n\n"
                return
            n += 1
            yield ("data: " + json.dumps({
                "chunk_b64": base64.b64encode(to_pcm16(item)).decode("ascii"),
                "sample_rate": engine.sample_rate,
                "chunk": n,
            }) + "\n\n")
        # Terminal frame carries BOTH keys: miniclosedai stops on `done`,
        # the Mozart page stops on `end`. Emitting one would silently hang the
        # other waiting for a terminator that never comes.
        yield ("data: " + json.dumps({
            "done": True, "end": True, "chunks": n,
            "ms": round((time.perf_counter() - t0) * 1000),
        }) + "\n\n")

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.post("/speak.wav", dependencies=[Depends(require_key)])
async def speak_wav(req: SpeakRequest):
    """One WAV back. Handy for `curl ... --output out.wav` and for listening."""
    if not engine.is_ready:
        return JSONResponse({"error": "model still loading"}, status_code=503)
    try:
        audio = await asyncio.to_thread(
            engine.synthesize, req.text, req.voice, req.language)
    except KeyError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    return Response(content=to_wav(audio, engine.sample_rate),
                    media_type="audio/wav")


# --------------------------------------------------------------------------- #
# Voice studio (the web GUI). Optional, and deliberately fail-open.
#
# FastAPI runs ensure_multipart_is_installed() at DECORATOR time for any route
# taking a file, so importing the studio can raise on a box whose venv predates
# `python-multipart` in requirements.txt — and start.sh only pip-installs when
# .venv is absent. Without this guard that would make the module fail to import
# and take /speak down with it. Here the worst case is one log line.
# --------------------------------------------------------------------------- #
if config.STUDIO_ENABLED:
    try:
        from .studio import install as _install_studio
        _install_studio(app, require_key)
        print("[latina] voice studio at /studio/", flush=True)
    except Exception as _e:
        print(f"[latina] voice studio disabled: {type(_e).__name__}: {_e}",
              flush=True)
