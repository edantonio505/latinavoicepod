# Documentation

Reference documentation for Latina Voice TTS. Start with the
[project README](../README.md) if you just want it running.

| Document | Read it when |
|---|---|
| [api.md](api.md) | You are calling the service — every endpoint, the SSE frame shapes, auth, status codes, and the wire protocol that must not change. |
| [configuration.md](configuration.md) | You are tuning it — every environment variable, its default, and the measurement behind that default. |
| [voices.md](voices.md) | You are adding or debugging a voice — what makes a good reference clip, what the quality analyser measures, and why bandwidth beats sample rate. |
| [deployment.md](deployment.md) | You are putting it somewhere — local, Docker, RunPod pod, RunPod serverless, and registering with miniclosedai. |
| [architecture.md](architecture.md) | You are changing it — how the pieces fit, why streaming is written the way it is, and what is deliberately absent. |
| [troubleshooting.md](troubleshooting.md) | Something is wrong — symptoms, causes, fixes. |
| [development.md](development.md) | You are contributing — layout, testing, and the rules that have already cost someone a debugging round. |

## Also in the repo

- **[AGENTS.md](../AGENTS.md)** — the step-by-step operational runbook, with the
  expected output at each step.
- **[CLAUDE.md](../CLAUDE.md)** — design notes and reasoning, written for AI
  coding agents working in this repository.
- **[.env.example](../.env.example)** — the annotated settings template.

## The short version

VoxCPM2 is loaded once into GPU memory by a single-worker FastAPI process and
serves a Latin-American Spanish voice. Audio streams out as it is generated —
**time to first chunk is the number that matters**, not total time, because a
caller starts playing before the sentence is finished.

Three facts explain most of the surprising code:

1. **Output is 48 kHz**, but the model reads references at **16 kHz**, so clone
   quality is decided by how much of 0–8 kHz a reference clip actually fills.
2. **Streaming fails silently.** When it breaks, nothing errors — first audio
   just becomes equal to total time.
3. **Two external consumers depend on exact wire shapes**, and both hang rather
   than error when those shapes change.
