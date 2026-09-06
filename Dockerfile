# Latina Voice TTS — VoxCPM2 serving a Latin-American Spanish voice.
#
# Build:  docker build -t latina-voice .
# Run:    docker run --gpus all -p 8000:8000 latina-voice
# RunPod: push this image, set the container start command to
#           python handler.py      (serverless worker)
#         or leave the default     (HTTP service on :8000)
#
# Base image carries CUDA 12.4 torch. If your host is CUDA 13, switch the base
# to a cu130 image — VoxCPM2 itself does not care, torch does.
FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /app

# System deps: VoxCPM2 pulls audio libraries that want libsndfile + ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt runpod

# Reference clips are part of the image — the voice ships with the service.
COPY voices/ ./voices/
COPY latina/ ./latina/
COPY static/ ./static/
COPY server.py handler.py ./

# Bake the weights into the image so cold start is load-only, not download.
# Comment this out to keep the image small and download on first boot instead.
RUN python -c "from voxcpm import VoxCPM; VoxCPM.from_pretrained('openbmb/VoxCPM2', load_denoiser=False, optimize=False)" \
    || echo "WARN: could not prefetch weights at build time; will download on first start"

ENV LATINA_HOST=0.0.0.0 \
    LATINA_PORT=8000 \
    LATINA_OPTIMIZE=0 \
    PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["python", "server.py"]
