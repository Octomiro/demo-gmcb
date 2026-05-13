FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    --network=host \
    apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libturbojpeg0 \
    v4l-utils

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    --network=host \
    pip install \
    --extra-index-url https://download.pytorch.org/whl/cu132 \
    -r requirements.txt

COPY . .
# Remove any pre-compiled python bytecode to prevent "bad marshal data" issues
RUN find /usr/local/lib/python3.11/site-packages -name "*.pyc" -delete

EXPOSE 5000

CMD ["python", "app.py"]