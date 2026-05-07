import os
import platform
import time

import cv2
import numpy as np

from tracking_config import (
    CAMERA_FPS, CAMERA_WIDTH, CAMERA_HEIGHT,
    DETECTOR_FRAME_SKIP, ANOMALY_FRAME_SKIP,
)

# ── TurboJPEG decode (same lib as compositor encode): SIMD JPEG → BGR ─────────
try:
    from turbojpeg import TJPF_BGR, TurboJPEG

    _tj_reader = TurboJPEG()
    _HAS_TURBOJPEG_DECODE = True
except Exception:
    _tj_reader = None
    TJPF_BGR = None  # type: ignore[misc, assignment]
    _HAS_TURBOJPEG_DECODE = False


def _mjpeg_grab_decode(cap: cv2.VideoCapture):
    """grab + retrieve when CAP_PROP_CONVERT_RGB=0: JPEG bytes → BGR.

    Falls back to cv2.imdecode if TurboJPEG fails. Returns (ok, frame|None).
    """
    if not cap.grab():
        return False, None
    ret, buf = cap.retrieve()
    if not ret or buf is None:
        return False, None
    # Driver already decoded to BGR
    if buf.ndim == 3 and buf.shape[2] == 3 and buf.shape[0] > 1:
        return True, buf
    flat = np.ascontiguousarray(buf.reshape(-1))
    raw = flat.tobytes()
    if len(raw) < 4:
        return False, None
    if raw[0] != 0xFF or raw[1] != 0xD8:
        return False, None
    if _HAS_TURBOJPEG_DECODE and _tj_reader is not None and TJPF_BGR is not None:
        try:
            return True, _tj_reader.decode(raw, pixel_format=TJPF_BGR)
        except Exception:
            pass
    try:
        frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is not None:
            return True, frame
    except Exception:
        pass
    return False, None


class ReaderMixin:
    """_reader_loop method mixed into TrackingState."""

    # ═══════════════════════════════════════════
    # THREAD 1: VIDEO READER (smooth, native FPS)
    # ═══════════════════════════════════════════

    def _reader_loop(self, session_gen: int):
        """Read frames at native FPS. NEVER waits for YOLO. Always smooth."""
        cap = None
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

            _is_rtsp = isinstance(src, str) and src.startswith("rtsp://")
            if _is_rtsp:
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
                cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            else:
                import platform
                if isinstance(src, str) and src.isdigit():
                    src = int(src)
                if platform.system() == "Windows":
                    cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
                else:
                    cap = cv2.VideoCapture(src, cv2.CAP_V4L2)
                # Order matters for V4L2: FOURCC → WIDTH → HEIGHT → FPS (last).
                # Setting WIDTH/HEIGHT fires VIDIOC_S_FMT which resets FPS;
                # VIDIOC_S_PARM (FPS) must be issued after the format is final.
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
                cap.set(cv2.CAP_PROP_FRAME_WIDTH,  getattr(self, '_capture_width',  CAMERA_WIDTH))
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, getattr(self, '_capture_height', CAMERA_HEIGHT))
                cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)   # LAST: after format
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)  # 2 = USB double-buffer; 1 starves DMA → 15fps

            if not cap or not cap.isOpened():
                print(f"[READER] ERROR: Cannot open source: {src}")
                self._camera_error = "camera_unavailable"
                self.is_running = False
                return

            raw_fps = cap.get(cv2.CAP_PROP_FPS)
            # Live cameras often report 0; use requested CAMERA_FPS as fallback
            fps = raw_fps if raw_fps and raw_fps > 0 else CAMERA_FPS
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

            # Read back the actual negotiated fourcc so we can confirm MJPG was accepted
            fourcc_int = int(cap.get(cv2.CAP_PROP_FOURCC))
            fourcc_str = "".join(chr((fourcc_int >> (8 * i)) & 0xFF) for i in range(4))
            usb_bw_mbps = w * h * fps * 2 / 1_000_000  # YUYV worst-case bandwidth
            print(
                f"[READER] Opened: {w}x{h} @ {fps:.0f}fps | fourcc={fourcc_str!r} | "
                f"YUYV-equiv BW={usb_bw_mbps:.0f} MB/s | "
                f"{'OK: camera using MJPEG (compressed)' if fourcc_str.strip() == 'MJPG' else 'WARNING: camera NOT using MJPG — high USB bandwidth!'}"
            )

            # MJPEG on Linux V4L2: optional raw JPEG buffers + TurboJPEG SIMD decode
            # (same PyTurboJPEG as compositor). Falls back to cap.read() per-frame if needed.
            use_turbo_mjpeg = (
                not _is_rtsp
                and platform.system() != "Windows"
                and fourcc_str.strip() == "MJPG"
                and _HAS_TURBOJPEG_DECODE
            )
            if use_turbo_mjpeg:
                cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
                print("[READER] MJPEG decode: TurboJPEG (V4L2 JPEG → BGR, SIMD)")
            elif not _is_rtsp and platform.system() != "Windows" and fourcc_str.strip() == "MJPG":
                print("[READER] MJPEG decode: OpenCV cap.read() (TurboJPEG import unavailable)")

            # Flush stale frames accumulated in the V4L2/driver buffer before
            # entering the main loop, so the stream starts from a fresh frame.
            self.cap = cap
            if use_turbo_mjpeg:
                for _ in range(4):
                    ok, _ = _mjpeg_grab_decode(cap)
                    if not ok:
                        cap.read()
            else:
                for _ in range(4):
                    cap.grab()

            with self._stats_lock:
                self.stats["video_fps"] = round(fps, 1)
                self.stats["is_running"] = True
                self.stats["camera_fourcc"] = fourcc_str.strip()
                self.stats["camera_width"] = w
                self.stats["camera_height"] = h

            self._frame_width = w
            self._frame_height = h

            # Rolling reader-FPS measurement (updated every 5 frames → ~167ms response)
            _rfps_count = 0
            _rfps_t0 = time.monotonic()

            while self.is_running:
                if use_turbo_mjpeg:
                    ret, frame = _mjpeg_grab_decode(cap)
                    if not ret:
                        cap.set(cv2.CAP_PROP_CONVERT_RGB, 1)
                        ret, frame = cap.read()
                        cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
                else:
                    ret, frame = cap.read()
                if not ret:
                    # USB detached or stream lost — attempt reconnect (USB only)
                    if _is_rtsp:
                        print("[READER] RTSP stream lost — stopping")
                        break
                    print("[READER] Camera read failed — waiting for USB reconnect...")
                    try:
                        cap.release()
                    except Exception:
                        pass
                    cap = None
                    self.cap = None
                    with self._stats_lock:
                        self.stats["camera_reconnecting"] = True
                    reconnected = False
                    attempt = 0
                    # Fast reconnect: try every 0.3s for first 5 attempts (cable glitch recovery),
                    # then slow down to 1s. Minimises detection gap during USB extender drops.
                    while self.is_running and self._session_gen == session_gen:
                        wait = 0.3 if attempt < 5 else 1.0
                        time.sleep(wait)
                        if not self.is_running or self._session_gen != session_gen:
                            break
                        attempt += 1
                        print(f"[READER] Reconnect attempt {attempt} (waiting for USB camera) ...")
                        try:
                            if platform.system() == "Windows":
                                new_cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
                            else:
                                new_cap = cv2.VideoCapture(src, cv2.CAP_V4L2)
                            new_cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
                            new_cap.set(cv2.CAP_PROP_FRAME_WIDTH,  getattr(self, '_capture_width',  CAMERA_WIDTH))
                            new_cap.set(cv2.CAP_PROP_FRAME_HEIGHT, getattr(self, '_capture_height', CAMERA_HEIGHT))
                            new_cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
                            new_cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
                            if new_cap.isOpened():
                                if use_turbo_mjpeg:
                                    new_cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
                                    for _ in range(4):
                                        ok, _ = _mjpeg_grab_decode(new_cap)
                                        if not ok:
                                            new_cap.read()
                                else:
                                    for _ in range(4):
                                        new_cap.grab()
                                cap = new_cap
                                self.cap = cap
                                reconnected = True
                                print(f"[READER] USB camera reconnected (attempt {attempt})")
                                break
                            else:
                                new_cap.release()
                        except Exception as ex:
                            print(f"[READER] Reconnect attempt {attempt} error: {ex}")
                    with self._stats_lock:
                        self.stats["camera_reconnecting"] = False
                    if not reconnected:
                        # Session was stopped externally — exit cleanly
                        break
                    continue   # resume reading from the new cap

                self.frame_count += 1
                frame_idx = self.frame_count

                # Live reader FPS + USB bandwidth estimate — updated every 5 frames
                _rfps_count += 1
                if _rfps_count == 5:
                    _rfps_t1 = time.monotonic()
                    elapsed = _rfps_t1 - _rfps_t0
                    if elapsed > 0:
                        rfps = round(5.0 / elapsed, 1)
                        # Re-encode one frame to JPEG to measure actual compressed size
                        # (approximates MJPG frame size the camera sends over USB)
                        try:
                            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                            frame_bytes = len(buf) if ok else (frame.nbytes // 8)
                        except Exception:
                            frame_bytes = frame.nbytes // 8
                        bw_mbps = round(frame_bytes * rfps * 8 / 1e6, 1)
                        with self._stats_lock:
                            self.stats["reader_fps"] = rfps
                            self.stats["camera_bw_mbps"] = bw_mbps
                    _rfps_t0 = _rfps_t1
                    _rfps_count = 0

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
                        # Safe zero-copy handoff: detector treats frames as read-only.
                        self._det_frame = frame
                        self._det_frame_idx = frame_idx
                    self._det_event.set()

        except Exception as e:
            print(f"[READER] Error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            time.sleep(0.1)  # Let other threads notice is_running change
            if cap:
                try:
                    cap.release()
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
                        # Safe zero-copy handoff: detector treats frames as read-only.
                        self._det_frame = frame
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

        raw_fps = CAMERA_FPS # Emulate real camera FPS
        w = int(cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
        frame_interval = 1.0 / raw_fps
        
        # Simulate real camera properties if it's a video file
        w = CAMERA_WIDTH
        h = CAMERA_HEIGHT

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

                # Simulation: resize video frames to camera resolution
                frame = cv2.resize(frame, (CAMERA_WIDTH, CAMERA_HEIGHT))

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
                        # Safe zero-copy handoff: detector treats frames as read-only.
                        self._det_frame = frame
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
