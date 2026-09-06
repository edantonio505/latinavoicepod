#!/usr/bin/env bash
# Start the service. Safe to run repeatedly — it only does setup work once.
#
# Designed for a bare GPU box (a fresh RunPod pod included): it installs the
# system packages, builds the venv, picks the torch wheel matching the host
# CUDA, installs the rest, and serves.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PY:-python3}"
say() { echo "[start] $*"; }
die() { echo "[start] ERROR: $*" >&2; exit 1; }

# --------------------------------------------------------------------------- #
# 0. Preflight — the things that make a bare image fail with cryptic errors
# --------------------------------------------------------------------------- #
IS_ROOT=0; [[ "$(id -u)" == "0" ]] && IS_ROOT=1
APT=""; command -v apt-get >/dev/null 2>&1 && APT=1

need_apt=()      # hard blockers: warn about these
opt_apt=()       # nice to have: install when free (root), never warn

# libsndfile: soundfile dlopen()s it, but current wheels bundle their own copy,
# so a missing system lib is usually harmless. Install it when we are root
# (costs nothing, removes a whole class of minimal-image failure) and stay
# quiet otherwise — the post-install import check below is what actually
# proves it works, and it fails loudly if it does not.
ldconfig -p 2>/dev/null | grep -q libsndfile || opt_apt+=(libsndfile1)
command -v ffmpeg >/dev/null 2>&1 || opt_apt+=(ffmpeg)
# python3-venv: without it `python3 -m venv` dies with "ensurepip is not
# available", which reads like a Python bug and is not one.
"$PY" -c "import ensurepip" >/dev/null 2>&1 || need_apt+=(python3-venv)

all_apt=("${need_apt[@]}" "${opt_apt[@]}")
if ((${#all_apt[@]})); then
  if [[ $IS_ROOT == 1 && -n "$APT" ]]; then
    say "installing system packages: ${all_apt[*]}"
    apt-get update -qq && apt-get install -y -qq --no-install-recommends "${all_apt[@]}" || \
      say "WARNING: apt install failed; continuing (deps may already be bundled)"
  elif ((${#need_apt[@]})); then
    say "WARNING: missing system packages: ${need_apt[*]}"
    say "         install them, or run this as root:"
    say "         sudo apt-get install -y ${need_apt[*]}"
  fi
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
  say "WARNING: no nvidia-smi — no GPU visible."
  say "         It will run on CPU at roughly RTF 10, i.e. unusable for calls."
fi

# --------------------------------------------------------------------------- #
# 1. venv + dependencies (first run only)
# --------------------------------------------------------------------------- #
if [[ ! -x .venv/bin/python ]]; then
  say "creating .venv"
  "$PY" -m venv .venv || die "could not create the venv — install python3-venv"
  .venv/bin/pip install -q --upgrade pip

  # Torch must match the host CUDA; the plain PyPI wheel is CPU-only on ARM.
  # TORCH_INDEX overrides everything if you know better.
  IDX="${TORCH_INDEX:-}"
  if [[ -z "$IDX" ]] && command -v nvidia-smi >/dev/null 2>&1; then
    CUDA_MAJOR="$(nvidia-smi 2>/dev/null | grep -oP 'CUDA Version: \K[0-9]+' | head -1 || true)"
    case "$CUDA_MAJOR" in
      13) IDX="https://download.pytorch.org/whl/cu130" ;;
      12) IDX="https://download.pytorch.org/whl/cu124" ;;
      *)  IDX="https://download.pytorch.org/whl/cu124" ;;
    esac
  fi
  if [[ -n "$IDX" ]]; then
    say "installing torch from $IDX (this is the slow part, ~2-3 GB)"
    .venv/bin/pip install -q torch torchaudio --index-url "$IDX" \
      || die "torch install failed — try TORCH_INDEX=<url> ./start.sh"
  else
    say "installing CPU torch (no GPU detected)"
    .venv/bin/pip install -q torch torchaudio
  fi

  say "installing the rest"
  .venv/bin/pip install -q -r requirements.txt

  # Fail here rather than 40 s into the model load.
  .venv/bin/python - <<'PYCHECK' || die "dependency check failed"
import torch, voxcpm  # noqa: F401
print(f"[start] torch {torch.__version__} · cuda available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"[start] gpu: {torch.cuda.get_device_name(0)}")
PYCHECK
fi

# `make setup` wants the venv built, not the service running.
if [[ "${1:-}" == "--setup-only" ]]; then
  say "setup complete — run ./start.sh to serve"
  exit 0
fi

[[ -f .env ]] && { set -a; . ./.env; set +a; }

say "serving on ${LATINA_HOST:-0.0.0.0}:${LATINA_PORT:-8000}"
say "first run downloads ~5 GB of weights; ready when you see 'warmed up'"
exec .venv/bin/python server.py
