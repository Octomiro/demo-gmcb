import os
import time

import cv2
import numpy as np

from db_writer import SNAPSHOT_EVERY_N_PACKETS
from helpers import letterbox_image, LIVE_IMAGES_ROOT


class AnomalyMixin:
    """Methods mixed into TrackingState for mode='anomaly'."""

    # ─────────────────────────────────────────
    # MODEL LOADING
    # ─────────────────────────────────────────

    def _load_ad_models(self, checkpoint, device):
        """Load EfficientAD teacher/student/autoencoder for anomaly mode."""
        import torch
        from torchvision import transforms
        from anomaly_inference import get_ad_constants

        ad_teacher_path = checkpoint.get("ad_teacher", "teacher_best.pth")
        ad_student_path = checkpoint.get("ad_student", "student_best.pth")
        ad_ae_path = checkpoint.get("ad_autoencoder", "autoencoder_best.pth")
        ad_imgsz = checkpoint.get("ad_imgsz", 256)

        print(f"[SWITCH] Loading EfficientAD models...")
        self._ad_teacher = torch.load(ad_teacher_path, map_location=device, weights_only=False).eval()
        self._ad_student = torch.load(ad_student_path, map_location=device, weights_only=False).eval()
        self._ad_autoencoder = torch.load(ad_ae_path, map_location=device, weights_only=False).eval()

        self._ad_mean, self._ad_std, self._ad_quantiles = get_ad_constants(device)

        self._ad_transform = transforms.Compose([
            transforms.Resize((ad_imgsz, ad_imgsz)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        ])
        self._ad_track_states = {}

        # Warmup EfficientAD
        try:
            dummy = torch.zeros(1, 3, ad_imgsz, ad_imgsz, device=device)
            from anomaly_inference import predict as effpredict
            effpredict(
                image=dummy, teacher=self._ad_teacher, student=self._ad_student,
                autoencoder=self._ad_autoencoder, teacher_mean=self._ad_mean,
                teacher_std=self._ad_std,
                q_st_start=self._ad_quantiles['q_st_start'],
                q_st_end=self._ad_quantiles['q_st_end'],
                q_ae_start=self._ad_quantiles['q_ae_start'],
                q_ae_end=self._ad_quantiles['q_ae_end']
            )
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            print("[SWITCH] EfficientAD warmup done.")
        except Exception as e:
            print(f"[SWITCH] EfficientAD warmup failed (non-fatal): {e}")

    # ─────────────────────────────────────────
    # CROP / INFERENCE
    # ─────────────────────────────────────────

    def _ad_crop_and_mask(self, frame, mask_raw, checkpoint):
        """Crop object using segmentation mask, blackout background, letterbox."""
        h_f, w_f = frame.shape[:2]
        mask_full = cv2.resize(mask_raw, (w_f, h_f), interpolation=cv2.INTER_LINEAR)
        _, mask_full = cv2.threshold(mask_full, 0.5, 1, cv2.THRESH_BINARY)

        rows, cols = np.where(mask_full > 0)
        if len(rows) == 0:
            return None
        x1, y1, x2, y2 = np.min(cols), np.min(rows), np.max(cols), np.max(rows)

        w_box, h_box = x2 - x1, y2 - y1
        margin = checkpoint.get("ad_margin_pct", 0.1)
        m_x, m_y = int(w_box * margin), int(h_box * margin)

        cx1, cy1 = max(0, x1 - m_x), max(0, y1 - m_y)
        cx2, cy2 = min(w_f, x2 + m_x), min(h_f, y2 + m_y)

        img_crop = frame[cy1:cy2, cx1:cx2].copy()
        mask_crop = mask_full[cy1:cy2, cx1:cx2].copy()

        erosion_size = checkpoint.get("ad_erosion_size", 3)
        if erosion_size > 0:
            mask_blurred = cv2.GaussianBlur(mask_crop, (5, 5), 0)
            _, mask_final = cv2.threshold(mask_blurred, 0.5, 1, cv2.THRESH_BINARY)
            mask_final = mask_final.astype(np.uint8)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (erosion_size, erosion_size))
            mask_final = cv2.erode(mask_final, kernel, iterations=1)
        else:
            mask_final = mask_crop.astype(np.uint8)

        img_crop[mask_final == 0] = 0
        img_rgb = cv2.cvtColor(img_crop, cv2.COLOR_BGR2RGB)
        return letterbox_image(img_rgb)

    def _ad_detect_anomaly(self, img_crop_np):
        """Run EfficientAD on a preprocessed crop. Returns (is_defective, score)."""
        import torch
        from PIL import Image
        from anomaly_inference import predict as effpredict

        pil_img = Image.fromarray(img_crop_np)
        orig_w, orig_h = pil_img.size
        img_tensor = self._ad_transform(pil_img).unsqueeze(0)
        device = next(self._ad_teacher.parameters()).device
        img_tensor = img_tensor.to(device)

        map_combined, _, _ = effpredict(
            image=img_tensor, teacher=self._ad_teacher, student=self._ad_student,
            autoencoder=self._ad_autoencoder, teacher_mean=self._ad_mean,
            teacher_std=self._ad_std,
            q_st_start=self._ad_quantiles['q_st_start'],
            q_st_end=self._ad_quantiles['q_st_end'],
            q_ae_start=self._ad_quantiles['q_ae_start'],
            q_ae_end=self._ad_quantiles['q_ae_end']
        )

        map_combined = torch.nn.functional.pad(map_combined, (4, 4, 4, 4))
        map_combined = torch.nn.functional.interpolate(
            map_combined, (orig_h, orig_w), mode='bilinear')
        score = map_combined[0, 0].cpu().numpy().max()
        del img_tensor, map_combined

        thresh = (self.current_checkpoint or {}).get("ad_thresh", 5000.0)
        return score > thresh, float(score)

    def _ad_detect_anomaly_batch(self, crops):
        """Run EfficientAD on a list of 256x256 RGB uint8 crops in one batched GPU call.
        Returns list of (is_defective, score) in same order as input crops."""
        import torch
        from PIL import Image
        from anomaly_inference import predict as effpredict

        if not crops:
            return []

        device = next(self._ad_teacher.parameters()).device
        thresh = (self.current_checkpoint or {}).get("ad_thresh", 5000.0)

        # Build batch tensor on CPU then transfer once
        tensors = []
        sizes = []
        for crop_np in crops:
            pil_img = Image.fromarray(crop_np)
            sizes.append((pil_img.width, pil_img.height))
            tensors.append(self._ad_transform(pil_img))
        batch = torch.stack(tensors).to(device)  # [N, 3, 256, 256]

        # Single batched forward pass through all three networks
        map_combined, _, _ = effpredict(
            image=batch, teacher=self._ad_teacher, student=self._ad_student,
            autoencoder=self._ad_autoencoder, teacher_mean=self._ad_mean,
            teacher_std=self._ad_std,
            q_st_start=self._ad_quantiles['q_st_start'],
            q_st_end=self._ad_quantiles['q_st_end'],
            q_ae_start=self._ad_quantiles['q_ae_start'],
            q_ae_end=self._ad_quantiles['q_ae_end']
        )

        # Post-process per sample
        results = []
        for k in range(map_combined.shape[0]):
            m = map_combined[k:k+1]  # keep batch dim [1, 1, H, W]
            orig_w, orig_h = sizes[k]
            m = torch.nn.functional.pad(m, (4, 4, 4, 4))
            m = torch.nn.functional.interpolate(m, (orig_h, orig_w), mode='bilinear')
            score = m[0, 0].cpu().numpy().max()
            results.append((score > thresh, float(score)))

        del batch, map_combined, m
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        return results

    @staticmethod
    def _ad_final_decision(results, strategy="MAJORITY"):
        """Aggregate per-frame anomaly results into a final decision."""
        if not results:
            return False
        if strategy == "OR":
            return any(results)
        # MAJORITY
        return sum(results) > (len(results) / 2)

    # ─────────────────────────────────────────
    # NOK PACKET SAVING
    # ─────────────────────────────────────────

    def _save_nok_packet(self, pkt_num, tstate, checkpoint, session_id=None):
        """Save NOK packet — worst-crop image under liveImages/<session>/anomalie/packet_<N>.webp."""
        if not session_id:
            return
        base = LIVE_IMAGES_ROOT / session_id / "anomalie"
        try:
            os.makedirs(base, exist_ok=True)
        except OSError as e:
            print(f"[AD] Cannot create {base}: {e}")
            return

        crops = tstate.get("crops", [])
        scores = tstate.get("scores", [])

        # Save worst crop image
        if crops and scores:
            worst_idx = max(range(len(scores)), key=lambda i: scores[i])
            img_path = os.path.join(base, f"packet_{pkt_num}.webp")
            try:
                bgr = cv2.cvtColor(crops[worst_idx], cv2.COLOR_RGB2BGR)
                cv2.imwrite(img_path, bgr, [cv2.IMWRITE_WEBP_QUALITY, 85])
                import logging as _logging
                _logging.getLogger(__name__).debug(
                    "[AD] Saved NOK packet #%s -> %s", pkt_num, img_path
                )
            except Exception as e:
                print(f"[AD] Failed to save {img_path}: {e}")

    def _save_nok_packet_bg(self, pkt_num, tstate, checkpoint):
        """Fire-and-forget: save NOK image via bounded thread pool.
        Drops task if queue is backing up to prevent RAM exhaustion."""
        from detection.base import _proof_executor
        # Guard: drop if too many tasks are already queued (disk too slow)
        try:
            queue_depth = _proof_executor._work_queue.qsize()
        except Exception:
            queue_depth = 0
        if queue_depth > 50:
            print(f"[AD] Proof queue full ({queue_depth}), dropping NOK image for packet #{pkt_num}")
            return
        data = {
            'results': list(tstate.get('results', [])),
            'scores': list(tstate.get('scores', [])),
            'crops': list(tstate.get('crops', [])),
        }
        session_now = self._db_session_id if self._stats_active else None
        cp_copy = dict(checkpoint)
        _proof_executor.submit(
            self._save_nok_packet,
            pkt_num, data, cp_copy, session_now,
        )

    # ─────────────────────────────────────────
    # ANOMALY-MODE FRAME PROCESSOR
    # ─────────────────────────────────────────

    def _process_anomaly_frame(self, frame, frame_idx, results, t_start):
        """Process a single detection frame in anomaly mode.

        Called from _detection_loop once per YOLO inference cycle.
        Handles segmentation + batched EfficientAD + overlay + stats.
        """
        cp = self.current_checkpoint or {}
        zone_start_pct = cp.get("zone_start_pct", 0.20)
        zone_end_pct = cp.get("zone_end_pct", 0.60)
        ad_strategy = cp.get("ad_strategy", "MAJORITY")
        ad_max_scans = cp.get("ad_max_scans", 5)
        h_f, w_f = frame.shape[:2]
        # Packets flow RIGHT → LEFT:
        #   zone_end_px   = ENTRY line (right, where scanning begins)
        #   zone_start_px = EXIT  line (left, decision is final)
        exit_line_px = int(w_f * zone_start_pct)
        entry_line_px = int(w_f * zone_end_pct)

        track_boxes = []
        ad_zone_lines = (exit_line_px, entry_line_px)

        has_masks = results.masks is not None
        has_ids = results.boxes is not None and results.boxes.id is not None

        if has_masks and has_ids:
            masks = results.masks.data.cpu().numpy()
            boxes = results.boxes.xyxy.cpu().numpy()
            track_ids = results.boxes.id.int().cpu().tolist()

            # ── PHASE 1: Classify each track + collect crops (CPU only) ──
            ad_batch_crops = []    # crops to send to EfficientAD
            ad_batch_indices = []  # index into track_ids for each crop
            per_track_info = []    # (i, tid, x1, y1, x2, y2, zone) per track

            for i, tid in enumerate(track_ids):
                if tid not in self._ad_track_states:
                    self._ad_track_states[tid] = {
                        'results': [], 'scores': [],
                        'crops': [], 'decision': None,
                    }
                tstate = self._ad_track_states[tid]

                x1, y1, x2, y2 = map(int, boxes[i])
                center_x = (x1 + x2) // 2

                if tstate['decision'] is not None:
                    per_track_info.append((i, tid, x1, y1, x2, y2, 'decided'))
                elif center_x > entry_line_px:
                    per_track_info.append((i, tid, x1, y1, x2, y2, 'entering'))
                elif exit_line_px <= center_x <= entry_line_px:
                    n_scans = len(tstate['results'])
                    if n_scans < ad_max_scans:
                        img_crop = self._ad_crop_and_mask(frame, masks[i], cp)
                        if img_crop is not None:
                            ad_batch_crops.append(img_crop)
                            ad_batch_indices.append(i)
                    per_track_info.append((i, tid, x1, y1, x2, y2, 'scanning'))
                else:
                    per_track_info.append((i, tid, x1, y1, x2, y2, 'exiting'))

            # ── PHASE 2: Batched EfficientAD inference (single GPU call) ──
            ad_batch_results = []
            if ad_batch_crops:
                try:
                    ad_batch_results = self._ad_detect_anomaly_batch(ad_batch_crops)
                except Exception as ad_err:
                    print(f"[AD] Batch inference error: {ad_err}")
                    ad_batch_results = [None] * len(ad_batch_crops)

            # Build lookup: track index → (is_def, score)
            ad_result_by_idx = {}
            for batch_pos, track_idx in enumerate(ad_batch_indices):
                ad_result_by_idx[track_idx] = ad_batch_results[batch_pos] if batch_pos < len(ad_batch_results) else None

            # ── PHASE 3: Assign results and build overlay ──
            for (i, tid, x1, y1, x2, y2, zone) in per_track_info:
                tstate = self._ad_track_states[tid]
                label = "WAITING"
                color = (200, 200, 200)

                if zone == 'decided':
                    is_def = tstate['decision']
                    pkt_num = self.packet_numbers.get(tid)
                    if is_def:
                        label = f"#{pkt_num} DEFECTIVE" if pkt_num else f"T{tid} DEFECTIVE"
                        color = (0, 0, 255)
                    else:
                        label = f"#{pkt_num} GOOD" if pkt_num else f"T{tid} GOOD"
                        color = (0, 255, 0)

                elif zone == 'entering':
                    label = f"T{tid} ENTERING"
                    color = (200, 200, 200)

                elif zone == 'scanning':
                    # Apply batched result if this track had a crop
                    batch_result = ad_result_by_idx.get(i)
                    if batch_result is not None:
                        is_def, score = batch_result
                        tstate['results'].append(is_def)
                        tstate['scores'].append(score)
                        tstate['crops'].append(ad_batch_crops[ad_batch_indices.index(i)].copy())
                    elif batch_result is None and i in ad_result_by_idx:
                        # Batch error for this crop
                        label = f"T{tid} AD-ERR"
                        color = (0, 165, 255)
                        track_boxes.append((x1, y1, x2, y2, label, color))
                        continue
                    n_scans = len(tstate['results'])
                    label = f"T{tid} SCAN {n_scans}/{ad_max_scans}"
                    color = (0, 255, 255)

                else:  # exiting
                    tstate['decision'] = self._ad_final_decision(
                        tstate['results'], strategy=ad_strategy)
                    is_def = tstate['decision']

                    self.packets_crossed_line.add(tid)
                    self.total_packets += 1
                    self.packet_numbers[tid] = self.total_packets
                    final = "NOK" if is_def else "OK"
                    self.output_fifo.append(final)
                    if final == "OK":
                        self._ok_count += 1
                    else:
                        self._nok_count += 1

                    if self._stats_active and is_def:
                        self._nok_anomaly += 1

                    if is_def:
                        import logging as _logging
                        _logging.getLogger(__name__).debug(
                            "[AD] Packet #%d -> NOK (scans=%d)",
                            self.total_packets, len(tstate['results'])
                        )
                        self._save_nok_packet_bg(
                            self.total_packets, tstate, cp)

                    tstate['crops'] = []
                    tstate['scores'] = []
                    # Schedule dead track for removal after overlay is built
                    # (do not del here as tstate is still referenced below)

                    if self._stats_active:
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
                                    "nok_no_barcode": 0,
                                    "nok_no_date": 0,
                                    "nok_anomaly": self._nok_anomaly,
                                })
                            except Exception:
                                if self._db_writer:
                                    self._db_writer.log_dropped("session_update")
                        # Record defective packet with timestamp for ejection
                        if is_def:
                            try:
                                from datetime import datetime
                                self._db_writer.write_queue.put_nowait({
                                    "type": "crossing",
                                    "session_id": self._db_session_id,
                                    "packet_num": self.total_packets - self._session_baseline_total,
                                    "defect_type": "anomaly",
                                    "crossed_at": datetime.now().strftime('%Y-%m-%dT%H:%M:%S.%f'),
                                })
                            except Exception:
                                if self._db_writer:
                                    self._db_writer.log_dropped("crossing")

                    pkt_num = self.packet_numbers.get(tid)
                    if is_def:
                        label = f"#{pkt_num} DEFECTIVE" if pkt_num else f"T{tid} DEFECTIVE"
                        color = (0, 0, 255)
                    else:
                        label = f"#{pkt_num} GOOD" if pkt_num else f"T{tid} GOOD"
                        color = (0, 255, 0)

                track_boxes.append((x1, y1, x2, y2, label, color))

        # Prune tracks that are no longer active:
        # - decided tracks that have left the frame (normal exit)
        # - abandoned tracks with no decision that disappeared (occlusion/ID switch)
        active_tids = set(track_ids) if (has_masks and has_ids) else set()
        dead_tids = [
            tid for tid, st in self._ad_track_states.items()
            if tid not in active_tids and (
                st['decision'] is not None or  # decided and gone
                (st['decision'] is None and len(st.get('crops', [])) > 0)  # abandoned mid-scan
            )
        ]
        for tid in dead_tids:
            # Explicitly clear crop arrays before deleting to free numpy memory immediately
            self._ad_track_states[tid]['crops'] = []
            self._ad_track_states[tid]['scores'] = []
            del self._ad_track_states[tid]

        det_ms = (time.time() - t_start) * 1000
        det_fps = 1000 / det_ms if det_ms > 0 else 0

        ok = self._ok_count
        nok = self._nok_count

        # Build FIFO string from actual results (same as tracking mode)
        fifo_items = []
        for fi, fd in enumerate(self.output_fifo,
                                start=max(1, self.total_packets - len(self.output_fifo) + 1)):
            fifo_items.append(f"#{fi}:{fd}")
        fifo_str = " | ".join(fifo_items) if fifo_items else "(anomaly mode)"

        with self._overlay_lock:
            self._overlay = {
                'track_boxes': track_boxes,
                'barcode_boxes': [],
                'exit_line_y': self._exit_line_y,
                'total_packets': self.total_packets,
                'fifo_str': fifo_str,
                'det_fps': det_fps,
                'det_ms': det_ms,
                'frame_idx': frame_idx,
                'ad_zone_lines': ad_zone_lines,
            }
        with self._stats_lock:
            self.stats.update({
                "det_fps": round(det_fps, 1),
                "inference_ms": round(det_ms, 1),
                "total_packets": self.total_packets,
                "packages_ok": ok,
                "packages_nok": nok,
                "fifo_queue": list(self.output_fifo)[-20:],
            })
        with self._perf_lock:
            self._perf["detector_loop_ms"] = round(det_ms, 2)
