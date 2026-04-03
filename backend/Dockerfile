FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# System dependencies (OpenCV, V4L2 camera access, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    libgl1-mesa-glx libglib2.0-0 libsm6 libxext6 libxrender1 \
    v4l-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PyTorch with CUDA 12.8 (must be installed BEFORE requirements.txt
# to avoid pip replacing with CPU-only version from PyPI)
RUN pip3 install --no-cache-dir \
    torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cu128

# Remaining Python dependencies (skip torch/torchvision/torchaudio
# since they are already installed with CUDA above)
COPY requirements.txt .
RUN grep -viE '^(torch|torchvision|torchaudio)$' requirements.txt > _reqs.txt \
    && pip3 install --no-cache-dir -r _reqs.txt \
    && rm _reqs.txt

COPY . .

EXPOSE 5000

CMD ["python3", "app.py"]
