import time

import cv2

from tracking_config import JPEG_QUALITY


class CompositorMixin:
    """_compositor_loop method mixed into TrackingState."""

    # ═══════════════════════════════════════════
    # THREAD 3: COMPOSITOR (pre-encode JPEG)
    # ═══════════════════════════════════════════

    def _compositor_loop(self):
        """
        Continuously composites raw frame + detection overlay and
        pre-encodes to JPEG bytes. The MJPEG feed just yields these
        bytes instantly — zero computation in the request handler.
        Runs at native video FPS, woken by _raw_changed event.
        """
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
        print("[COMPOSITOR] Started")

        try:
            while self.is_running:
                loop_t0 = time.time()
                # Block until reader produces a new frame (or timeout)
                got = self._raw_changed.wait(timeout=0.1)
                if not self.is_running:
                    break
                if got:
                    self._raw_changed.clear()

                # Grab latest raw frame
                with self._raw_lock:
                    raw = self._raw_frame
                if raw is None:
                    continue

                frame = raw.copy()
                h, w = frame.shape[:2]

                # Grab latest overlay (from detector thread)
                with self._overlay_lock:
                    ov_tracks    = list(self._overlay.get('track_boxes', []))
                    ov_barcodes  = list(self._overlay.get('barcode_boxes', []))
                    ov_dates     = list(self._overlay.get('date_boxes', []))
                    ov_frame_idx = self._overlay.get('frame_idx', 0)
                    ov_total     = self._overlay.get('total_packets', 0)
                    ov_fifo      = self._overlay.get('fifo_str', '(empty)')
                    ov_det_fps   = self._overlay.get('det_fps', 0)
                    ov_det_ms    = self._overlay.get('det_ms', 0)
                    ov_ad_zones  = self._overlay.get('ad_zone_lines', None)

                # If available, draw overlay on the exact raw frame used by
                # detector to avoid apparent bbox shift on moving conveyor.
                if ov_frame_idx > 0:
                    matched = None
                    with self._raw_history_lock:
                        for idx, f in reversed(self._raw_history):
                            if idx == ov_frame_idx:
                                matched = f
                                break
                            if idx < ov_frame_idx:
                                break
                    if matched is not None:
                        frame = matched.copy()
                        h, w = frame.shape[:2]
                        with self._perf_lock:
                            self._perf["compositor_sync_hits"] += 1
                    else:
                        with self._perf_lock:
                            self._perf["compositor_sync_misses"] += 1

                # ── Exit line: use dedicated attribute (set once by detector, updated live) ──
                # Fall back to frame-based estimate only until detector computes it
                ov_ely = self._exit_line_y
                ov_line_vert = self._exit_line_vertical
                if ov_ely <= 0:
                    ref = w if ov_line_vert else h
                    if ref > 0:
                        ov_ely = int(ref * self._exit_line_pct / 100)

                # ── Draw detection boxes ──
                for (x1, y1, x2, y2, label, color) in ov_tracks:
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, label, (x1, y1 - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

                # ── Draw barcode boxes ──
                for (bx1, by1, bx2, by2, bc) in ov_barcodes:
                    cv2.rectangle(frame, (bx1, by1), (bx2, by2), (0, 255, 255), 2)
                    cv2.putText(frame, f"barcode {bc:.2f}",
                                (bx1, by1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)

                # ── Draw date boxes ──
                for (dx1, dy1, dx2, dy2, dc) in ov_dates:
                    cv2.rectangle(frame, (dx1, dy1), (dx2, dy2), (0, 0, 0), 2)
                    cv2.putText(frame, f"date {dc:.2f}",
                                (dx1, dy1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

                # ── Draw exit line (skip for anomaly mode — uses internal zone lines) ──
                if ov_ely > 0 and self._exit_line_enabled and self.mode != "anomaly":
                    if ov_line_vert:
                        cv2.line(frame, (ov_ely, 0), (ov_ely, h), (255, 0, 0), 3)
                        cv2.putText(frame, "EXIT LINE", (ov_ely + 5, 30),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)
                    else:
                        cv2.line(frame, (0, ov_ely), (w, ov_ely), (255, 0, 0), 3)
                        cv2.putText(frame, "EXIT LINE", (w - 200, ov_ely - 10),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)

                # ── Draw anomaly detection ENTRY / EXIT lines (vertical) ──
                if ov_ad_zones is not None:
                    exit_px, entry_px = ov_ad_zones
                    # Entry line (right side — where packets enter the scan zone)
                    cv2.line(frame, (entry_px, 0), (entry_px, h), (0, 200, 255), 2)
                    cv2.putText(frame, "ENTRY", (entry_px + 5, 25),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)
                    # Exit line (left side — decision is final here)
                    cv2.line(frame, (exit_px, 0), (exit_px, h), (255, 0, 0), 2)
                    cv2.putText(frame, "EXIT", (exit_px + 5, 25),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 0), 2)

                # ── HUD ──
                cv2.putText(frame, f"FIFO: {ov_fifo}", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)
                cv2.putText(frame, f"TOTAL: {ov_total}",
                            (w - 250, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

                # Show "Waiting for YOLO..." before first detection arrives
                if ov_det_ms == 0 and len(ov_tracks) == 0:
                    cv2.putText(frame, "YOLO: warming up...",
                                (10, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
                else:
                    cv2.putText(frame,
                                f"YOLO: {ov_det_ms:.0f}ms | ~{ov_det_fps:.0f}fps",
                                (10, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

                cv2.putText(frame, f"Frame: {self.frame_count}",
                            (w - 180, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)

                # ── Encode to JPEG once (reused by all browser clients) ──
                ret, buf = cv2.imencode('.jpg', frame, encode_params)
                if ret:
                    full_bytes = buf.tobytes()
                    # Low-bandwidth version: half resolution, quality 40
                    low_frame = cv2.resize(frame, None, fx=0.5, fy=0.5,
                                           interpolation=cv2.INTER_AREA)
                    ret_low, buf_low = cv2.imencode(
                        '.jpg', low_frame, [cv2.IMWRITE_JPEG_QUALITY, 40])
                    low_bytes = buf_low.tobytes() if ret_low else full_bytes
                    with self._jpeg_lock:
                        self._jpeg_bytes = full_bytes
                        self._jpeg_bytes_low = low_bytes

                with self._perf_lock:
                    self._perf["compositor_loop_ms"] = round((time.time() - loop_t0) * 1000, 2)

        except Exception as e:
            print(f"[COMPOSITOR] Error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            print("[COMPOSITOR] Stopped")
