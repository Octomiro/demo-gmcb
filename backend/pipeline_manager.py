import threading

import numpy as np
from ultralytics import YOLO

from tracking_config import (
    CONFIG, DEVICE, PIPELINES, DEFAULT_VIEW_PIPELINE,
    CHECKPOINTS, get_checkpoint,
)
from detection import TrackingState
from db_writer import DBWriter


# ── Shared DB writer (one instance, used by all pipelines) ──
db_writer = DBWriter()

# ── Pipeline dict: pipeline_id → TrackingState ──
pipelines: dict = {}

# ── Which pipeline serves /video_feed ──
active_view_id: str = DEFAULT_VIEW_PIPELINE

# ── Per-pipeline checkpoint tracking ──
pipeline_checkpoint_ids: dict = {}   # pipeline_id → checkpoint_id

# ── Active-session guard ──
_active_session_source = None    # "shift" | "manual" | None
_active_session_group = None     # shared group_id
_active_session_shift_id = None  # owning shift_id if source is "shift"
_session_lock = threading.Lock()


def _view_state() -> TrackingState:
    """Return the TrackingState currently selected for live viewing."""
    return pipelines.get(active_view_id)


def _all_states():
    """Yield all (pipeline_id, TrackingState) tuples."""
    return pipelines.items()


# ── Model init (per pipeline) ──

def init_pipeline(pipe_cfg):
    """Create a TrackingState for one pipeline config and load its model."""
    pid = pipe_cfg["id"]
    cp_id = pipe_cfg["checkpoint_id"]
    checkpoint = get_checkpoint(cp_id)
    if checkpoint is None:
        raise ValueError(f"Unknown checkpoint id: {cp_id} for pipeline {pid}")

    state = TrackingState(pipeline_id=pid, db_writer=db_writer)

    print(f"[{pid}] Loading model: {checkpoint['label']} ({checkpoint['path']})...")
    state.model = YOLO(checkpoint["path"])
    state.model.to(DEVICE)
    names = state.model.names

    pkg_cls = checkpoint.get("package_class")
    bar_cls = checkpoint.get("barcode_class")
    date_cls = checkpoint.get("date_class")
    state.package_id = next((k for k, v in names.items() if v == pkg_cls), None) if pkg_cls else None
    state.barcode_id = next((k for k, v in names.items() if v == bar_cls), None) if bar_cls else None
    state.date_id = next((k for k, v in names.items() if v == date_cls), None) if date_cls else None
    state.mode = checkpoint.get("mode", "tracking")
    state.current_checkpoint = checkpoint
    print(f"[{pid}] Model loaded on {DEVICE}. mode={state.mode} "
          f"package={state.package_id} barcode={state.barcode_id} date={state.date_id}")

    # Load secondary date model when configured on tracking checkpoints
    sec_path = checkpoint.get("secondary_date_model_path")
    sec_cls = checkpoint.get("secondary_date_class")
    if sec_path and state.mode == "tracking":
        try:
            state.secondary_model = YOLO(sec_path)
            state.secondary_model.to(DEVICE)
            sec_names = state.secondary_model.names
            state._secondary_date_id = next(
                (k for k, v in sec_names.items() if v == sec_cls), None
            ) if sec_cls else None
            state._use_secondary_date = state._secondary_date_id is not None
            print(f"[{pid}] Secondary date model loaded: id={state._secondary_date_id}")
        except Exception as e:
            state.secondary_model = None
            state._secondary_date_id = None
            state._use_secondary_date = False
            print(f"[{pid}] Secondary date model load failed (non-fatal): {e}")
    else:
        state.secondary_model = None
        state._secondary_date_id = None
        state._use_secondary_date = False

    # If anomaly mode, load EfficientAD models
    if state.mode == "anomaly":
        try:
            state._load_ad_models(checkpoint, DEVICE)
        except Exception as e:
            print(f"[{pid}][AD] _load_ad_models failed: {e}")

    print(f"[{pid}] Warming up YOLO (dummy inference)...")
    dummy = np.zeros((640, 640, 3), dtype=np.uint8)
    try:
        state.model(dummy, imgsz=CONFIG["imgsz"], verbose=False)
        import torch
        if DEVICE == 'cuda':
            torch.cuda.empty_cache()
        print(f"[{pid}] YOLO warmup complete.")
    except Exception as e:
        print(f"[{pid}] YOLO warmup failed (non-fatal): {e}")

    pipelines[pid] = state
    pipeline_checkpoint_ids[pid] = cp_id
    return state


def init_all_pipelines():
    """Initialize all configured pipelines. Called once at startup."""
    for pipe_cfg in PIPELINES:
        init_pipeline(pipe_cfg)
    print(f"[INIT] {len(pipelines)} pipeline(s) initialized")
