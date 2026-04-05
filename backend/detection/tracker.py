import time

from db_writer import SNAPSHOT_EVERY_N_PACKETS
from helpers import calculate_bbox_metrics
from tracking_config import CONFIG


class TrackerMixin:
    """Methods mixed into TrackingState for mode='tracking'."""

    # ─────────────────────────────────────────
    # TRACKING-MODE FRAME PROCESSOR
    # ─────────────────────────────────────────

    def _process_tracking_frame(self, frame, frame_idx, results, t_start):
        """Process a single detection frame in tracking mode.

        Called from _detection_loop once per YOLO inference cycle.
        Handles barcode/date association, exit line crossing, overlay & stats.
        """
        from detection.base import _secondary_executor

        # ── Extract tracked packages, barcode and date detections ──
        tracks = []
        barcode_dets = []
        date_dets = []

        # ── Submit secondary date model in parallel ──
        sec_future = None
        if self._use_secondary_date and self.secondary_model is not None:
            sec_conf = self.current_checkpoint.get("conf_date", CONFIG.get("conf_date", 0.30))
            sec_future = _secondary_executor.submit(
                self.secondary_model,
                frame,
                conf=sec_conf,
                imgsz=CONFIG["imgsz"],
                verbose=False,
            )

        if results.boxes is not None:
            box_ids = results.boxes.id
            for i, b in enumerate(results.boxes):
                cls = int(b.cls)
                conf = float(b.conf)
                x1, y1, x2, y2 = b.xyxy[0].cpu().numpy()
                if self.package_id is not None and cls == self.package_id and conf >= self.current_checkpoint.get("conf_paquet", CONFIG.get("conf_paquet")):
                    tid = int(box_ids[i]) if box_ids is not None else -1
                    if tid >= 0:
                        tracks.append([int(x1), int(y1), int(x2), int(y2), tid])
                elif self.barcode_id is not None and cls == self.barcode_id and conf >= self.current_checkpoint.get("conf_barcode", CONFIG.get("conf_barcode")):
                    barcode_dets.append([x1, y1, x2, y2, conf])
                elif self.date_id is not None and cls == self.date_id and conf >= self.current_checkpoint.get("conf_date", CONFIG.get("conf_date", 0.30)):
                    date_dets.append([int(x1), int(y1), int(x2), int(y2), conf])

        # ── Secondary date model inference (collect parallel result) ──
        secondary_date_dets = []
        if sec_future is not None:
            try:
                sec_results = sec_future.result(timeout=2.0)[0]
                if sec_results.boxes is not None:
                    for b in sec_results.boxes:
                        cls = int(b.cls)
                        conf_val = float(b.conf)
                        if cls == self._secondary_date_id:
                            sx1, sy1, sx2, sy2 = b.xyxy[0].cpu().numpy()
                            secondary_date_dets.append([int(sx1), int(sy1), int(sx2), int(sy2), conf_val])
            except Exception as sec_err:
                print(f"[DETECTOR] Secondary date model error: {sec_err}")

        # Merge and deduplicate date detections
        _merged = date_dets + secondary_date_dets
        all_date_dets = []
        for cand in sorted(_merged, key=lambda d: d[4], reverse=True):
            cx1, cy1, cx2, cy2 = cand[0], cand[1], cand[2], cand[3]
            duplicate = False
            for kept in all_date_dets:
                kx1, ky1, kx2, ky2 = kept[0], kept[1], kept[2], kept[3]
                ix1, iy1 = max(cx1, kx1), max(cy1, ky1)
                ix2, iy2 = min(cx2, kx2), min(cy2, ky2)
                inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                union = (cx2 - cx1) * (cy2 - cy1) + (kx2 - kx1) * (ky2 - ky1) - inter
                if union > 0 and inter / union > 0.4:
                    duplicate = True
                    break
            if not duplicate:
                all_date_dets.append(cand)

        # ── Per-track processing ──
        track_boxes = []
        require_date_for_ok = bool((self.current_checkpoint or {}).get("require_date_for_ok", False))

        for t in tracks:
            x1, y1, x2, y2, tid = int(t[0]), int(t[1]), int(t[2]), int(t[3]), int(t[4])

            if tid not in self.packages:
                inherited_barcode = False
                inherited_date = False
                if not self._use_secondary_date:
                    new_bbox = (x1, y1, x2, y2)
                    for etid, epkg in self.packages.items():
                        if epkg.get("prev_bbox") and self._compute_iou(new_bbox, epkg["prev_bbox"]) > 0.3:
                            if epkg.get("barcode_detected") and not inherited_barcode:
                                inherited_barcode = True
                            if epkg.get("date_detected") and not inherited_date:
                                inherited_date = True
                            if inherited_barcode and inherited_date:
                                break
                self.packages[tid] = {
                    "barcode_detected": inherited_barcode,
                    "date_detected": inherited_date,
                    "decision_locked": False,
                    "final_decision": None,
                    "prev_bbox": None,
                    "prev_area": None,
                    "frames_tracked": 0,
                    "first_frame": frame_idx,
                    "pre_line_seen": False,
                }

            pkg = self.packages[tid]
            pkg["frames_tracked"] += 1
            bbox = (x1, y1, x2, y2)
            ca, _ = calculate_bbox_metrics(x1, y1, x2, y2)
            pkg["prev_bbox"] = bbox
            pkg["prev_area"] = ca

            if not pkg["barcode_detected"]:
                for bx1, by1, bx2, by2, bc in barcode_dets:
                    det_box = (bx1, by1, bx2, by2)
                    if self._det_box_matches_package(det_box, bbox, "barcode"):
                        pkg["barcode_detected"] = True
                        break

            if not pkg.get("date_detected"):
                for dx1, dy1, dx2, dy2, dc in all_date_dets:
                    det_box = (dx1, dy1, dx2, dy2)
                    if self._det_box_matches_package(det_box, bbox, "date"):
                        pkg["date_detected"] = True
                        break

            if pkg["decision_locked"]:
                color = (255, 165, 0)
                status = pkg["final_decision"]
            else:
                has_barcode = pkg["barcode_detected"]
                has_date = pkg.get("date_detected", False)
                if require_date_for_ok:
                    if has_barcode and has_date:
                        color = (0, 255, 0)
                        status = "OK"
                    elif has_barcode:
                        color = (0, 165, 255)
                        status = "NOK(NO_DATE)"
                    else:
                        color = (0, 0, 255)
                        status = "NOK"
                elif has_barcode:
                    color = (0, 255, 0)
                    status = "OK"
                else:
                    color = (0, 0, 255)
                    status = "NOK"

            if tid in self.packet_numbers:
                lbl = f"#{self.packet_numbers[tid]} {status}"
            else:
                lbl = f"T{tid}|{status}"

            track_boxes.append((x1, y1, x2, y2, lbl, color))

        # ── Exit line crossing ──
        if self._exit_line_enabled:
            for t in tracks:
                x1, y1, x2, y2, tid = map(int, t[:5])
                if tid not in self.packages:
                    continue
                pkg = self.packages[tid]

                current_exit = self._exit_line_y
                line_is_vert = self._exit_line_vertical
                exit_pct = self._exit_line_pct

                # Snapshot the flag BEFORE potentially setting it —
                # a track must have been seen before the line on a
                # PREVIOUS frame to be eligible for crossing.
                was_pre_line = pkg["pre_line_seen"]

                if not was_pre_line:
                    effective_pct = (100 - exit_pct) if self._exit_line_inverted else exit_pct
                    if line_is_vert:
                        near_check = (x1 < current_exit) if effective_pct > 50 else (x1 > current_exit)
                    else:
                        near_check = (y1 < current_exit) if effective_pct > 50 else (y1 > current_exit)
                    if near_check:
                        pkg["pre_line_seen"] = True

                if self._exit_line_inverted:
                    crossed_check = (x1 <= current_exit) if line_is_vert else (y1 <= current_exit)
                else:
                    crossed_check = (x2 >= current_exit) if line_is_vert else (y2 >= current_exit)
                # Guard: was_pre_line (not pkg["pre_line_seen"]) ensures
                # approach and crossing never happen on the same frame.
                # frames_tracked >= 3 filters out ByteTrack noise tracks.
                if (crossed_check and was_pre_line
                        and pkg["frames_tracked"] >= 3
                        and tid not in self.packets_crossed_line):
                    if pkg["decision_locked"]:
                        self.packets_crossed_line.add(tid)
                        continue
                    self.packets_crossed_line.add(tid)
                    self.total_packets += 1
                    self.packet_numbers[tid] = self.total_packets
                    has_bc = pkg["barcode_detected"]
                    has_dt = pkg.get("date_detected", False)
                    final = "OK" if (has_bc and (has_dt or not require_date_for_ok)) else "NOK"
                    pkg["decision_locked"] = True
                    pkg["final_decision"] = final
                    self.output_fifo.append(final)
                    if final == "OK":
                        self._ok_count += 1
                    else:
                        self._nok_count += 1

                    # Save proof image for defective packets
                    if final == "NOK":
                        if not has_bc:
                            defect_type = "nobarcode"
                        elif require_date_for_ok and not has_dt:
                            defect_type = "nodate"
                        else:
                            defect_type = "nobarcode"
                        self._save_proof_image_bg(
                            self.total_packets - self._session_baseline_total,
                            defect_type, frame, (x1, y1, x2, y2))

                    # DB/session accounting is fully isolated: when
                    # recording is OFF, detection path does no DB work.
                    if self._stats_active:
                        if not has_bc:
                            self._nok_no_barcode += 1
                        elif require_date_for_ok and not has_dt:
                            self._nok_no_date += 1

                        if (
                            self._db_writer
                            and self._db_session_id
                            and self.total_packets % SNAPSHOT_EVERY_N_PACKETS == 0
                        ):
                            try:
                                self._db_writer.write_queue.put_nowait({
                                    "type": "session_update",
                                    "session_id": self._db_session_id,
                                    "total": self.total_packets,
                                    "ok_count": self._ok_count,
                                    "nok_no_barcode": self._nok_no_barcode,
                                    "nok_no_date": self._nok_no_date,
                                    "nok_anomaly": self._nok_anomaly,
                                })
                            except Exception:
                                pass

                        # Record defective packet with timestamp for ejection
                        if final == "NOK":
                            defect_type_db = "nobarcode"
                            if not has_bc:
                                defect_type_db = "nobarcode"
                            elif require_date_for_ok and not has_dt:
                                defect_type_db = "nodate"
                            try:
                                from datetime import datetime
                                self._db_writer.write_queue.put_nowait({
                                    "type": "crossing",
                                    "session_id": self._db_session_id,
                                    "packet_num": self.total_packets - self._session_baseline_total,
                                    "defect_type": defect_type_db,
                                    "crossed_at": datetime.now().strftime('%Y-%m-%dT%H:%M:%S.%f'),
                                })
                            except Exception:
                                pass

        # ── Detection timing ──
        det_ms = (time.time() - t_start) * 1000
        det_fps = 1000 / det_ms if det_ms > 0 else 0

        # ── Build FIFO string ──
        fifo_items = []
        for i, d in enumerate(self.output_fifo,
                              start=max(1, self.total_packets - len(self.output_fifo) + 1)):
            fifo_items.append(f"#{i}:{d}")
        fifo_str = " | ".join(fifo_items) if fifo_items else "(empty)"

        # Barcode overlay
        barcode_vis = [(int(bx1), int(by1), int(bx2), int(by2), bc)
                       for bx1, by1, bx2, by2, bc in barcode_dets]

        # ── Store overlay for video feed ──
        with self._overlay_lock:
            self._overlay = {
                'track_boxes': track_boxes,
                'barcode_boxes': barcode_vis,
                'date_boxes': all_date_dets,
                'exit_line_y': self._exit_line_y,
                'total_packets': self.total_packets,
                'fifo_str': fifo_str,
                'det_fps': det_fps,
                'det_ms': det_ms,
                'frame_idx': frame_idx,
            }

        # ── Update API stats ──
        ok = self._ok_count
        nok = self._nok_count

        with self._stats_lock:
            self.stats.update({
                "det_fps": round(det_fps, 1),
                "inference_ms": round(det_ms, 1),
                "total_packets": self.total_packets,
                "packages_ok": ok,
                "packages_nok": nok,
                "rotation_deg": (self._rotation_steps % 4) * 90,
                "fifo_queue": list(self.output_fifo)[-20:],
            })
        with self._perf_lock:
            self._perf["detector_loop_ms"] = round(det_ms, 2)
