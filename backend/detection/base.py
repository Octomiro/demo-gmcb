import os
import time
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

from db_writer import DBWriter, SNAPSHOT_EVERY_N_PACKETS
from helpers import calculate_bbox_metrics, letterbox_image, LIVE_IMAGES_ROOT
from tracking_config import (
    CONFIG, JPEG_QUALITY,
    CAMERA_FPS, CAMERA_WIDTH, CAMERA_HEIGHT,
    DETECTOR_FRAME_SKIP, ANOMALY_FRAME_SKIP,
    TRACKER_CONFIG,
)

from detection.anomaly import AnomalyMixin
from detection.tracker import TrackerMixin
from detection.reader import ReaderMixin
from detection.compositor import CompositorMixin


# ── Per-module singletons ──

def _write_tracker_yaml():
    """Write TRACKER_CONFIG dict to a temp YAML file (Ultralytics needs a file path)."""
    import tempfile
    content = "\n".join(f"{k}: {v}" for k, v in TRACKER_CONFIG.items())
    fd, path = tempfile.mkstemp(suffix=".yaml", prefix="bytetrack_")
    with os.fdopen(fd, "w") as f:
        f.write(content + "\n")
    return path


TRACKER_YAML_PATH = _write_tracker_yaml()

# Bounded thread pools shared across all pipelines
_secondary_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="SecModel")
_proof_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ProofSave")


class TrackingState(AnomalyMixin, TrackerMixin, ReaderMixin, CompositorMixin):
    """
    Three independent threads:
      - Reader:     captures frames at native FPS (smooth video, no YOLO dependency)
      - Detector:   runs YOLO + ByteTrack on latest frame, updates overlay & stats
      - Compositor: composites raw frame + overlay, pre-encodes JPEG

    The video feed yields pre-encoded bytes — zero computation in Flask.
    """

    def __init__(self, pipeline_id=None, db_writer=None):
        self.pipeline_id = pipeline_id
        self.model = None
        self.package_id = None
        self.barcode_id = None
        self.date_id = None

        # Secondary date-detection model (loaded when checkpoint has
        # "secondary_date_model_path"). Runs in parallel for best accuracy.
        self.secondary_model = None
        self._secondary_date_id = None
        self._use_secondary_date = False

        # ── EfficientAD anomaly detection models (loaded for mode="anomaly") ──
        self._ad_teacher = None
        self._ad_student = None
        self._ad_autoencoder = None
        self._ad_mean = None
        self._ad_std = None
        self._ad_quantiles = None
        self._ad_transform = None
        self._ad_track_states = {}  # {track_id: {'results': [], 'decision': None}}

        # Active checkpoint info (set by switch_checkpoint / init_models)
        self.mode = "tracking"          # "tracking" or "anomaly"
        self.current_checkpoint = None  # the checkpoint dict from CHECKPOINTS

        # Session generation counter — prevents old reader threads from
        # clobbering is_running after a camera/checkpoint switch
        self._session_gen = 0

        self.video_source = None
        self.cap = None
        self.is_running = False

        # ── Raw frame from reader (always latest, always smooth) ──
        self._raw_frame = None
        self._raw_lock = threading.Lock()
        self._raw_changed = threading.Event()
        # Keep a short history so compositor can draw overlays on the exact
        # frame used by detector, preventing visual box shift on fast motion.
        self._raw_history = deque(maxlen=24)
        self._raw_history_lock = threading.Lock()

        # ── Frame offered to detector ──
        self._det_frame = None
        self._det_frame_idx = 0
        self._det_event = threading.Event()
        self._det_lock = threading.Lock()

        # ── Detection overlay data ──
        self._overlay = self._empty_overlay()
        self._overlay_lock = threading.Lock()

        # ── Pre-encoded JPEG bytes (produced by compositor thread) ──
        self._jpeg_bytes = None
        self._jpeg_bytes_low = None   # half-res, quality-40 for remote viewers
        self._jpeg_lock = threading.Lock()
        self._jpeg_seq = 0            # incremented each time compositor writes a new frame
        self._jpeg_event = threading.Event()  # signalled when a new JPEG is ready
        self._low_clients_count = 0   # number of ?low=1 MJPEG clients (drives lazy low-res encode)

        # ── Frame dimensions (set by reader, used by compositor for exit line) ──
        self._frame_width = 0
        self._frame_height = 0

        # ── Exit line Y position (set once by detector from first frame, never via overlay) ──
        self._exit_line_y = 0
        # ── Exit line enabled flag (can be toggled via API, survives sessions) ──
        self._exit_line_enabled = True
        # ── Exit line as % from leading edge (survives sessions & rotation changes) ──
        self._exit_line_pct = 85
        # ── Exit line orientation: False = horizontal (y), True = vertical (x) ──
        self._exit_line_vertical = False
        # ── Exit line direction inverted: % measured from opposite edge ──
        self._exit_line_inverted = False
        # ── Frame rotation steps (0,1,2,3 => 0°,90°,180°,270° CCW; survives sessions) ──
        self._rotation_steps = 0

        # ── Per-session tracking state ──
        self.frame_count = 0
        self.packages = {}
        self.total_packets = 0
        self.output_fifo = deque(maxlen=20)  # dashboard sparkline only
        self._ok_count = 0
        self._nok_count = 0
        self.packet_numbers = {}
        self.packets_crossed_line = set()

        # ── Stats for API ──
        self._stats_lock = threading.Lock()
        self.stats = self._empty_stats()
        self._perf_lock = threading.Lock()
        self._perf = self._empty_perf()

        # ── DB writer (fully async, never blocks detector/compositor) ──
        if db_writer is not None:
            self._db_writer = db_writer
        else:
            self._db_writer = DBWriter()
        self._db_writer_started = False
        self._db_session_id = None
        self._stats_active = False
        self._nok_no_barcode = 0
        self._nok_no_date = 0
        self._nok_anomaly = 0
        # Which validation checks are enforced for the current session.
        # barcode=False → missing barcode still counts as OK
        # date=False    → missing date still counts as OK (overrides require_date_for_ok)
        # anomaly=False → anomaly detections do not count as NOK
        self._enabled_checks = {"barcode": True, "date": True, "anomaly": True}
        # Baselines captured when stats recording starts, so session
        # totals reflect only the recording window.
        self._session_baseline_total = 0
        self._session_baseline_ok = 0

    # ─────────────────────────────────────────
    # STATIC HELPERS
    # ─────────────────────────────────────────

    @staticmethod
    def _empty_overlay():
        return {
            'track_boxes': [],
            'barcode_boxes': [],
            'date_boxes': [],
            'exit_line_y': 0,
            'total_packets': 0,
            'fifo_str': '(empty)',
            'det_fps': 0,
            'det_ms': 0,
            'frame_idx': 0,
        }

    @staticmethod
    def _empty_stats():
        return {
            "video_fps": 0,
            "det_fps": 0,
            "inference_ms": 0,
            "total_packets": 0,
            "packages_ok": 0,
            "packages_nok": 0,
            "rotation_deg": 0,
            "fifo_queue": [],
            "is_running": False,
            "camera_fourcc": "",
            "camera_width": 0,
            "camera_height": 0,
            "reader_fps": 0.0,
        }

    @staticmethod
    def _empty_perf():
        return {
            "detector_lag_frames": 0,
            "detector_last_frame_idx": 0,
            "detector_loop_ms": 0.0,
            "compositor_loop_ms": 0.0,
            "compositor_sync_hits": 0,
            "compositor_sync_misses": 0,
            "raw_history_len": 0,
        }

    @staticmethod
    def _rotate_frame_ccw(frame, steps):
        steps = steps % 4
        if steps == 1:
            return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
        if steps == 2:
            return cv2.rotate(frame, cv2.ROTATE_180)
        if steps == 3:
            return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        return frame

    @staticmethod
    def _compute_iou(box1, box2):
        """Compute IoU between two (x1,y1,x2,y2) boxes."""
        ix1 = max(box1[0], box2[0])
        iy1 = max(box1[1], box2[1])
        ix2 = min(box1[2], box2[2])
        iy2 = min(box1[3], box2[3])
        inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
        a1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
        a2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
        union = a1 + a2 - inter
        return inter / union if union > 0 else 0.0

    @staticmethod
    def _intersection_over_box(box, container):
        """Return the fraction of `box` area that lies inside `container`."""
        ix1 = max(box[0], container[0])
        iy1 = max(box[1], container[1])
        ix2 = min(box[2], container[2])
        iy2 = min(box[3], container[3])
        inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
        area = max(1, (box[2] - box[0]) * (box[3] - box[1]))
        return inter / area

    def _det_box_matches_package(self, det_box, pkg_box, kind):
        """Strict association for small inner detections like barcode/date."""
        cfg = CONFIG
        iou_min = cfg.get(f"{kind}_match_iou_min", 0.01)
        inside_min = cfg.get(f"{kind}_match_inside_min", 0.60)
        iou = self._compute_iou(det_box, pkg_box)
        inside = self._intersection_over_box(det_box, pkg_box)
        return iou >= iou_min and inside >= inside_min

    # ─────────────────────────────────────────
    # ROTATION / EXIT LINE
    # ─────────────────────────────────────────

    def cycle_rotation_ccw(self):
        self._rotation_steps = (self._rotation_steps + 1) % 4
        deg = self._rotation_steps * 90
        with self._stats_lock:
            self.stats["rotation_deg"] = deg
        self._recompute_exit_line_y()
        print(f"[ROTATE] Input rotation set to {deg}° CCW")
        return deg

    def _recompute_exit_line_y(self):
        """Recompute pixel exit line position from _exit_line_pct + displayed frame dims."""
        steps = self._rotation_steps % 4
        transposed = steps in (1, 3)
        if self._exit_line_vertical:
            ref = self._frame_height if transposed else self._frame_width
        else:
            ref = self._frame_width if transposed else self._frame_height
        if ref > 0:
            effective_pct = (100 - self._exit_line_pct) if self._exit_line_inverted else self._exit_line_pct
            self._exit_line_y = int(ref * effective_pct / 100)

    # ─────────────────────────────────────────
    # SESSION RESET
    # ─────────────────────────────────────────

    def _reset_session(self):
        self.packages = {}
        self.frame_count = 0
        self.total_packets = 0
        self.output_fifo = deque(maxlen=20)
        self._ok_count = 0
        self._nok_count = 0
        self.packet_numbers = {}
        self.packets_crossed_line = set()
        self._ad_track_states = {}
        self._raw_frame = None
        self._det_frame = None
        self._det_frame_idx = 0
        self._det_event.clear()
        self._raw_changed.clear()
        with self._raw_history_lock:
            self._raw_history.clear()
        self._exit_line_y = 0
        with self._jpeg_lock:
            self._jpeg_bytes = None
            self._jpeg_bytes_low = None
        with self._overlay_lock:
            self._overlay = self._empty_overlay()
        with self._stats_lock:
            self.stats = self._empty_stats()
            self.stats["rotation_deg"] = (self._rotation_steps % 4) * 90
        with self._perf_lock:
            self._perf = self._empty_perf()
        self._nok_no_barcode = 0
        self._nok_no_date = 0
        self._nok_anomaly = 0

    # ─────────────────────────────────────────
    # PROOF IMAGE SAVING
    # ─────────────────────────────────────────

    def _save_proof_image(self, pkt_num, defect_type, frame, bbox=None, session_id=None):
        """Save a proof image of a defective packet."""
        if not session_id:
            return
        base = LIVE_IMAGES_ROOT / session_id / defect_type
        try:
            os.makedirs(base, exist_ok=True)
        except OSError:
            return

        img = frame
        if bbox is not None:
            x1, y1, x2, y2 = bbox
            h, w = frame.shape[:2]
            bw, bh = x2 - x1, y2 - y1
            pad_x, pad_y = int(bw * 0.15), int(bh * 0.15)
            x1, y1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
            x2, y2 = min(w, x2 + pad_x), min(h, y2 + pad_y)
            if x2 > x1 and y2 > y1:
                img = frame[y1:y2, x1:x2]

        img_path = os.path.join(base, f"packet_{pkt_num}.webp")
        try:
            cv2.imwrite(img_path, img, [cv2.IMWRITE_WEBP_QUALITY, 85])
        except Exception as e:
            print(f"[PROOF] Failed to save {img_path}: {e}")

    def _save_proof_image_bg(self, pkt_num, defect_type, frame, bbox=None):
        """Fire-and-forget: save proof image via bounded thread pool."""
        if not self._stats_active or not self._db_session_id:
            return
        frame_copy = frame.copy()
        session_now = self._db_session_id
        _proof_executor.submit(
            self._save_proof_image,
            pkt_num, defect_type, frame_copy, bbox, session_now,
        )

    # ─────────────────────────────────────────
    # VALIDATION CHECK CONTROL
    # ─────────────────────────────────────────

    def set_enabled_checks(self, checks: dict):
        """Set which validation checks are enforced. Safe to call before start_processing."""
        self._enabled_checks = {
            "barcode": bool(checks.get("barcode", True)),
            "date":    bool(checks.get("date",    True)),
            "anomaly": bool(checks.get("anomaly", True)),
        }

    # ─────────────────────────────────────────
    # STATS RECORDING
    # ─────────────────────────────────────────

    def set_stats_recording(self, active, group_id="", shift_id="", end_reason=None):
        active = bool(active)
        if active == self._stats_active:
            return {"stats_active": self._stats_active, "session_id": self._db_session_id}

        if active:
            new_sid = None
            if self._db_writer:
                if not self._db_writer_started:
                    self._db_writer.start()
                    self._db_writer_started = True
                cp_id = (self.current_checkpoint or {}).get("id", "")
                cam_src = str(self.video_source or "")
                new_sid = self._db_writer.open_session(checkpoint_id=cp_id, camera_source=cam_src, group_id=group_id, shift_id=shift_id)
                self._db_writer.set_active(True)
            self._db_session_id = new_sid
            self._stats_active = True
            self._nok_no_barcode = 0
            self._nok_no_date = 0
            self._nok_anomaly = 0
            self.total_packets = 0
            self.output_fifo = deque(maxlen=20)
            self._ok_count = 0
            self._nok_count = 0
            self.packages = {}
            self.packet_numbers = {}
            self.packets_crossed_line = set()
            self._session_baseline_total = 0
            self._session_baseline_ok = 0
            with self._stats_lock:
                self.stats["total_packets"] = 0
                self.stats["packages_ok"] = 0
                self.stats["packages_nok"] = 0
                self.stats["fifo_queue"] = []
            return {"stats_active": True, "session_id": new_sid}

        if self._db_writer and self._db_session_id:
            self._db_writer.close_session(self._db_session_id, totals=self._db_totals(), end_reason=end_reason)
            self._db_writer.set_active(False)
        self._db_session_id = None
        self._stats_active = False
        return {"stats_active": False, "session_id": None}

    def _db_totals(self):
        return {
            "total": self.total_packets,
            "ok_count": self._ok_count,
            "nok_no_barcode": self._nok_no_barcode,
            "nok_no_date": self._nok_no_date,
            "nok_anomaly": self._nok_anomaly,
        }

    # ═══════════════════════════════════════════
    # PUBLIC API
    # ═══════════════════════════════════════════

    def start_processing(self, video_source):
        if self.is_running:
            return {"error": "Already processing"}

        self.video_source = video_source
        self._reset_session()

        # Reset built-in tracker state for fresh session
        if hasattr(self.model, 'predictor') and self.model.predictor is not None:
            self.model.predictor.trackers = []
            self.model.predictor = None

        self._session_gen += 1
        my_gen = self._session_gen
        self.is_running = True

        # Launch THREE parallel threads
        threading.Thread(target=self._reader_loop,     args=(my_gen,), daemon=True, name="VideoReader").start()
        threading.Thread(target=self._detection_loop,  daemon=True, name="YOLODetector").start()
        threading.Thread(target=self._compositor_loop, daemon=True, name="Compositor").start()

        return {"status": "started", "source": video_source, "mode": "live"}

    def stop_processing(self):
        self.is_running = False
        time.sleep(0.5)
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        import gc
        gc.collect()
        with self._stats_lock:
            self.stats["is_running"] = False
        return {"status": "stopped"}

    # ═══════════════════════════════════════════
    # CHECKPOINT SWITCHING
    # ═══════════════════════════════════════════

    def switch_checkpoint(self, checkpoint: dict):
        """Unload current model, load new checkpoint, restart if was running."""
        from ultralytics import YOLO
        import torch, gc

        was_running = self.is_running
        prev_source = self.video_source

        if was_running:
            print(f"[SWITCH] Stopping current processing...")
            self.stop_processing()

        # Unload model(s)
        if self.model is not None:
            print(f"[SWITCH] Unloading model from VRAM...")
            del self.model
            self.model = None
        if self.secondary_model is not None:
            print(f"[SWITCH] Unloading secondary date model from VRAM...")
            del self.secondary_model
            self.secondary_model = None
            self._secondary_date_id = None
            self._use_secondary_date = False
        for attr in ('_ad_teacher', '_ad_student', '_ad_autoencoder'):
            if getattr(self, attr, None) is not None:
                delattr(self, attr)
                setattr(self, attr, None)
        self._ad_mean = None
        self._ad_std = None
        self._ad_quantiles = None
        self._ad_transform = None
        self._ad_track_states = {}
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        gc.collect()
        print(f"[SWITCH] VRAM freed.")

        # Load new model
        print(f"[SWITCH] Loading checkpoint: {checkpoint['label']} ({checkpoint['path']})")
        from tracking_config import DEVICE
        self.model = YOLO(checkpoint["path"])
        self.model.to(DEVICE)
        names = self.model.names

        pkg_cls = checkpoint.get("package_class")
        bar_cls = checkpoint.get("barcode_class")
        date_cls = checkpoint.get("date_class")
        self.package_id = next((k for k, v in names.items() if v == pkg_cls), None) if pkg_cls else None
        self.barcode_id = next((k for k, v in names.items() if v == bar_cls), None) if bar_cls else None
        self.date_id = next((k for k, v in names.items() if v == date_cls), None) if date_cls else None
        self.mode = checkpoint.get("mode", "tracking")
        self.current_checkpoint = checkpoint

        if "exit_line_pct" in checkpoint:
            self._exit_line_pct = checkpoint["exit_line_pct"]
        if "exit_line_vertical" in checkpoint:
            self._exit_line_vertical = checkpoint["exit_line_vertical"]
        if "exit_line_inverted" in checkpoint:
            self._exit_line_inverted = checkpoint["exit_line_inverted"]
        if self._frame_height > 0 or self._frame_width > 0:
            self._recompute_exit_line_y()

        print(f"[SWITCH] Loaded | mode={self.mode} | "
              f"package_id={self.package_id} barcode_id={self.barcode_id} date_id={self.date_id}")

        # Secondary date model
        sec_path = checkpoint.get("secondary_date_model_path")
        sec_cls  = checkpoint.get("secondary_date_class")
        if sec_path and self.mode == "tracking":
            print(f"[SWITCH] Loading secondary date model: {sec_path}")
            self.secondary_model = YOLO(sec_path)
            try:
                self.secondary_model.to(DEVICE)
            except Exception:
                pass
            sec_names = self.secondary_model.names
            self._secondary_date_id = next(
                (k for k, v in sec_names.items() if v == sec_cls), None
            ) if sec_cls else None
            self._use_secondary_date = self._secondary_date_id is not None
            try:
                dummy = np.zeros((640, 640, 3), dtype=np.uint8)
                self.secondary_model(dummy, imgsz=CONFIG["imgsz"], verbose=False)
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                print(f"[SWITCH] Secondary model warmup done | date_id={self._secondary_date_id}")
            except Exception as e:
                print(f"[SWITCH] Secondary warmup failed (non-fatal): {e}")
        else:
            self.secondary_model = None
            self._secondary_date_id = None
            self._use_secondary_date = False

        # EfficientAD models
        if self.mode == "anomaly":
            self._load_ad_models(checkpoint, DEVICE)

        # Warmup
        try:
            dummy = np.zeros((640, 640, 3), dtype=np.uint8)
            self.model(dummy, imgsz=CONFIG["imgsz"], verbose=False)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            print(f"[SWITCH] Warmup done.")
        except Exception as e:
            print(f"[SWITCH] Warmup failed (non-fatal): {e}")

        return {
            "status": "switched",
            "checkpoint_id": checkpoint["id"],
            "label": checkpoint["label"],
            "mode": self.mode,
            "was_running": was_running,
            "prev_source": prev_source,
        }

    # ═══════════════════════════════════════════
    # THREAD 2: YOLO + BYTETRACK (detection dispatcher)
    # ═══════════════════════════════════════════

    def _detection_loop(self):
        """Run YOLO + ByteTrack in parallel. Dispatches to mode-specific processor."""
        try:
            # Wait for first frame to get dimensions
            print("[DETECTOR] Waiting for first frame...")
            for attempt in range(200):
                if not self.is_running:
                    return
                if self._det_event.wait(timeout=0.1):
                    break
            else:
                print("[DETECTOR] TIMEOUT: No frame after 20s, exiting")
                return

            with self._det_lock:
                first_frame = self._det_frame
            if first_frame is None:
                print("[DETECTOR] No frame received, exiting")
                return

            height, width = first_frame.shape[:2]
            cp = self.current_checkpoint or {}
            if "exit_line_pct" in cp:
                self._exit_line_pct = cp["exit_line_pct"]
            elif "zone_end_pct" in cp:
                # Anomaly mode: use the ENTRY line position for the slider
                self._exit_line_pct = round(cp["zone_end_pct"] * 100)
            else:
                self._exit_line_pct = round((1.0 - CONFIG["exit_line_ratio"]) * 100)
            if "exit_line_vertical" in cp:
                self._exit_line_vertical = cp["exit_line_vertical"]
            if "exit_line_inverted" in cp:
                self._exit_line_inverted = cp["exit_line_inverted"]
            self._recompute_exit_line_y()
            EXIT_LINE_Y = self._exit_line_y

            with self._overlay_lock:
                self._overlay['exit_line_y'] = EXIT_LINE_Y

            steps = self._rotation_steps % 4
            orientation = 'horizontal' if steps in (0, 2) else 'vertical'
            print(f"[DETECTOR] Started | {width}x{height} | Exit={EXIT_LINE_Y}px "
                  f"({self._exit_line_pct}% | {orientation})")

            last_processed_idx = 0

            # ── YOLO + tracker warmup on real first frame ──
            try:
                yolo_imgsz = cp.get("yolo_imgsz", CONFIG["imgsz"])
                yolo_conf = cp.get("yolo_conf", min(
                    CONFIG.get("conf_paquet", 0.45),
                    CONFIG.get("conf_barcode", 0.45),
                ))
                if self.mode in ("tracking", "anomaly"):
                    _warmup_kw = dict(
                        half=False, conf=yolo_conf, imgsz=yolo_imgsz,
                        verbose=False, persist=True, tracker=TRACKER_YAML_PATH,
                    )
                    if self.mode == "anomaly":
                        _warmup_kw["retina_masks"] = True
                    self.model.track(first_frame, **_warmup_kw)
                    print("[DETECTOR] Tracker warmup done (first .track() call)")
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception as wu_err:
                print(f"[DETECTOR] Warmup failed (non-fatal): {wu_err}")

            while self.is_running:
                if not self._det_event.wait(timeout=1.0):
                    if not self.is_running:
                        break
                    continue
                self._det_event.clear()

                with self._det_lock:
                    frame = self._det_frame
                    frame_idx = self._det_frame_idx

                if frame is None or frame_idx <= last_processed_idx:
                    continue

                last_processed_idx = frame_idx
                t_start = time.time()
                lag_frames = max(0, self.frame_count - frame_idx)
                with self._perf_lock:
                    self._perf["detector_lag_frames"] = lag_frames
                    self._perf["detector_last_frame_idx"] = frame_idx

                # ── YOLO Inference ──
                try:
                    cp = self.current_checkpoint or {}
                    conf_list = [
                        v for k in ("conf_paquet", "conf_barcode", "conf_date")
                        if (v := cp.get(k)) is not None
                    ]
                    conf_min = min(conf_list) if conf_list else min(
                        CONFIG.get("conf_paquet", 0.45),
                        CONFIG.get("conf_barcode", 0.45),
                    )
                    yolo_imgsz = cp.get("yolo_imgsz", CONFIG["imgsz"])
                    yolo_conf = cp.get("yolo_conf", conf_min)

                    if self.mode == "tracking":
                        results = self.model.track(
                            frame, half=False, conf=conf_min, imgsz=yolo_imgsz,
                            verbose=False, persist=True, tracker=TRACKER_YAML_PATH,
                        )[0]
                    else:  # anomaly
                        results = self.model.track(
                            frame, half=False, conf=yolo_conf, imgsz=yolo_imgsz,
                            verbose=False, persist=True, tracker=TRACKER_YAML_PATH,
                            retina_masks=True,
                        )[0]
                except Exception as yolo_err:
                    print(f"[DETECTOR] YOLO inference error: {yolo_err}")
                    continue

                # ── Mode dispatch ──
                if self.mode == "anomaly":
                    self._process_anomaly_frame(frame, frame_idx, results, t_start)
                else:
                    self._process_tracking_frame(frame, frame_idx, results, t_start)

            print("[DETECTOR] Stopped")

        except Exception as e:
            print(f"[DETECTOR] Error: {e}")
            import traceback
            traceback.print_exc()
