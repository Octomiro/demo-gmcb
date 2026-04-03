import os
import time

import cv2

from tracking_config import (
    CAMERA_FPS, CAMERA_WIDTH, CAMERA_HEIGHT,
    DETECTOR_FRAME_SKIP, ANOMALY_FRAME_SKIP,
)


class ReaderMixin:
    """_reader_loop method mixed into TrackingState."""

    # ═══════════════════════════════════════════
    # THREAD 1: VIDEO READER (smooth, native FPS)
    # ═══════════════════════════════════════════

    def _reader_loop(self, session_gen: int):
        """Read frames at native FPS. NEVER waits for YOLO. Always smooth."""
        try:
            src = self.video_source

            # ── Synthetic source: generate random frames as fast as possible ──
            if src == "synthetic":
                self._reader_loop_synthetic(session_gen)
                return

            # ── STRESS TEST: Video file looping (delete with stress_test.py) ──
            if isinstance(src, str) and os.path.isfile(src):
                self._reader_loop_video_file(session_gen, src)
                return

            if isinstance(src, str) and src.startswith("rtsp://"):
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
                self.cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            else:
                import platform
                if isinstance(src, str) and src.isdigit():
                    src = int(src)
                if platform.system() == "Windows":
                    self.cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
                else:
                    self.cap = cv2.VideoCapture(src, cv2.CAP_V4L2)
                self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
                self.cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not self.cap or not self.cap.isOpened():
                print(f"[READER] ERROR: Cannot open source: {src}")
                self.is_running = False
                return

            raw_fps = self.cap.get(cv2.CAP_PROP_FPS)
            # Live cameras often report 0; use requested CAMERA_FPS as fallback
            fps = raw_fps if raw_fps and raw_fps > 0 else CAMERA_FPS
            w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

            with self._stats_lock:
                self.stats["video_fps"] = round(fps, 1)
                self.stats["is_running"] = True

            self._frame_width = w
            self._frame_height = h

            print(f"[READER] Opened: {w}x{h} @ {fps:.0f}fps | Live camera")

            while self.is_running:
                ret, frame = self.cap.read()
                if not ret:
                    break

                self.frame_count += 1
                frame_idx = self.frame_count

                # Optional live rotation (applies to stream + detector)
                rot_steps = self._rotation_steps % 4
                if rot_steps:
                    frame = self._rotate_frame_ccw(frame, rot_steps)

                # Store raw frame for streaming (always latest)
                with self._raw_lock:
                    self._raw_frame = frame
                with self._raw_history_lock:
                    self._raw_history.append((frame_idx, frame))
                    history_len = len(self._raw_history)
                with self._perf_lock:
                    self._perf["raw_history_len"] = history_len
                self._raw_changed.set()

                # ── Send 1 frame out of N to detector (mode-aware skip) ──
                _effective_skip = ANOMALY_FRAME_SKIP if self.mode == "anomaly" else DETECTOR_FRAME_SKIP
                if self.frame_count % _effective_skip == 0:
                    with self._det_lock:
                        self._det_frame = frame.copy()
                        self._det_frame_idx = frame_idx
                    self._det_event.set()

        except Exception as e:
            print(f"[READER] Error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            time.sleep(0.1)  # Let other threads notice is_running change
            if self.cap:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None
            # Only update shared state if this is still the current session;
            # a newer session may have already set is_running = True.
            if self._session_gen == session_gen:
                self.is_running = False
                with self._stats_lock:
                    self.stats["is_running"] = False
            print(f"[READER] Stopped (gen={session_gen})")

    def _reader_loop_synthetic(self, session_gen: int):
        """Synthetic source: generate random BGR frames as fast as possible.
        Used for stress-testing GPU inference and system design without a camera.
        """
        import numpy as np
        w, h = CAMERA_WIDTH, CAMERA_HEIGHT
        fps = float(CAMERA_FPS)
        frame_interval = 1.0 / fps

        with self._stats_lock:
            self.stats["video_fps"] = fps
            self.stats["is_running"] = True

        self._frame_width = w
        self._frame_height = h
        print(f"[READER] Synthetic source: {w}x{h} @ {fps:.0f}fps (no camera)")

        rng = np.random.default_rng()
        t_last = time.monotonic()
        try:
            while self.is_running and self._session_gen == session_gen:
                # Generate a random frame (simulates a noisy camera image)
                frame = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)

                self.frame_count += 1
                frame_idx = self.frame_count

                with self._raw_lock:
                    self._raw_frame = frame
                with self._raw_history_lock:
                    self._raw_history.append((frame_idx, frame))
                    history_len = len(self._raw_history)
                with self._perf_lock:
                    self._perf["raw_history_len"] = history_len
                self._raw_changed.set()

                _effective_skip = ANOMALY_FRAME_SKIP if self.mode == "anomaly" else DETECTOR_FRAME_SKIP
                if self.frame_count % _effective_skip == 0:
                    with self._det_lock:
                        self._det_frame = frame.copy()
                        self._det_frame_idx = frame_idx
                    self._det_event.set()

                # Throttle to target FPS so we don't spin the CPU at 100%
                now = time.monotonic()
                elapsed = now - t_last
                sleep_for = frame_interval - elapsed
                if sleep_for > 0:
                    time.sleep(sleep_for)
                t_last = time.monotonic()
        except Exception as e:
            print(f"[READER][synthetic] Error: {e}")
        finally:
            if self._session_gen == session_gen:
                self.is_running = False
                with self._stats_lock:
                    self.stats["is_running"] = False
            print(f"[READER] Synthetic stopped (gen={session_gen})")

    # ── STRESS TEST: Video file looping reader (delete with stress_test.py) ──
    def _reader_loop_video_file(self, session_gen: int, filepath: str):
        """Read a video file in a loop. The file restarts when it ends.
        Used for stress-testing with real footage. DELETE AFTER TESTING.
        """
        import cv2 as _cv2

        print(f"[READER] Video-file source: {filepath}")
        cap = _cv2.VideoCapture(filepath)
        if not cap or not cap.isOpened():
            print(f"[READER] ERROR: Cannot open video file: {filepath}")
            self.is_running = False
            return

        raw_fps = cap.get(_cv2.CAP_PROP_FPS) or CAMERA_FPS
        w = int(cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
        frame_interval = 1.0 / raw_fps

        with self._stats_lock:
            self.stats["video_fps"] = round(raw_fps, 1)
            self.stats["is_running"] = True
        self._frame_width = w
        self._frame_height = h

        loop_count = 0
        print(f"[READER] Video file opened: {w}x{h} @ {raw_fps:.0f}fps (will loop)")

        try:
            t_last = time.monotonic()
            while self.is_running and self._session_gen == session_gen:
                ret, frame = cap.read()
                if not ret:
                    # Video ended → loop
                    loop_count += 1
                    cap.set(_cv2.CAP_PROP_POS_FRAMES, 0)
                    continue

                self.frame_count += 1
                frame_idx = self.frame_count

                rot_steps = self._rotation_steps % 4
                if rot_steps:
                    frame = self._rotate_frame_ccw(frame, rot_steps)

                with self._raw_lock:
                    self._raw_frame = frame
                with self._raw_history_lock:
                    self._raw_history.append((frame_idx, frame))
                    hl = len(self._raw_history)
                with self._perf_lock:
                    self._perf["raw_history_len"] = hl
                self._raw_changed.set()

                _effective_skip = ANOMALY_FRAME_SKIP if self.mode == "anomaly" else DETECTOR_FRAME_SKIP
                if self.frame_count % _effective_skip == 0:
                    with self._det_lock:
                        self._det_frame = frame.copy()
                        self._det_frame_idx = frame_idx
                    self._det_event.set()

                # Throttle to video FPS
                now = time.monotonic()
                sleep_for = frame_interval - (now - t_last)
                if sleep_for > 0:
                    time.sleep(sleep_for)
                t_last = time.monotonic()
        except Exception as e:
            print(f"[READER][video-file] Error: {e}")
        finally:
            cap.release()
            if self._session_gen == session_gen:
                self.is_running = False
                with self._stats_lock:
                    self.stats["is_running"] = False
            print(f"[READER] Video file stopped (gen={session_gen}, loops={loop_count})")
    # ── END STRESS TEST: Video file looping reader ──
