"""VoxCPM2 wrapper — loads the model once, keeps it in memory, synthesizes.

Deliberately NOT a port of the dealership pipeline it came from. The original
wraps English brand names in quotes so VoxCPM2 pronounces "Honda Civic" in
English inside a Spanish sentence, and it builds that brand list from a vehicle
database. That is car-specific vocabulary; none of it is here. What is here is
the voice.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Generator, Optional

import numpy as np

from . import config


class Voice:
    """A reference clip on disk: `<id>.wav`, plus an optional `<id>.txt`."""

    def __init__(self, wav: Path):
        self.id = wav.stem
        self.wav = wav
        txt = wav.with_suffix(".txt")
        self.text: Optional[str] = (
            txt.read_text(encoding="utf-8").strip() if txt.is_file() else None
        )

    def as_dict(self) -> dict:
        return {"id": self.id, "reference_text": self.text}


class LatinaVoiceEngine:
    """VoxCPM2, loaded once and held in memory for the process's lifetime.

    Generation is synchronous and single-threaded on the GPU, so a lock
    serializes calls: two concurrent requests would otherwise interleave on the
    same CUDA context and both come out slower (or wrong).
    """

    def __init__(self) -> None:
        self.model = None
        self.sample_rate: int = 48000     # VoxCPM2's audiovae_v2 output rate
        self.voices: dict[str, Voice] = {}
        self.loaded_at: Optional[float] = None
        self._lock = threading.Lock()
        # Guards runtime re-scans only. Deliberately NOT `self._lock`: a rescan
        # must never queue behind a 10-second generation, nor delay one.
        self._voices_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    def scan_voices(self) -> dict[str, Voice]:
        d = Path(config.VOICES_DIR)
        if not d.is_dir():
            raise RuntimeError(f"voices directory not found: {d}")
        found = {w.stem: Voice(w) for w in sorted(d.glob("*.wav"))}
        if not found:
            raise RuntimeError(f"no .wav reference clips in {d}")
        return found

    def load(self) -> None:
        """Pull the model onto the GPU. Slow (seconds to minutes on first run,
        because the weights download); called once at startup."""
        from voxcpm import VoxCPM

        t0 = time.perf_counter()
        self.voices = self.scan_voices()
        print(f"[latina] loading {config.MODEL_ID} "
              f"(optimize={config.OPTIMIZE}, denoiser={config.LOAD_DENOISER})…",
              flush=True)
        self.model = VoxCPM.from_pretrained(
            config.MODEL_ID,
            load_denoiser=config.LOAD_DENOISER,
            optimize=config.OPTIMIZE,
        )
        self.loaded_at = time.time()
        print(f"[latina] ready in {time.perf_counter()-t0:.0f}s · "
              f"{self.sample_rate} Hz · voices: {list(self.voices)}", flush=True)

        if config.WARMUP:
            t = time.perf_counter()
            try:
                self.synthesize("Hola, buenas tardes.")
                print(f"[latina] warmed up in {time.perf_counter()-t:.1f}s", flush=True)
            except Exception as e:                      # non-fatal
                print(f"[latina] warmup failed ({type(e).__name__}: {e})", flush=True)

    def rescan_voices(self) -> dict[str, Voice]:
        """Pick up voices added or removed since startup.

        Unlike `scan_voices()` this never raises and never empties the registry
        — those are the two ways a refresh could take down a live service. The
        new dict is built first and then rebound in one statement, so a
        concurrent `/voices` handler iterates a consistent snapshot instead of
        hitting "dictionary changed size during iteration".
        """
        with self._voices_lock:
            d = Path(config.VOICES_DIR)
            if not d.is_dir():
                return self.voices
            try:
                found = {w.stem: Voice(w) for w in sorted(d.glob("*.wav"))}
            except OSError:
                return self.voices
            if not found:
                return self.voices          # keep the last good set
            self.voices = found             # single rebind = atomic swap
            return self.voices

    @property
    def is_ready(self) -> bool:
        return self.model is not None

    def resolve(self, voice_id: Optional[str]) -> Voice:
        v = self.voices.get(voice_id or config.DEFAULT_VOICE)
        if v is None:
            raise KeyError(
                f"unknown voice {voice_id!r}; available: {sorted(self.voices)}")
        return v

    # ------------------------------------------------------------------ #
    def synthesize(self, text: str, voice: Optional[str] = None,
                   language: Optional[str] = None) -> np.ndarray:
        """Whole utterance as mono float32 at `self.sample_rate`."""
        if not self.is_ready:
            raise RuntimeError("engine not loaded")
        v = self.resolve(voice)
        with self._lock:
            audio = self.model.generate(
                text=text,
                reference_wav_path=str(v.wav),
                normalize=False,
                denoise=False,
                cfg_value=config.CFG_VALUE,
                inference_timesteps=config.INFERENCE_TIMESTEPS,
                retry_badcase=config.RETRY_BADCASE,
            )
        return np.asarray(audio, dtype=np.float32).squeeze()

    def synthesize_streaming(
        self, text: str, voice: Optional[str] = None,
        language: Optional[str] = None,
    ) -> Generator[np.ndarray, None, None]:
        """Chunks as they are produced, so the caller can start playing before
        the whole utterance exists. This is the path a phone call wants."""
        if not self.is_ready:
            raise RuntimeError("engine not loaded")
        v = self.resolve(voice)
        with self._lock:
            for chunk in self.model.generate_streaming(
                text=text,
                reference_wav_path=str(v.wav),
                normalize=False,
                denoise=False,
                cfg_value=config.CFG_VALUE,
                inference_timesteps=config.INFERENCE_TIMESTEPS,
                # A retry would discard chunks already streamed to the caller,
                # so it is doubly wrong on this path.
                retry_badcase=config.RETRY_BADCASE,
            ):
                yield np.asarray(chunk, dtype=np.float32).squeeze()


# One engine per process.
engine = LatinaVoiceEngine()


# --------------------------------------------------------------------------- #
# Audio helpers
# --------------------------------------------------------------------------- #
def to_pcm16(audio: np.ndarray) -> bytes:
    """float32 [-1,1] → little-endian int16, which is what browsers and
    telephony stacks actually want to receive."""
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def to_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    """Minimal 16-bit mono WAV. Avoids a soundfile/libsndfile dependency just
    to write a 44-byte header."""
    import struct
    pcm = to_pcm16(audio)
    n = len(pcm)
    return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVE" + b"fmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
            + b"data" + struct.pack("<I", n) + pcm)
