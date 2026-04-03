# GMCB Detection System

Real-time quality control system for flour packaging lines — barcode/date detection and anomaly detection powered by YOLO and EfficientAD.

## Services

| Service    | Description                              | Port |
|------------|------------------------------------------|------|
| `db`       | PostgreSQL 16                            | 5434 |
| `backend`  | Flask + YOLO + EfficientAD inference     | 5000 |
| `frontend` | React/Vite dashboard (nginx)             | 80   |

## Quick Start

### 1. Requirements

- Docker + Docker Compose v2
- NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

### 2. Configure

```bash
cp .env.example .env
# Edit .env — set DB_PASSWORD and JWT_SECRET
```

### 3. Add model weights

Download model files and place them in `backend/`:

| File                         | Size  | Description             |
|------------------------------|-------|-------------------------|
| `yolo26m_BB_barcode_date.pt` | 126 MB | Barcode/date detection  |
| `yolo26m_seg_farine_FV.pt`   | 52 MB  | Segmentation model      |
| `yolo26-BB(date).pt`         | 42 MB  | BB date model           |
| `student_best.pth`           | 45 MB  | EfficientAD student     |
| `teacher_best.pth`           | 31 MB  | EfficientAD teacher     |
| `autoencoder_best.pth`       | 4 MB   | EfficientAD autoencoder |

> Model weights are not tracked in git (too large). Store them in shared storage alongside the project.

### 4. Run

```bash
docker compose up --build
```

Dashboard opens at `http://localhost` (port 80).

## Development

### Backend (Python/Flask)

```bash
cd backend
pyenv activate demo_detection_env   # or your venv
python app.py
```

### Frontend (React/Vite)

```bash
cd frontend
cp .env.example .env
# Set VITE_BACKEND_HOST=http://localhost:5000
npm install
npm run dev
```

## Architecture

See [ARCHITECTURE_REPORT.md](ARCHITECTURE_REPORT.md) for a detailed breakdown of pipelines, scheduling, and session management.

## Camera setup

Edit `backend/tracking_config.py`:

- `_VIDEO_BARCODE` / `_VIDEO_ANOMALY` — set to a video file path for testing
- Change `camera_source` back to `0` / `2` for live USB cameras
