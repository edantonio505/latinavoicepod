# Troubleshooting

Ordered by how often each one actually happens.

## Quick table

| Symptom | Cause | Fix |
|---|---|---|
| Startup never prints `ready`, GPU busy | `torch.compile` on an unsupported GPU | `LATINA_OPTIMIZE=0` (the default) |
| `first audio == total` in the smoke test | streaming buffered — by code or by a proxy | direct TCP port on RunPod; locally see [architecture](architecture.md#streaming-is-the-fragile-part) |
| HTTP 503 on `/speak` | model still loading | poll `/health` for `"ok":true` |
| A request never returns, GPU pinned | bad reference clip → open-ended generation | use a clean 4–15 s single-speaker clip |
| `Address already in use`, exit 3 | an old instance holds the port | `make stop` |
| Import error on torch / CUDA mismatch | wrong wheel for the host CUDA | `rm -rf .venv && TORCH_INDEX=… ./start.sh` |
| No `/studio/` page, service otherwise fine | studio import failed | `.venv/bin/pip install python-multipart` |
| Voice sounds muffled | telephone-band reference clip | check `/api/voices/<id>/analysis` |
| Brand names pronounced in Spanish | deliberate omission | [see below](#english-brand-names-sound-spanish) |

---

## It never finishes loading

The service prints `loading openbmb/VoxCPM2 …` and then nothing, while the GPU
sits busy.

Look for `Not enough SMs to use max_autotune_gemm` in the log. That is
`torch.compile` failing to make progress — on a GB10 / DGX Spark the warmup
compiles forever and the service never becomes ready.

```bash
LATINA_OPTIMIZE=0 ./start.sh
```

`0` is already the default, so this means something set it to `1`: check `.env`.
On an A100, L40S, 4090 or A6000 the flag is usually a real speedup — measured
RTF 0.76 → 0.65 on an A6000, at about 70 s of extra startup — but always
confirm the first request returns before leaving it on.

If it is *not* compiling, it is probably still downloading. First start pulls
~5 GB of weights; give it 5–15 minutes.

## first audio == total

The streaming endpoint has stopped streaming. Nothing errors — this is the
silent failure the project's design notes keep warning about.

**On RunPod**, the HTTP proxy buffers SSE. Confirm by running the smoke test
against the pod's direct TCP address instead of the proxy URL. See
[deployment](deployment.md#the-runpod-http-proxy-buffers-sse).

**Locally**, someone changed `speak()` in `latina/api.py`. Two obvious rewrites
both break it in exactly this way: draining the generator with `list(...)`
inside `asyncio.to_thread`, and bridging onto a bounded `asyncio.Queue` via
`run_coroutine_threadsafe`. The working pattern is a thread writing to a plain
`queue.Queue`, consumed with `await asyncio.to_thread(q.get)`.

Any other proxy in front of the service can do the same thing. The response
already sets `X-Accel-Buffering: no` and `Cache-Control: no-cache`; not every
proxy honours it.

## HTTP 503 `{"error": "model still loading"}`

Working as intended. The model loads in a background thread so the socket
answers immediately; `/speak` refuses until it is in memory.

Poll `/health` until `"ok":true` — never grep the log for `warmed up`, which is
printed before uvicorn accepts connections.

## A request never returns and the GPU stays busy

VoxCPM2 generation is open-ended. A noisy, telephone-band or badly transcribed
reference clip can send it into a loop that does not terminate, and it keeps
consuming the GPU, slowing every later request.

Check the clip:

```bash
curl -s localhost:8000/api/voices/<id>/analysis | head -40
```

Then replace it with a clean, 4–15 second, single-speaker recording, and make
sure `<id>.txt` says what the clip actually says.

**A timeout does not fix this.** `asyncio.wait_for` around `asyncio.to_thread`
stops *waiting* but cannot cancel the thread — the runaway generation keeps
running. The real fix is a generation cap inside the engine, or a subprocess you
can kill. Neither is implemented.

## Address already in use

```bash
make stop
```

or by hand:

```bash
kill -9 $(ss -ltnp | grep ':8000' | grep -oP 'pid=\K[0-9]+')
```

Matching on a process-name pattern usually misses it, because the command line
is just `server.py`.

## torch / CUDA import errors

The venv has a wheel that does not match the host.

```bash
rm -rf .venv
TORCH_INDEX=https://download.pytorch.org/whl/cu124 ./start.sh   # or cu130
```

`start.sh` picks the index from `nvidia-smi`'s reported CUDA version and falls
back to `cu124`. On ARM hosts note that the plain PyPI wheel is CPU-only.

## The studio is missing

The service logs one line and keeps serving `/speak` normally:

```
[latina] voice studio disabled: RuntimeError: Form data requires "python-multipart"…
```

That guard is why a missing dependency disables the GUI instead of killing the
TTS service. The usual cause on an existing box is `python-multipart` not being
installed, because `start.sh` only pip-installs when `.venv` is absent:

```bash
.venv/bin/pip install python-multipart
```

Other causes the same line will name: `static/` missing (check
`LATINA_STUDIO_STATIC`), or `LATINA_STUDIO=0`.

## No record button in the studio

`getUserMedia` requires a secure context. Over plain `http://<remote-ip>:8000`
the browser withholds the microphone. Use `localhost`, real HTTPS, or an SSH
tunnel — see [deployment](deployment.md#reaching-the-studio-through-a-proxy).

## The voice sounds muffled

Almost always the reference clip, not the settings. VoxCPM2 reads only
**0–8 kHz** from a reference and can reproduce only what is in there.

```bash
curl -s localhost:8000/api/voices/<id>/analysis
```

A `rolloff_99_hz` below 3500 means telephone-band input; the clone will be
muffled no matter what you do downstream. **Re-saving the clip at a higher
sample rate changes nothing** — there is no detail to recover. Record with a
real microphone. See [voices](voices.md#why-bandwidth-not-sample-rate).

The shipped `es_f_19` is itself telephone-band and graded `poor` on purpose.

## Speech stutters during playback

RTF above 1.0: the player drains audio faster than the service produces it.

Check the smoke test's RTF column. If it is above 1, either use the fast preset
(`LATINA_CFG=2.0`, `LATINA_TIMESTEPS=10`), enable `LATINA_OPTIMIZE=1` if your
GPU supports it, or split long replies into sentences and issue one request per
sentence.

Note that a "quality" preset which pushes RTF past 1.0 makes the voice *worse*,
not better.

## No GPU

`start.sh` warns and installs CPU torch rather than failing. It will run at
roughly RTF 10 — unusable for calls. Do not benchmark on CPU and report the
result as this project's performance.

## English brand names sound Spanish

Deliberate. The dealership pipeline this voice came from wrapped English brand
names in quotes so VoxCPM2 would pronounce "Honda Civic" in English inside a
Spanish sentence, driven by a vehicle database and a dealership vocabulary file.
That is intentionally absent — re-adding it means porting `vehicle_db.py` and
its data files, which makes the project domain-specific again.

As a one-off you can quote the brand yourself in the `text` you send.
