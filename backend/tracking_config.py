CHECKPOINTS = [
    {
        "id":            "barcode_date",
        "label":         "Tracking Paquet+Barcode+Date",
        "path":          "yolo26m_BB_barcode_date.engine",
        "task": "detect" # required for TensorRT
        "mode":          "tracking",
        "package_class": "package",
        "barcode_class": "barcode",
        "date_class":    "date",
        "require_date_for_ok": True,
        # Exit line defaults for this checkpoint (vertical line at 85%, near the left, inverted)
        "exit_line_pct": 85,
        "exit_line_vertical": True,
        "exit_line_inverted": True,
        # Secondary model for maximum date-detection accuracy.
        # Runs in parallel on each frame; its date detections are used
        # for OK/NOK validation alongside barcodes from the primary model.
        "secondary_date_model_path": "yolo26m_BB_date.engine",
        "secondary_date_class":      "date",
    },
    {
        "id":            "anomaly",
        "label":         "Segmentation + Anomaly Detection",
        "path":          "yolo26m_seg_farine_FV_v3.engine",
        "task": "segment" # refers to YOLO segmentation part since task is required for TensorRT            
        "mode":          "anomaly",
        "package_class": "farine",
        "barcode_class": None,
        # YOLO overrides for segmentation quality
        "yolo_imgsz":    960,
        "yolo_conf":     0.5,
        # EfficientAD model paths
        "ad_teacher":    "teacher_best.pth",
        "ad_student":    "student_best.pth",
        "ad_autoencoder": "autoencoder_best.pth",
        # Anomaly detection parameters
        "ad_thresh":     5000.0,
        "ad_imgsz":      256,
        "ad_strategy":   "MAJORITY",
        "ad_margin_pct": 0.1,
        "ad_erosion_size": 3,
        "ad_max_scans":  7,
        # Zone: start/end scanning as % of frame width
        # Packets flow RIGHT → LEFT:
        #   zone_end_pct   = ENTRY line (right side, where scanning begins)
        #   zone_start_pct = EXIT  line (left side, decision is locked & queued)
        "zone_start_pct": 0.20,
        "zone_end_pct":   0.72,
    },
]

# Active checkpoint at startup (must match one of the ids above)
DEFAULT_CHECKPOINT_ID = "barcode_date"

# ==========================
# CAMERAS  (add your camera sources here)
# ==========================
CAMERAS = [
    {"id": "cam0", "label": "Camera 0 (Barcode/Date)",  "source": 0},
    {"id": "cam2", "label": "Camera 2 (Anomaly)",       "source": 2},
]

DEFAULT_CAMERA_ID = "cam0"

# ==========================
# PIPELINES  (each pipeline = one camera + one checkpoint running in parallel)
# ==========================
PIPELINES = [
    {"id": "pipeline_barcode_date", "label": "Barcode + Date Tracking", "camera_source": "/app/videos/V1_comp.mp4", "checkpoint_id": "barcode_date"},
    # Anomaly camera uses lower capture resolution to reduce USB 2.0 bandwidth.
    # Both cameras share Bus 001 (480 Mbps). At 1920x1080 complex scenes push
    # MJPEG frames to 200-400KB each → bus congestion → FPS drops.
    # EfficientAD runs at 256px internally so 1280x720 capture loses nothing.
    {"id": "pipeline_anomaly",      "label": "Anomaly Detection",       "camera_source": "/app/videos/testAnomalie-Trim3.mp4", "checkpoint_id": "anomaly",
     "camera_width": 1280, "camera_height": 720},
]

DEFAULT_VIEW_PIPELINE = "pipeline_barcode_date"

# ==========================
# HELPER LOOKUPS
# ==========================
def get_checkpoint(checkpoint_id):
    for cp in CHECKPOINTS:
        if cp["id"] == checkpoint_id:
            return cp
    return None

def get_camera(camera_id):
    for cam in CAMERAS:
        if cam["id"] == camera_id:
            return cam
    return None

DEVICE = 'cuda'  
# ==========================
# DETECTION & TRACKING
# ==========================
CONFIG = {
    "conf_paquet": 0.45,       
    "conf_barcode": 0.45,
    "conf_date": 0.30,
    "imgsz": 640,  
    "barcode_match_iou_min": 0.01,
    "date_match_iou_min": 0.01,
    "barcode_match_inside_min": 0.60,
    "date_match_inside_min": 0.60,
    "exit_line_ratio": 0.15,
    "exit_line_proximity": 50,
}

# ==========================
# CAMERA DEFAULTS
# ==========================
CAMERA_FPS = 30
CAMERA_WIDTH = 1280
CAMERA_HEIGHT = 720

# ==========================
# COMPOSITOR
# ==========================
JPEG_QUALITY = 60

# Stream resolution: frames are downscaled to this size AFTER drawing
# overlays, before JPEG encoding. YOLO/detection still runs at full
# CAMERA_WIDTH x CAMERA_HEIGHT for maximum accuracy.
# Set to CAMERA_WIDTH/HEIGHT to stream at full resolution.
STREAM_WIDTH = 1280
STREAM_HEIGHT = 720

# ==========================
# SERVER
# ==========================
SERVER_HOST = '0.0.0.0'
SERVER_PORT = 5000

# ==========================
DETECTOR_FRAME_SKIP = 1

#(segmentation + EfficientAD),
ANOMALY_FRAME_SKIP = 1

 
# ==========================
# BYTETRACK TRACKER (built-in Ultralytics)
# ==========================
TRACKER_CONFIG = {
    "tracker_type": "bytetrack",
    "track_high_thresh": 0.5,
    "track_low_thresh": 0.45,
    "new_track_thresh": 0.6,
    "track_buffer": 60,
    "match_thresh": 0.8,
    "fuse_score": True,
}

