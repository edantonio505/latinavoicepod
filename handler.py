"""RunPod serverless entry point.

Two ways to run this project:

  * As a normal HTTP service — `./start.sh`, then POST /speak. Use this on a
    RunPod *pod*, on any GPU box, or locally.
  * As a RunPod *serverless* worker — this file. RunPod calls `handler(job)`
    and streams whatever it yields back to the caller.

The model loads at import, i.e. during cold start, so the first job does not
pay for it. Keep at least one worker warm if you care about latency: a cold
start is model download + load, not milliseconds.

Job input:
    {"input": {"text": "...", "voice": "es_f_19"}}

Yields:
    {"audio_chunk": "<base64 int16 PCM>", "sample_rate": 48000, "chunk": 1}
    ...
    {"done": true, "chunks": 7, "ms": 3120}
"""

from __future__ import annotations

import base64
import time

import runpod

from latina.engine import engine, to_pcm16

# Cold start: pay for the load here, once per worker.
engine.load()


def handler(job):
    inp = (job or {}).get("input") or {}
    text = (inp.get("text") or "").strip()
    if not text:
        yield {"error": "input.text is required"}
        return

    voice = inp.get("voice")
    try:
        engine.resolve(voice)
    except KeyError as e:
        yield {"error": str(e)}
        return

    t0 = time.perf_counter()
    n = 0
    try:
        for chunk in engine.synthesize_streaming(text, voice, inp.get("language")):
            n += 1
            yield {
                "audio_chunk": base64.b64encode(to_pcm16(chunk)).decode("ascii"),
                "sample_rate": engine.sample_rate,
                "chunk": n,
            }
    except Exception as e:
        yield {"error": f"{type(e).__name__}: {e}"}
        return
    yield {"done": True, "chunks": n,
           "ms": round((time.perf_counter() - t0) * 1000)}


runpod.serverless.start({"handler": handler, "return_aggregate_stream": True})
