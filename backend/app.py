from gevent import monkey
monkey.patch_all(thread=False, queue=False, subprocess=False, signal=False, os=False)
import gevent

import atexit
import base64
import io
import json
import logging
import os
import re
import signal
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
import numpy as np
from flask import Flask, jsonify, request, Response, render_template, send_file
from flask_cors import CORS

from tracking_config import (
    CONFIG, SERVER_HOST, SERVER_PORT,
    CHECKPOINTS, CAMERAS, JPEG_QUALITY,
    get_checkpoint, get_camera,
    PIPELINES, DEFAULT_VIEW_PIPELINE,
    DEFAULT_CHECKPOINT_ID,
)
from pipeline_manager import (
    db_writer, pipelines, pipeline_checkpoint_ids,
    _view_state, _all_states,
    _session_lock,
    init_all_pipelines,
)
import pipeline_manager

from helpers import LIVE_IMAGES_ROOT

from scheduler import (
    scheduler,
    _reschedule_shift, _remove_shift_jobs,
    _load_all_shift_jobs,
    cleanup_old_proof_images,
)
from apscheduler.triggers.cron import CronTrigger
from concurrent.futures import ProcessPoolExecutor
from reporting import build_report_summary, generate_report_pdf

_report_executor = ProcessPoolExecutor(max_workers=1)

from auth import auth_bp
from feedback import feedback_bp, run_screenshot_cleanup as _feedback_screenshot_cleanup

_TUNIS_TZ = ZoneInfo("Africa/Tunis")

# ==========================
# FLASK APP
# ==========================
app = Flask(__name__)
app.config['JSON_SORT_KEYS'] = False
CORS(app, resources={r"/api/*": {"origins": "*"},
                     r"/video_feed": {"origins": "*"}})
app.register_blueprint(auth_bp)
app.register_blueprint(feedback_bp)


# ==========================
# WEB ROUTES
# ==========================

@app.route('/api/health')
def api_health():
    return jsonify({"status": "ok"})


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/video_feed')
def video_feed():
    """MJPEG stream — serves pre-encoded JPEG bytes from the active view pipeline.
    Query params for remote/low-bandwidth mode:
      ?low=1        → half resolution, quality 40, 5 fps  (saves ~80% bandwidth)
      ?quality=N    → JPEG quality 1-95  (default: use compositor's full-quality)
      ?scale=F      → resize factor 0.1-1.0  (default: 1.0 = full res)
      ?fps=N        → target fps 1-30  (default: 25)
    """
    from flask import request as flask_request
    low_mode = flask_request.args.get('low', '0') == '1'
    quality = int(flask_request.args.get('quality', 40 if low_mode else 0))
    scale = float(flask_request.args.get('scale', 0.5 if low_mode else 1.0))
    fps = int(flask_request.args.get('fps', 5 if low_mode else 30))
    fps = max(1, min(30, fps))
    scale = max(0.1, min(1.0, scale))
    quality = max(1, min(95, quality)) if quality > 0 else 0
    sleep_interval = 1.0 / fps

    placeholder = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(placeholder, "Waiting for stream...", (120, 240),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    _, buf = cv2.imencode('.jpg', placeholder)
    placeholder_bytes = buf.tobytes()

    def generate():
        last_seq = 0
        # Track low-bandwidth clients so compositor knows when to encode low-res
        if low_mode:
            for _, st in _all_states():
                st._low_clients_count = getattr(st, '_low_clients_count', 0) + 1
        try:
            while True:
                st = _view_state()
                if st is not None:
                    # Yield frame ASAP when available; only wait up to
                    # sleep_interval if compositor hasn't produced one yet.
                    # (threading.Event.wait blocks the gevent hub when
                    # threads aren't patched — use gevent.sleep polling)
                    if not st._jpeg_event.is_set():
                        deadline = time.monotonic() + sleep_interval
                        while time.monotonic() < deadline:
                            if st._jpeg_event.is_set():
                                break
                            gevent.sleep(0.003)  # yield to other greenlets
                    st._jpeg_event.clear()

                    with st._jpeg_lock:
                        cur_seq = st._jpeg_seq
                        if low_mode:
                            jpeg = st._jpeg_bytes_low or st._jpeg_bytes
                        else:
                            jpeg = st._jpeg_bytes

                    # Skip if same frame (compositor hasn't produced a new one)
                    if jpeg is not None and cur_seq == last_seq:
                        gevent.sleep(0.003)
                        continue
                    last_seq = cur_seq
                else:
                    jpeg = None
                    gevent.sleep(sleep_interval)

                frame_bytes = jpeg if jpeg is not None else placeholder_bytes

                # Custom quality/scale (non-low): still needs per-viewer re-encode
                if not low_mode and frame_bytes is not None and (quality > 0 or scale < 1.0):
                    arr = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
                    if arr is not None:
                        if scale < 1.0:
                            arr = cv2.resize(arr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                        enc_q = quality if quality > 0 else JPEG_QUALITY
                        ret, buf2 = cv2.imencode('.jpg', arr, [cv2.IMWRITE_JPEG_QUALITY, enc_q])
                        if ret:
                            frame_bytes = buf2.tobytes()

                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n'
                       b'Content-Length: ' + str(len(frame_bytes)).encode() + b'\r\n\r\n'
                       + frame_bytes + b'\r\n')
        finally:
            # Decrement low-client counter when stream closes
            if low_mode:
                for _, st in _all_states():
                    st._low_clients_count = max(0, getattr(st, '_low_clients_count', 1) - 1)

    return Response(
        generate(),
        mimetype='multipart/x-mixed-replace; boundary=frame',
        headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Accel-Buffering': 'no',
        }
    )


# ==========================
# PIPELINE CONTROL ROUTES
# ==========================

@app.route('/api/start', methods=['POST'])
def api_start():
    data = request.get_json(silent=True) or {}
    source_overrides = data.get("sources", {})
    enabled_pipelines = data.get("enabled_pipelines")  # None = all enabled
    # enabled_checks: which validation rules are enforced
    # e.g. {"barcode": True, "date": False, "anomaly": True}
    raw_checks = data.get("enabled_checks") or {}
    enabled_checks = {
        "barcode": bool(raw_checks.get("barcode", True)),
        "date":    bool(raw_checks.get("date",    True)),
        "anomaly": bool(raw_checks.get("anomaly", True)),
    }
    results = {}
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None:
            continue
        if enabled_pipelines is not None and pid not in enabled_pipelines:
            # Explicitly disabled — ensure it is stopped
            if st.is_running:
                st.stop_processing()
            results[pid] = {"status": "skipped"}
            continue
        source = source_overrides.get(pid, pipe_cfg["camera_source"])
        if isinstance(source, str) and source.isdigit():
            source = int(source)
        st.set_enabled_checks(enabled_checks)
        results[pid] = st.start_processing(source)

    # Wait briefly for reader threads to attempt camera open (camera not plugged
    # in fails within milliseconds; 0.7 s is a comfortable buffer).
    gevent.sleep(0.7)
    camera_errors = {
        pid: st._camera_error
        for pipe_cfg in PIPELINES
        if (pid := pipe_cfg["id"])
        and (st := pipelines.get(pid)) is not None
        and isinstance(results.get(pid), dict)
        and results[pid].get("status") == "started"
        and not st.is_running
        and getattr(st, "_camera_error", None)
    }
    if camera_errors:
        return jsonify({
            "error": "camera_unavailable",
            "message": "Impossible d'ouvrir la caméra. Vérifiez qu'elle est branchée et réessayez.",
            "pipelines": camera_errors,
        }), 503

    return jsonify({"status": "started", "pipelines": results})


@app.route('/api/stop', methods=['POST'])
def api_stop():
    results = {}
    for pid, st in _all_states():
        results[pid] = st.stop_processing()
    return jsonify({"status": "stopped", "pipelines": results})


@app.route('/api/prewarm', methods=['POST'])
def api_prewarm():
    data = request.get_json(silent=True) or {}
    source_overrides = data.get("sources", {})
    results = {}
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None:
            continue
        if st.is_running:
            results[pid] = {"status": "already_running"}
            continue
        source = source_overrides.get(pid, pipe_cfg["camera_source"])
        if isinstance(source, str) and source.isdigit():
            source = int(source)
        results[pid] = st.start_processing(source)
        print(f"[PREWARM][{pid}] Pipeline started (no stats recording)")
    return jsonify({"status": "prewarmed", "pipelines": results})


@app.route('/api/prewarm/status', methods=['GET'])
def api_prewarm_status():
    result = {}
    for pid, st in _all_states():
        result[pid] = {
            "is_running": st.is_running,
            "stats_active": getattr(st, '_stats_active', False),
        }
    any_warm = any(v["is_running"] and not v["stats_active"] for v in result.values())
    any_recording = any(v["stats_active"] for v in result.values())
    return jsonify({
        "pipelines": result,
        "is_prewarmed": any_warm,
        "is_recording": any_recording,
    })


# ==========================
# STATS ROUTES
# ==========================

@app.route('/api/stats')
def api_stats():
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    pid = pipeline_manager.active_view_id
    cp_id = pipeline_checkpoint_ids.get(pid, "")
    with state._stats_lock:
        s = dict(state.stats)
    with state._perf_lock:
        perf = dict(state._perf)
    s["pipeline_id"]      = pid
    s["checkpoint_id"]    = cp_id
    s["checkpoint_label"] = (state.current_checkpoint or {}).get("label", "")
    s["checkpoint_mode"]  = state.mode
    s["camera_id"]        = ""
    s["exit_line_enabled"] = state._exit_line_enabled
    s["exit_line_vertical"] = state._exit_line_vertical
    s["exit_line_inverted"] = state._exit_line_inverted
    s["exit_line_pct"] = state._exit_line_pct
    s["rotation_deg"] = (state._rotation_steps % 4) * 90
    s["perf"] = perf
    s["stats_active"] = getattr(state, '_stats_active', False)
    s["session_id"] = getattr(state, '_db_session_id', None)
    s["db_available"] = db_writer is not None
    s["db_backend"] = db_writer.backend if db_writer is not None else None
    s["nok_no_barcode"] = getattr(state, '_nok_no_barcode', 0)
    s["nok_no_date"] = getattr(state, '_nok_no_date', 0)
    return jsonify(s)


@app.route('/api/perf')
def api_perf():
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    pid = pipeline_manager.active_view_id
    with state._stats_lock:
        stats = dict(state.stats)
    with state._perf_lock:
        perf = dict(state._perf)
    return jsonify({
        "pipeline_id": pid,
        "checkpoint_id": pipeline_checkpoint_ids.get(pid, ""),
        "checkpoint_mode": state.mode,
        "is_running": state.is_running,
        "frame_count": state.frame_count,
        "video_fps": stats.get("video_fps", 0),
        "det_fps": stats.get("det_fps", 0),
        "inference_ms": stats.get("inference_ms", 0),
        "perf": perf,
    })


# ──────────────────────────────────────────────────────────────
# SSE REALTIME STATS
# ──────────────────────────────────────────────────────────────
# One-way push replacement for the old 1.5s polling. Each detection pipeline
# publishes a stats snapshot on crossings (forced) and on a ~2 Hz heartbeat.
# The bus lives in memory; subscribers are per-HTTP-connection.

from stats_bus import stats_bus, iter_sse


@app.route('/api/stats/stream')
def api_stats_stream():
    """Server-Sent Events stream of per-pipeline stats snapshots.

    Event format (one per frame):
        event: stats
        data: {"pipeline_id":"pipeline_barcode_date","total_packets":42,...}

    A ``: ping`` comment is emitted every 15s when idle so NAT/proxies keep
    the connection open.
    """
    def _serialize(d):
        # Compact output — keeps wire size down without changing meaning.
        return json.dumps(d, separators=(',', ':'), default=str)

    sub = stats_bus.subscribe()

    # Kick every pipeline to emit a primer event so the client paints as
    # soon as the connection opens, without waiting for the first crossing
    # or the 2 Hz tick.
    for _pid, _st in _all_states():
        try:
            _st._publish_stats(force=True)
        except Exception:
            pass

    def _generate():
        try:
            # Opening comment flushes headers past any buffering proxy.
            yield b": connected\n\n"
            yield from iter_sse(
                sub,
                serialize=_serialize,
                sleeper=gevent.sleep,
                heartbeat_interval=15.0,
                poll_timeout=0.25,
            )
        finally:
            stats_bus.unsubscribe(sub)

    resp = Response(
        _generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            # Nginx-specific: disable response buffering for this location.
            'X-Accel-Buffering': 'no',
            # Keep the connection open indefinitely — the client reconnects
            # automatically on drop.
            'Connection': 'keep-alive',
        },
    )
    return resp


@app.route('/api/stats/status')
def api_stats_status():
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    total = state.total_packets
    ok_count = state._ok_count
    nok_count = state._nok_count
    return jsonify({
        "pipeline_id": pipeline_manager.active_view_id,
        "stats_active": getattr(state, '_stats_active', False),
        "session_id": getattr(state, '_db_session_id', None),
        "db_available": db_writer is not None,
        "db_backend": db_writer.backend if db_writer is not None else None,
        "total": total,
        "ok_count": ok_count,
        "nok_count": nok_count,
        "nok_no_barcode": getattr(state, '_nok_no_barcode', 0),
        "nok_no_date": getattr(state, '_nok_no_date', 0),
        "nok_rate_pct": round(nok_count / total * 100, 2) if total > 0 else 0.0,
    })


@app.route('/api/stats/toggle', methods=['POST'])
def api_stats_toggle():
    request.get_json(force=True, silent=True)
    any_active = any(getattr(st, '_stats_active', False) for _, st in _all_states())
    new_active = not any_active
    group_id = str(uuid.uuid4()) if new_active else ""

    with _session_lock:
        if new_active:
            pipeline_manager._active_session_source = "manual"
            pipeline_manager._active_session_group = group_id
            pipeline_manager._active_session_shift_id = None
        else:
            pipeline_manager._active_session_source = None
            pipeline_manager._active_session_group = None
            pipeline_manager._active_session_shift_id = None

    results = {}
    for pid, st in _all_states():
        # When enabling, only record on pipelines that are actually running
        if new_active and not st.is_running:
            results[pid] = {"stats_active": False, "session_id": None}
            continue
        results[pid] = st.set_stats_recording(new_active, group_id=group_id)
    return jsonify({
        "stats_active": new_active,
        "group_id": group_id,
        "db_available": db_writer is not None,
        "db_backend": db_writer.backend if db_writer is not None else None,
        "pipelines": results,
    })


# ==========================
# SESSION ROUTES
# ==========================

@app.route('/api/session/start', methods=['POST'])
def api_session_start():
    with _session_lock:
        if pipeline_manager._active_session_source is not None:
            return jsonify({
                "error": "session already active",
                "source": pipeline_manager._active_session_source,
                "group_id": pipeline_manager._active_session_group,
            }), 409

        data = request.get_json(force=True, silent=True) or {}
        shift_id = (data.get("shift_id") or "").strip()
        group_id = str(uuid.uuid4())
        pipeline_manager._active_session_source = "manual"
        pipeline_manager._active_session_group = group_id
        pipeline_manager._active_session_shift_id = shift_id or None

    # Parse enabled_checks from request (default: all enabled)
    raw_checks = data.get("enabled_checks") or {}
    enabled_checks = {
        "barcode": bool(raw_checks.get("barcode", True)),
        "date":    bool(raw_checks.get("date",    True)),
        "anomaly": bool(raw_checks.get("anomaly", True)),
    }

    # Derive which physical pipelines to start
    enabled_pids = set()
    if enabled_checks["barcode"] or enabled_checks["date"]:
        enabled_pids.add("pipeline_barcode_date")
    if enabled_checks["anomaly"]:
        enabled_pids.add("pipeline_anomaly")

    source_overrides = data.get("sources", {})
    pipeline_results = {}
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None:
            continue
        if pid not in enabled_pids:
            if st.is_running:
                st.stop_processing()
            pipeline_results[pid] = "skipped"
            continue
        source = source_overrides.get(pid, pipe_cfg["camera_source"])
        if isinstance(source, str) and source.isdigit():
            source = int(source)
        st.set_enabled_checks(enabled_checks)
        if not st.is_running:
            st.start_processing(source)
        st.set_stats_recording(True, group_id=group_id, shift_id=shift_id,
                               enabled_checks=enabled_checks)
        pipeline_results[pid] = "started"

    # Brief wait for reader threads — detect camera failures before returning.
    gevent.sleep(0.7)
    camera_errors = {}
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None or pipeline_results.get(pid) != "started":
            continue
        if not st.is_running and getattr(st, "_camera_error", None):
            camera_errors[pid] = st._camera_error
    if camera_errors:
        # Roll back: close the session records and clear the guard so the
        # scheduler (and next manual attempt) can try again cleanly.
        for pid, st in _all_states():
            if getattr(st, "_stats_active", False):
                st.set_stats_recording(False, end_reason="camera_unavailable")
            if st.is_running:
                st.stop_processing()
        with _session_lock:
            pipeline_manager._active_session_source = None
            pipeline_manager._active_session_group = None
            pipeline_manager._active_session_shift_id = None
        return jsonify({
            "error": "camera_unavailable",
            "message": "Impossible d'ouvrir la caméra. Vérifiez qu'elle est branchée et réessayez.",
            "pipelines": camera_errors,
        }), 503

    return jsonify({
        "status": "started",
        "group_id": group_id,
        "shift_id": shift_id,
        "enabled_checks": enabled_checks,
        "pipelines": pipeline_results,
    })


@app.route('/api/session/stop', methods=['POST'])
def api_session_stop():
    pipeline_results = {}
    for pid, st in _all_states():
        if getattr(st, '_stats_active', False):
            st.set_stats_recording(False)
        if st.is_running:
            st.stop_processing()
        pipeline_results[pid] = "stopped"

    with _session_lock:
        prev_group = pipeline_manager._active_session_group
        pipeline_manager._active_session_source = None
        pipeline_manager._active_session_group = None
        pipeline_manager._active_session_shift_id = None

    return jsonify({
        "status": "stopped",
        "group_id": prev_group or "",
        "pipelines": pipeline_results,
    })


@app.route('/api/session/status')
def api_session_status():
    from scheduler import _preemption_lock, _preemption_event, _camera_failure_lock, _camera_failure_event
    import scheduler as _sched_mod

    any_running = any(st.is_running for _, st in _all_states())
    any_recording = any(getattr(st, '_stats_active', False) for _, st in _all_states())
    guard_stale = pipeline_manager._active_session_source is not None and not any_running and not any_recording

    # Current enabled checks from first running pipeline
    current_checks = None
    for _, st in _all_states():
        if st.is_running:
            current_checks = dict(getattr(st, '_enabled_checks', {"barcode": True, "date": True, "anomaly": True}))
            break

    # Pop preemption event (consumed once by frontend)
    preemption = None
    with _preemption_lock:
        if _sched_mod._preemption_event is not None:
            preemption = _sched_mod._preemption_event
            _sched_mod._preemption_event = None

    # Pop camera-failure event (consumed once by frontend)
    camera_failure = None
    with _camera_failure_lock:
        if _sched_mod._camera_failure_event is not None:
            camera_failure = _sched_mod._camera_failure_event
            _sched_mod._camera_failure_event = None

    return jsonify({
        "active": pipeline_manager._active_session_source is not None,
        "source": pipeline_manager._active_session_source,
        "group_id": pipeline_manager._active_session_group,
        "shift_id": pipeline_manager._active_session_shift_id,
        "any_running": any_running,
        "any_recording": any_recording,
        "guard_stale": guard_stale,
        "preemption": preemption,
        "camera_failure": camera_failure,
        "enabled_checks": current_checks,
    })


@app.route('/api/session/reset-guard', methods=['POST'])
def api_session_reset_guard():
    with _session_lock:
        prev = pipeline_manager._active_session_source
        pipeline_manager._active_session_source = None
        pipeline_manager._active_session_group = None
        pipeline_manager._active_session_shift_id = None
    print(f"[SESSION] Guard manually reset (was: {prev})")
    return jsonify({"reset": True, "previous_source": prev})


@app.route('/api/session/checks', methods=['POST'])
def api_session_update_checks():
    """Update enabled_checks on a running session without stopping it.
    Logs the change for future reporting."""
    with _session_lock:
        if pipeline_manager._active_session_source is None:
            return jsonify({"error": "no active session"}), 409
        group_id = pipeline_manager._active_session_group

    data = request.get_json(force=True, silent=True) or {}
    raw = data.get("enabled_checks") or {}
    new_checks = {
        "barcode": bool(raw.get("barcode", True)),
        "date":    bool(raw.get("date",    True)),
        "anomaly": bool(raw.get("anomaly", True)),
    }

    # Snapshot old checks from the first running pipeline
    old_checks = {"barcode": True, "date": True, "anomaly": True}
    for _, st in _all_states():
        if st.is_running:
            old_checks = dict(getattr(st, '_enabled_checks', old_checks))
            break

    # Push new checks into every running pipeline's TrackingState
    for _, st in _all_states():
        if st.is_running:
            st.set_enabled_checks(new_checks)

    # Determine which physical pipelines need to be active
    old_pids = set()
    if old_checks.get("barcode", True) or old_checks.get("date", True):
        old_pids.add("pipeline_barcode_date")
    if old_checks.get("anomaly", True):
        old_pids.add("pipeline_anomaly")
        
    new_pids = set()
    if new_checks.get("barcode", True) or new_checks.get("date", True):
        new_pids.add("pipeline_barcode_date")
    if new_checks.get("anomaly", True):
        new_pids.add("pipeline_anomaly")

    # Start/stop pipelines based on check changes
    camera_errors = {}
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None:
            continue
            
        was_on = pid in old_pids
        now_on = pid in new_pids
        
        if was_on and not now_on:
            # OFF → fully stop the pipeline
            if getattr(st, "_stats_active", False):
                st.set_stats_recording(False, end_reason="check_disabled")
            if st.is_running:
                st.stop_processing()
                
        elif not was_on and now_on:
            # ON → start the pipeline and re-attach to current session
            if not st.is_running:
                st.set_enabled_checks(new_checks)
                # Reuse the last known source, or fallback to config
                src = getattr(st, "video_source", None)
                if src is None:
                    src = pipe_cfg.get("camera_source", 0)
                if isinstance(src, str) and src.isdigit():
                    src = int(src)
                st.start_processing(src)

    # Wait briefly for reader threads to attempt camera open
    gevent.sleep(0.7)
    
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None:
            continue
        now_on = pid in new_pids
        if pid not in old_pids and now_on:
            if not st.is_running and getattr(st, "_camera_error", None):
                camera_errors[pid] = st._camera_error
                # Rollback specific flags
                if pid == "pipeline_anomaly":
                    new_checks["anomaly"] = False
                elif pid == "pipeline_barcode_date":
                    new_checks["barcode"] = False
                    new_checks["date"] = False

    if camera_errors:
        # Rollback the check changes in remaining running pipelines
        for _, st2 in _all_states():
            if st2.is_running:
                st2.set_enabled_checks(new_checks)
        if db_writer:
            db_writer.update_session_checks(group_id, new_checks)
        return jsonify({
            "error": "camera_unavailable",
            "message": "Impossible d'activer le mode. Vérifiez que la caméra est branchée.",
            "pipelines": camera_errors
        }), 503

    # Ensure all newly running pipelines have stats recording ON
    shift_id_active = pipeline_manager._active_session_shift_id
    for pid in new_pids:
        st = pipelines.get(pid)
        if st and st.is_running and not getattr(st, "_stats_active", False):
            # Pass is_group=True strictly if it's the anomaly pipeline to stay consistent with original logic,
            # though it mainly checks if it's not the primary one controlling full IDs
            st.set_stats_recording(True, group_id=group_id, shift_id=shift_id_active, is_group=(pid == "pipeline_anomaly"), enabled_checks=new_checks)

    # Persist: update the live session rows + insert audit log
    if db_writer:
        db_writer.update_session_checks(group_id, new_checks)
        db_writer.log_check_change(group_id, old_checks, new_checks)

    print(f"[SESSION] Live checks updated: {old_checks} → {new_checks}")
    return jsonify({
        "status": "updated",
        "group_id": group_id,
        "old_checks": old_checks,
        "new_checks": new_checks,
    })


# ── Scheduled auto-stop ──────────────────────────────────────────────────────
_scheduled_stop_time = None   # ISO string or None
_scheduled_stop_job_id = "auto_stop_session"

def _auto_stop_session():
    """Called by APScheduler at the scheduled time to stop the session."""
    global _scheduled_stop_time
    print(f"[SESSION] Auto-stop triggered at {datetime.now(_TUNIS_TZ).strftime('%H:%M:%S')}")
    for _, st in _all_states():
        if getattr(st, '_stats_active', False):
            st.set_stats_recording(False)
        if st.is_running:
            st.stop_processing()
    with _session_lock:
        pipeline_manager._active_session_source = None
        pipeline_manager._active_session_group = None
        pipeline_manager._active_session_shift_id = None
    _scheduled_stop_time = None


@app.route('/api/session/schedule-stop', methods=['POST'])
def api_session_schedule_stop():
    """Set or clear the auto-stop time. Body: {"stop_at": "HH:MM"} or {"stop_at": null}."""
    global _scheduled_stop_time
    data = request.get_json(force=True, silent=True) or {}
    stop_at = data.get("stop_at")

    # Remove existing job
    try:
        scheduler.remove_job(_scheduled_stop_job_id)
    except Exception:
        pass

    if not stop_at:
        _scheduled_stop_time = None
        print("[SESSION] Auto-stop cancelled")
        return jsonify({"scheduled_stop": None})

    # Parse HH:MM
    try:
        hour, minute = [int(x) for x in stop_at.strip().split(":")]
        assert 0 <= hour <= 23 and 0 <= minute <= 59
    except Exception:
        return jsonify({"error": f"Invalid time format: {stop_at}. Use HH:MM"}), 400

    from apscheduler.triggers.date import DateTrigger
    now = datetime.now(_TUNIS_TZ)
    stop_dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if stop_dt <= now:
        # If time already passed today, schedule for tomorrow
        stop_dt += timedelta(days=1)

    scheduler.add_job(
        _auto_stop_session,
        trigger=DateTrigger(run_date=stop_dt),
        id=_scheduled_stop_job_id,
        replace_existing=True,
    )
    _scheduled_stop_time = stop_dt.isoformat()
    print(f"[SESSION] Auto-stop scheduled for {stop_dt.strftime('%Y-%m-%d %H:%M')}")
    return jsonify({"scheduled_stop": _scheduled_stop_time})


@app.route('/api/session/schedule-stop', methods=['GET'])
def api_session_schedule_stop_get():
    """Read the current scheduled stop time."""
    return jsonify({"scheduled_stop": _scheduled_stop_time})


# ==========================
# DB SESSION QUERY ROUTES
# ==========================

@app.route('/api/stats/sessions')
def api_stats_sessions():
    limit = request.args.get('limit', default=50, type=int)
    if db_writer is None:
        return jsonify({"sessions": []})
    sessions = db_writer.list_grouped_sessions(limit=max(1, min(limit, 500)))
    return jsonify({"sessions": sessions})


@app.route('/api/stats/sessions/raw')
def api_stats_sessions_raw():
    limit = request.args.get('limit', default=50, type=int)
    if db_writer is None:
        return jsonify({"sessions": []})
    sessions = db_writer.list_sessions(limit=max(1, min(limit, 500)))
    return jsonify({"sessions": sessions})


@app.route('/api/stats/session/<session_id>')
def api_stats_session(session_id):
    if db_writer is None:
        return jsonify({}), 404
    data = db_writer.get_session_kpis(session_id)
    if not data:
        return jsonify({}), 404
    return jsonify(data)


@app.route('/api/stats/session/<session_id>/check-changes')
def api_stats_session_check_changes(session_id):
    if db_writer is None:
        return jsonify({"changes": []})
    rows = db_writer.get_check_changes_for_group(session_id)
    return jsonify({"changes": rows})


@app.route('/api/stats/session/<session_id>/crossings')
def api_stats_session_crossings(session_id):
    if db_writer is None:
        return jsonify({"crossings": []})
    limit = request.args.get('limit', default=5000, type=int)
    capped = max(1, min(limit, 10000))
    rows = db_writer.list_crossings_for_group(session_id, limit=capped)
    if not rows:
        rows = db_writer.list_crossings(session_id, limit=capped)
    return jsonify({"crossings": rows})


@app.route('/api/stats/session/<session_id>', methods=['DELETE'])
def api_delete_stats_session(session_id):
    if db_writer is None:
        return jsonify({"error": "db_writer not available"}), 503
    deleted_ids = db_writer.delete_stats_session(session_id)
    if not deleted_ids:
        return jsonify({"error": "Session introuvable ou erreur de suppression"}), 404
    # Remove proof image folders for every individual session in the group
    import shutil
    from helpers import LIVE_IMAGES_ROOT
    for sid in deleted_ids:
        folder = LIVE_IMAGES_ROOT / sid
        if folder.exists():
            try:
                shutil.rmtree(folder)
            except Exception as e:
                print(f"[DELETE] Could not remove proof folder {folder}: {e}")
    return jsonify({"deleted": session_id, "session_ids": deleted_ids})


# ==========================
# REPORTS
# ==========================

def _load_report_summary_or_error():
    if db_writer is None:
        return None, (jsonify({"error": "database not available"}), 503)
    if db_writer.health().get("db") != "ok":
        return None, (jsonify({"error": "database not available"}), 503)

    start_date = (request.args.get("start_date") or "").strip()
    end_date = (request.args.get("end_date") or "").strip()
    if not start_date or not end_date:
        return None, (jsonify({"error": "start_date and end_date are required"}), 400)

    try:
        summary = build_report_summary(db_writer, start_date, end_date)
    except ValueError as exc:
        return None, (jsonify({"error": str(exc)}), 400)
    except Exception as exc:
        print(f"[REPORT] summary error: {exc}")
        return None, (jsonify({"error": "report_generation_failed"}), 500)

    return summary, None


@app.route('/api/reports/summary')
def api_reports_summary():
    summary, error_response = _load_report_summary_or_error()
    if error_response is not None:
        return error_response
    return jsonify(summary)


@app.route('/api/reports/pdf')
def api_reports_pdf():
    summary, error_response = _load_report_summary_or_error()
    if error_response is not None:
        return error_response

    try:
        future = _report_executor.submit(generate_report_pdf, summary)
        pdf_bytes = future.result(timeout=120)
    except Exception as exc:
        print(f"[REPORT] pdf error: {exc}")
        return jsonify({"error": "pdf_generation_failed"}), 500

    start_date = summary["start_date"]
    end_date = summary["end_date"]
    filename = (
        f"rapport_gmcb_{start_date}.pdf"
        if start_date == end_date
        else f"rapport_gmcb_{start_date}_{end_date}.pdf"
    )
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=filename,
        max_age=0,
    )


# ==========================
# PROOF IMAGES
# ==========================

@app.route('/api/proof/<session_id>/<defect_type>/<int:packet_num>')
def api_proof_image(session_id, defect_type, packet_num):
    if defect_type not in ("nobarcode", "nodate", "anomaly"):
        return jsonify({"error": "invalid defect_type"}), 400

    def _related_session_ids(target_session_id):
        candidates = [target_session_id]
        if db_writer is None or not target_session_id:
            return candidates
        try:
            raw = db_writer.get_session_kpis(target_session_id)
        except Exception:
            raw = {}
        group_id = raw.get("group_id") if isinstance(raw, dict) else ""
        if group_id:
            candidates.append(group_id)
        try:
            for row in db_writer.list_sessions(limit=2000):
                row_id = row.get("id")
                row_group = row.get("group_id") or ""
                if row_id == target_session_id and row_group:
                    candidates.append(row_group)
                if row_group == target_session_id and row_id:
                    candidates.append(row_id)
        except Exception:
            pass
        seen = set()
        ordered = []
        for candidate in candidates:
            if candidate and candidate not in seen:
                seen.add(candidate)
                ordered.append(candidate)
        return ordered

    def _candidate_paths(base_dir):
        if defect_type == "anomaly":
            return [
                base_dir / "anomalie" / f"packet_{packet_num}.webp",
                base_dir / "anomalie" / f"packet_{packet_num}.png",
                base_dir / "anomalie" / f"packet_{packet_num}.jpg",
                base_dir / "anomalie" / f"packet_{packet_num}.jpeg",
            ]
        return [
            base_dir / defect_type / f"packet_{packet_num}.webp",
            base_dir / defect_type / f"packet_{packet_num}.png",
            base_dir / defect_type / f"packet_{packet_num}.jpg",
            base_dir / defect_type / f"packet_{packet_num}.jpeg",
        ]

    img_path = None
    for candidate_session_id in _related_session_ids(session_id):
        candidate_base = LIVE_IMAGES_ROOT / candidate_session_id
        for candidate_path in _candidate_paths(candidate_base):
            if candidate_path.is_file():
                img_path = candidate_path
                break
        if img_path is not None:
            break

    if img_path is None:
        return jsonify({"error": "image not found"}), 404

    _mimetypes = {".webp": "image/webp", ".png": "image/png",
                  ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
    mime = _mimetypes.get(img_path.suffix.lower(), "image/webp")
    resp = send_file(img_path, mimetype=mime)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# ==========================
# CONFIG / MISC ROUTES
# ==========================

@app.route('/api/config', methods=['GET', 'POST'])
def api_config():
    if request.method == 'POST':
        data = request.get_json()
        for key, value in data.items():
            if key in CONFIG:
                CONFIG[key] = value
        return jsonify({"status": "updated", "config": CONFIG})
    return jsonify(CONFIG)


@app.route('/api/fifo')
def api_fifo():
    state = _view_state()
    if state is None:
        return jsonify({"fifo": [], "total_packets": 0})
    return jsonify({
        "fifo": list(state.output_fifo),
        "total_packets": state.total_packets
    })


@app.route('/api/rotate', methods=['POST'])
def api_rotate():
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    deg = state.cycle_rotation_ccw()
    return jsonify({"rotation_deg": deg})


# ==========================
# EXIT-LINE CONTROLS
# ==========================

@app.route('/api/exit_line', methods=['POST'])
def api_exit_line_toggle():
    """Toggle the exit-line overlay on/off."""
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    state._exit_line_enabled = not state._exit_line_enabled
    return jsonify({"enabled": state._exit_line_enabled})


@app.route('/api/exit_line_position', methods=['POST'])
def api_exit_line_position():
    """Set exit-line position as a percentage (5-95)."""
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    data = request.get_json(silent=True) or {}
    pct = max(5, min(95, int(data.get("position", state._exit_line_pct))))
    state._exit_line_pct = pct
    # For anomaly mode, also update the checkpoint's zone_end_pct
    # (read every frame by _process_anomaly_frame)
    if state.mode == "anomaly" and state.current_checkpoint:
        state.current_checkpoint["zone_end_pct"] = pct / 100.0
    state._recompute_exit_line_y()
    with state._overlay_lock:
        state._overlay['exit_line_y'] = state._exit_line_y
    return jsonify({"position_pct": pct, "exit_line_y": state._exit_line_y})


@app.route('/api/exit_line_orientation', methods=['POST'])
def api_exit_line_orientation():
    """Toggle exit-line between vertical and horizontal."""
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    state._exit_line_vertical = not state._exit_line_vertical
    state._recompute_exit_line_y()
    with state._overlay_lock:
        state._overlay['exit_line_y'] = state._exit_line_y
    return jsonify({
        "vertical": state._exit_line_vertical,
        "orientation": "vertical" if state._exit_line_vertical else "horizontal",
    })


@app.route('/api/exit_line_invert', methods=['POST'])
def api_exit_line_invert():
    """Toggle exit-line direction (normal / inverted)."""
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    state._exit_line_inverted = not state._exit_line_inverted
    state._recompute_exit_line_y()
    with state._overlay_lock:
        state._overlay['exit_line_y'] = state._exit_line_y
    return jsonify({"inverted": state._exit_line_inverted})


@app.route('/api/checkpoints')
def api_checkpoints():
    return jsonify({"checkpoints": CHECKPOINTS})


@app.route('/api/cameras')
def api_cameras():
    """Return configured cameras with live availability status.

    For each camera the response includes:
      available: bool  — whether /dev/videoN currently exists on the host
      missing:   bool  — inverse, convenience flag for frontend alerts
    """
    import glob as _glob
    existing_devices = set(_glob.glob("/dev/video*"))
    cameras_with_status = []
    for cam in CAMERAS:
        src = cam.get("source")
        dev_path = f"/dev/video{src}" if isinstance(src, int) else str(src)
        available = dev_path in existing_devices
        cameras_with_status.append({**cam, "available": available, "missing": not available})

    all_available = all(c["available"] for c in cameras_with_status)
    missing_cameras = [c["id"] for c in cameras_with_status if c["missing"]]
    return jsonify({
        "cameras": cameras_with_status,
        "all_available": all_available,
        "missing_cameras": missing_cameras,
    })


# ── Camera assignment override helpers ───────────────────────────────────────
_ASSIGNMENTS_FILE = Path(os.environ.get("LIVE_IMAGES_ROOT", "/app/liveImages")).parent / "camera_assignments.json"

def _load_assignments() -> dict:
    """Return {pipeline_id: camera_source} from the persisted override file."""
    try:
        if _ASSIGNMENTS_FILE.exists():
            return json.loads(_ASSIGNMENTS_FILE.read_text())
    except Exception:
        pass
    return {}

def _save_assignments(assignments: dict):
    _ASSIGNMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _ASSIGNMENTS_FILE.write_text(json.dumps(assignments, indent=2))

def _apply_assignments(assignments: dict):
    """Patch in-memory PIPELINES list so every code path sees updated sources."""
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        if pid in assignments:
            pipe_cfg["camera_source"] = assignments[pid]

# Apply persisted overrides immediately at import time
_apply_assignments(_load_assignments())

@app.route('/api/cameras/assignments', methods=['GET'])
def api_camera_assignments_get():
    """Return current pipeline → camera source mapping (with any overrides applied)."""
    return jsonify({
        "assignments": {p["id"]: p["camera_source"] for p in PIPELINES}
    })

@app.route('/api/cameras/assignments', methods=['POST'])
def api_camera_assignments_set():
    """Reassign one or more pipelines to different camera sources.
    Body: { "assignments": { "pipeline_barcode_date": 2, "pipeline_anomaly": 0 } }
    If a pipeline is currently running it will be restarted on the new camera.
    """
    data = request.get_json(force=True, silent=True) or {}
    new_assignments = data.get("assignments", {})
    restart_running = bool(data.get("restart", True))
    if not isinstance(new_assignments, dict) or not new_assignments:
        return jsonify({"error": "assignments dict required"}), 400

    # Validate pipeline ids
    valid_pids = {p["id"] for p in PIPELINES}
    for pid in new_assignments:
        if pid not in valid_pids:
            return jsonify({"error": f"Unknown pipeline: {pid}"}), 400

    # Merge with existing persisted assignments and save
    existing = _load_assignments()
    existing.update(new_assignments)
    _save_assignments(existing)
    _apply_assignments(existing)

    # Phase 1: stop affected pipelines only when the caller wants running
    # pipelines to move immediately. Preview-only swaps persist config without
    # unexpectedly launching cameras/models before the session is confirmed.
    stop_info = {}
    for pid in new_assignments:
        st = pipelines.get(pid)
        if st is None:
            continue
        stop_info[pid] = {
            "was_running": bool(st.is_running),
            "was_recording": bool(getattr(st, '_stats_active', False)),
            "enabled_checks": dict(getattr(st, '_enabled_checks', {"barcode": True, "date": True, "anomaly": True})),
        }
        if restart_running and st.is_running:
            st.stop_processing()

    # Phase 2: restart only pipelines that were already running.
    restarted = []
    for pid, new_src in new_assignments.items():
        st = pipelines.get(pid)
        if st is None:
            continue
        info = stop_info.get(pid, {})
        if not restart_running or not info.get("was_running"):
            continue
        res = st.start_processing(new_src)
        if res.get("status") == "started":
            restarted.append(pid)
        # Re-enable stats recording if it was active
        if info.get("was_recording"):
            group_id = pipeline_manager._active_session_group or ""
            shift_id = pipeline_manager._active_session_shift_id or ""
            st.set_stats_recording(
                True,
                group_id=group_id,
                shift_id=shift_id,
                enabled_checks=info.get("enabled_checks"),
            )

    return jsonify({
        "assignments": {p["id"]: p["camera_source"] for p in PIPELINES},
        "restarted": restarted,
        "restart": restart_running,
    })


@app.route('/api/cameras/detect')
def api_cameras_detect():
    """Probe /dev/video* devices and report which ones OpenCV can open.
    When a pipeline is already holding a camera (V4L2 is exclusive and a
    second open() would fail), we report info from the live pipeline stats
    instead of trying to re-open the device."""
    import glob
    from tracking_config import CAMERA_FPS, CAMERA_WIDTH, CAMERA_HEIGHT
    devices = sorted(glob.glob("/dev/video*"))

    # Build map: camera_index → live stats snapshot (only for running pipelines)
    active_cam_stats: dict = {}
    for pid, state in pipeline_manager._all_states():
        src = state.video_source
        if isinstance(src, int) and state.is_running:
            with state._stats_lock:
                active_cam_stats[src] = dict(state.stats)

    results = []
    for dev in devices:
        try:
            idx = int(dev.replace("/dev/video", ""))
        except ValueError:
            continue

        # Camera is currently held by a running pipeline — use its live stats
        if idx in active_cam_stats:
            s = active_cam_stats[idx]
            results.append({
                "device": dev,
                "index": idx,
                "available": True,
                "in_use": True,
                "width":  s.get("camera_width") or None,
                "height": s.get("camera_height") or None,
                "fps":    s.get("reader_fps") or s.get("video_fps") or None,
                "reader_fps": s.get("reader_fps"),
                "camera_reconnecting": bool(s.get("camera_reconnecting", False)),
                "camera_bw_mbps": s.get("camera_bw_mbps"),
            })
            continue

        # Not in use — try to open it directly
        cap = cv2.VideoCapture(idx, cv2.CAP_V4L2)
        opened = cap.isOpened()
        width = height = fps = None
        if opened:
            # V4L2 order: FOURCC → WIDTH → HEIGHT → FPS (last)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
            cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
            width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps    = cap.get(cv2.CAP_PROP_FPS)
            cap.release()
        results.append({
            "device": dev,
            "index": idx,
            "available": opened,
            "in_use": False,
            "width": width,
            "height": height,
            "fps": round(fps, 1) if fps is not None else None,
            "reader_fps": None,
            "camera_reconnecting": False,
        })

    # Cameras that are actively retrying but whose /dev/video* node has disappeared
    seen_indices = {r["index"] for r in results}
    for idx, s in active_cam_stats.items():
        if idx not in seen_indices and s.get("camera_reconnecting"):
            results.append({
                "device": f"/dev/video{idx}",
                "index": idx,
                "available": False,
                "in_use": True,
                "width": s.get("camera_width") or None,
                "height": s.get("camera_height") or None,
                "fps": None,
                "reader_fps": None,
                "camera_reconnecting": True,
                "camera_bw_mbps": None,
            })

    pipeline_sources = {pid: cfg["camera_source"] for pid, cfg in
                        [(p["id"], p) for p in __import__("tracking_config").PIPELINES]}
    return jsonify({"detected": results, "pipeline_sources": pipeline_sources})


@app.route('/api/switch', methods=['POST'])
def api_switch():
    state = _view_state()
    if state is None:
        return jsonify({"error": "no active pipeline"}), 404
    pid = pipeline_manager.active_view_id
    data = request.get_json() or {}
    new_cp_id  = data.get("checkpoint_id")
    new_cam_id = data.get("camera_id")
    custom_src = data.get("custom_source")

    new_source = None
    if custom_src:
        new_source = custom_src
    elif new_cam_id:
        cam = get_camera(new_cam_id)
        if cam is None:
            return jsonify({"error": f"Unknown camera id: {new_cam_id}"}), 400
        new_source = cam["source"]

    cur_cp_id = pipeline_checkpoint_ids.get(pid, "")
    if new_cp_id is None or new_cp_id == cur_cp_id:
        if new_source and state.is_running:
            # Stop any OTHER pipeline currently holding the target camera source
            # before switching this pipeline to it (V4L2 exclusive access).
            for other_pid, other_st in _all_states():
                if other_pid != pid and other_st.is_running and other_st.video_source == new_source:
                    other_st.stop_processing()
            state.stop_processing()
            state.start_processing(new_source)
        return jsonify({
            "status": "camera_switched",
            "pipeline_id": pid,
            "checkpoint_id": cur_cp_id,
            "source": new_source,
        })

    checkpoint = get_checkpoint(new_cp_id)
    if checkpoint is None:
        return jsonify({"error": f"Unknown checkpoint id: {new_cp_id}"}), 400
    was_running = state.is_running
    prev_source = state.video_source
    result = state.switch_checkpoint(checkpoint)
    pipeline_checkpoint_ids[pid] = new_cp_id
    target_source = new_source or prev_source
    if was_running and target_source:
        state.start_processing(target_source)
    result["source"] = target_source
    result["pipeline_id"] = pid
    return jsonify(result)


# ==========================
# PIPELINES API
# ==========================

@app.route('/api/pipelines')
def api_pipelines():
    result = []
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        cp_id = pipeline_checkpoint_ids.get(pid, "")
        entry = {
            "id": pid,
            "label": pipe_cfg["label"],
            "camera_source": pipe_cfg["camera_source"],
            "checkpoint_id": cp_id,
            "is_running": st.is_running if st else False,
            "stats_active": getattr(st, '_stats_active', False) if st else False,
            "session_id": getattr(st, '_db_session_id', None) if st else None,
            "total_packets": st.total_packets if st else 0,
            "is_active_view": pid == pipeline_manager.active_view_id,
        }
        result.append(entry)
    return jsonify({"pipelines": result, "active_view_id": pipeline_manager.active_view_id})


@app.route('/api/pipelines/<pipeline_id>/view', methods=['POST'])
def api_pipeline_view(pipeline_id):
    if pipeline_id not in pipelines:
        return jsonify({"error": f"Unknown pipeline id: {pipeline_id}"}), 404
    pipeline_manager.active_view_id = pipeline_id
    print(f"[VIEW] Switched active view to {pipeline_id}")
    return jsonify({"active_view_id": pipeline_manager.active_view_id})


@app.route('/api/pipelines/<pipeline_id>/stats')
def api_pipeline_stats(pipeline_id):
    import glob as _g
    def _cam_available(pid):
        cfg = next((p for p in PIPELINES if p["id"] == pid), {})
        src = cfg.get("camera_source")
        if src is None:
            return True
        dev = f"/dev/video{src}" if isinstance(src, int) else str(src)
        return dev in set(_g.glob("/dev/video*"))

    st = pipelines.get(pipeline_id)
    if st is None:
        return jsonify({"pipeline_id": pipeline_id, "is_running": False, "stats_active": False,
                        "total_packets": 0, "packages_ok": 0, "packages_nok": 0,
                        "nok_no_barcode": 0, "nok_no_date": 0, "nok_anomaly": 0,
                        "session_id": None, "checkpoint_label": "",
                        "fifo_queue": [], "perf": {"video_fps": 0, "det_fps": 0, "inference_ms": 0},
                        "camera_available": _cam_available(pipeline_id)})
    cp_id = pipeline_checkpoint_ids.get(pipeline_id, "")
    with st._stats_lock:
        s = dict(st.stats)
    with st._perf_lock:
        perf = dict(st._perf)
    s["pipeline_id"] = pipeline_id
    s["checkpoint_id"] = cp_id
    s["checkpoint_label"] = (st.current_checkpoint or {}).get("label", "")
    s["checkpoint_mode"] = st.mode
    s["is_running"] = st.is_running
    s["stats_active"] = getattr(st, '_stats_active', False)
    s["session_id"] = getattr(st, '_db_session_id', None)
    s["total_packets"] = st.total_packets
    s["nok_no_barcode"] = getattr(st, '_nok_no_barcode', 0)
    s["nok_no_date"] = getattr(st, '_nok_no_date', 0)
    s["nok_anomaly"] = getattr(st, '_nok_anomaly', 0)
    s["fifo_queue"] = list(st.output_fifo)[-20:] if hasattr(st, 'output_fifo') else []
    s["perf"] = perf
    s["exit_line_enabled"] = st._exit_line_enabled
    s["exit_line_pct"] = st._exit_line_pct
    s["exit_line_vertical"] = st._exit_line_vertical
    s["exit_line_inverted"] = st._exit_line_inverted
    # Real DB connectivity check (lightweight SELECT 1)
    if db_writer is not None:
        h = db_writer.health()
        s["db_connected"] = h["db"] == "ok"
    else:
        s["db_connected"] = False
    s["enabled_checks"] = getattr(st, '_enabled_checks', {"barcode": True, "date": True, "anomaly": True})
    s["camera_available"] = _cam_available(pipeline_id)
    return jsonify(s)


@app.route('/api/pipelines/<pipeline_id>/start', methods=['POST'])
def api_pipeline_start(pipeline_id):
    st = pipelines.get(pipeline_id)
    if st is None:
        return jsonify({"error": f"Unknown pipeline id: {pipeline_id}"}), 404
    data = request.get_json(silent=True) or {}
    source = data.get("source")
    new_cp_id = data.get("checkpoint_id")
    if source is None:
        pipe_cfg = next((p for p in PIPELINES if p["id"] == pipeline_id), {})
        source = pipe_cfg.get("camera_source", "0")
    if isinstance(source, str) and source.isdigit():
        source = int(source)
    if new_cp_id and new_cp_id != pipeline_checkpoint_ids.get(pipeline_id):
        cp = get_checkpoint(new_cp_id)
        if cp is None:
            return jsonify({"error": f"Unknown checkpoint_id: {new_cp_id}"}), 400
        if st.is_running:
            st.stop_processing()
        result = st.switch_checkpoint(cp)
        pipeline_checkpoint_ids[pipeline_id] = new_cp_id
        print(f"[{pipeline_id}] Checkpoint switched to {new_cp_id}: {result.get('status')}")
    if st.is_running:
        return jsonify({"error": "already running", "pipeline_id": pipeline_id}), 409
    res = st.start_processing(source)
    res["pipeline_id"] = pipeline_id
    res["checkpoint_id"] = pipeline_checkpoint_ids.get(pipeline_id, "")
    return jsonify(res)


@app.route('/api/pipelines/<pipeline_id>/stop', methods=['POST'])
def api_pipeline_stop(pipeline_id):
    st = pipelines.get(pipeline_id)
    if st is None:
        return jsonify({"error": f"Unknown pipeline id: {pipeline_id}"}), 404
    res = st.stop_processing()
    res["pipeline_id"] = pipeline_id
    return jsonify(res)


@app.route('/api/pipelines/<pipeline_id>/switch', methods=['POST'])
def api_pipeline_switch(pipeline_id):
    st = pipelines.get(pipeline_id)
    if st is None:
        return jsonify({"error": f"Unknown pipeline id: {pipeline_id}"}), 404
    data = request.get_json(silent=True) or {}
    new_cp_id = data.get("checkpoint_id")
    new_source = data.get("source")
    if new_cp_id is None:
        return jsonify({"error": "checkpoint_id is required"}), 400
    cp = get_checkpoint(new_cp_id)
    if cp is None:
        return jsonify({"error": f"Unknown checkpoint_id: {new_cp_id}"}), 400
    if isinstance(new_source, str) and new_source.isdigit():
        new_source = int(new_source)
    prev_source = st.video_source
    was_running = st.is_running
    result = st.switch_checkpoint(cp)
    pipeline_checkpoint_ids[pipeline_id] = new_cp_id
    target_source = new_source or prev_source
    if was_running and target_source:
        st.start_processing(target_source)
    result["pipeline_id"] = pipeline_id
    result["source"] = target_source
    return jsonify(result)


# ==========================
# SHIFTS CRUD
# ==========================
_HH_MM_RE = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')
_VALID_DAYS = {'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'}
_ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _validate_time(value):
    return isinstance(value, str) and _HH_MM_RE.match(value)


def _validate_days(value):
    if not isinstance(value, list) or len(value) == 0:
        return False
    return all(isinstance(d, str) and d.lower() in _VALID_DAYS for d in value)


def _validate_date(value):
    return isinstance(value, str) and _ISO_DATE_RE.match(value)


def _time_order_ok(start, end):
    return start < end


def _time_to_minutes(value):
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _times_overlap(s1, e1, s2, e2):
    """Return True if [s1, e1) and [s2, e2) overlap (HH:MM strings)."""
    a0, a1 = _time_to_minutes(s1), _time_to_minutes(e1)
    b0, b1 = _time_to_minutes(s2), _time_to_minutes(e2)
    return a0 < b1 and b0 < a1


def _one_off_start_already_passed(date_iso, start_time):
    now_tn = datetime.now(_TUNIS_TZ)
    today_tn = now_tn.date().isoformat()
    if date_iso < today_tn:
        return True
    if date_iso > today_tn:
        return False
    return _time_to_minutes(start_time) < (now_tn.hour * 60 + now_tn.minute)


def _date_order_ok(start, end):
    return start <= end


@app.route('/api/shifts', methods=['GET'])
def api_shifts_list():
    if db_writer is None:
        return jsonify({"shifts": []})
    shifts = db_writer.get_all_shifts()
    return jsonify({"shifts": shifts})


@app.route('/api/shifts', methods=['POST'])
def api_shifts_create():
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    data = request.get_json()
    if not data:
        return jsonify({"error": "missing JSON body"}), 400
    label = (data.get("label") or "").strip()
    if not label:
        return jsonify({"error": "label is required"}), 400
    start_time = data.get("start_time", "")
    end_time = data.get("end_time", "")
    if not _validate_time(start_time) or not _validate_time(end_time):
        return jsonify({"error": "start_time and end_time must be HH:MM 24h format"}), 400
    if not _time_order_ok(start_time, end_time):
        return jsonify({"error": "L'heure de début doit être avant l'heure de fin"}), 400
    days_of_week = data.get("days_of_week", [])
    if not _validate_days(days_of_week):
        return jsonify({"error": "days_of_week must be a non-empty array of mon-sun"}), 400
    start_date = data.get("start_date", "")
    end_date = data.get("end_date", "")
    if start_date and not _validate_date(start_date):
        return jsonify({"error": "start_date must be YYYY-MM-DD"}), 400
    if end_date and not _validate_date(end_date):
        return jsonify({"error": "end_date must be YYYY-MM-DD"}), 400
    if start_date and end_date and not _date_order_ok(start_date, end_date):
        return jsonify({"error": "La date de début doit être avant la date de fin"}), 400
    camera_source = str(data.get("camera_source", "0"))
    checkpoint_id = data.get("checkpoint_id", DEFAULT_CHECKPOINT_ID)
    if get_checkpoint(checkpoint_id) is None:
        return jsonify({"error": f"unknown checkpoint_id: {checkpoint_id}"}), 400
    enabled_pipelines = data.get("enabled_pipelines", [p["id"] for p in PIPELINES])
    if not isinstance(enabled_pipelines, list) or len(enabled_pipelines) == 0:
        enabled_pipelines = [p["id"] for p in PIPELINES]
    # enabled_checks: per-class toggles (barcode/date/anomaly)
    raw_ec = data.get("enabled_checks") or {}
    enabled_checks = {
        "barcode": bool(raw_ec.get("barcode", True)),
        "date":    bool(raw_ec.get("date",    True)),
        "anomaly": bool(raw_ec.get("anomaly", True)),
    }
    existing = db_writer.get_all_shifts()
    new_days = set(d.lower() for d in days_of_week)
    for s in existing:
        if s.get("type", "recurring") != "recurring":
            continue
        try:
            ex_days = set(json.loads(s["days_of_week"]))
        except Exception:
            ex_days = set()
        shared = new_days & ex_days
        if not shared:
            continue
        # Exact duplicate check
        if s["start_time"] == start_time and s["end_time"] == end_time:
            return jsonify({"error": f"Un shift identique existe déjà : {s['label']} ({start_time}–{end_time})"}), 409
        # Time-range overlap check
        if _times_overlap(start_time, end_time, s["start_time"], s["end_time"]):
            shared_days = ", ".join(sorted(shared))
            # Build suggestions
            suggestions = []
            if _time_to_minutes(start_time) < _time_to_minutes(s["end_time"]):
                suggestions.append(f"commencer a partir de {s['end_time']}")
            if _time_to_minutes(end_time) > _time_to_minutes(s["start_time"]):
                suggestions.append(f"terminer avant {s['start_time']}")
            hint = " ou ".join(suggestions)
            return jsonify({
                "error": f"Chevauchement avec le shift \u00ab {s['label']} \u00bb "
                         f"({s['start_time']}\u2013{s['end_time']}) "
                         f"les jours : {shared_days}. "
                         f"Suggestion : {hint}.",
                "overlap_with": s["label"],
                "overlap_start": s["start_time"],
                "overlap_end": s["end_time"],
            }), 409
    shift = {
        "id": str(uuid.uuid4()),
        "label": label,
        "start_time": start_time,
        "end_time": end_time,
        "start_date": start_date or None,
        "end_date": end_date or None,
        "days_of_week": json.dumps([d.lower() for d in days_of_week]),
        "camera_source": camera_source,
        "checkpoint_id": checkpoint_id,
        "enabled_pipelines": json.dumps(enabled_pipelines),
        "enabled_checks": json.dumps(enabled_checks),
        "active": 1,
        "created_at": datetime.now(_TUNIS_TZ).replace(tzinfo=None).strftime('%Y-%m-%dT%H:%M:%S'),
    }
    ok = db_writer.insert_shift(shift)
    if not ok:
        return jsonify({"error": "insert failed"}), 500
    _reschedule_shift(shift["id"])
    return jsonify({"shift": shift}), 201


@app.route('/api/shifts/<shift_id>', methods=['PUT'])
def api_shifts_update(shift_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    data = request.get_json()
    if not data:
        return jsonify({"error": "missing JSON body"}), 400
    fields = {}
    if "label" in data:
        label = (data["label"] or "").strip()
        if not label:
            return jsonify({"error": "label cannot be empty"}), 400
        fields["label"] = label
    if "start_time" in data:
        if not _validate_time(data["start_time"]):
            return jsonify({"error": "start_time must be HH:MM"}), 400
        fields["start_time"] = data["start_time"]
    if "end_time" in data:
        if not _validate_time(data["end_time"]):
            return jsonify({"error": "end_time must be HH:MM"}), 400
        fields["end_time"] = data["end_time"]
    resolved_start = fields.get("start_time") or (db_writer.get_shift(shift_id) or {}).get("start_time", "")
    resolved_end = fields.get("end_time") or (db_writer.get_shift(shift_id) or {}).get("end_time", "")
    if resolved_start and resolved_end and not _time_order_ok(resolved_start, resolved_end):
        return jsonify({"error": "L'heure de début doit être avant l'heure de fin"}), 400
    if "days_of_week" in data:
        if not _validate_days(data["days_of_week"]):
            return jsonify({"error": "days_of_week must be a non-empty array of mon-sun"}), 400
        fields["days_of_week"] = json.dumps([d.lower() for d in data["days_of_week"]])
    if "start_date" in data:
        if data["start_date"] and not _validate_date(data["start_date"]):
            return jsonify({"error": "start_date must be YYYY-MM-DD"}), 400
        fields["start_date"] = data["start_date"] or None
    if "end_date" in data:
        if data["end_date"] and not _validate_date(data["end_date"]):
            return jsonify({"error": "end_date must be YYYY-MM-DD"}), 400
        fields["end_date"] = data["end_date"] or None
    resolved_sd = fields.get("start_date") or (db_writer.get_shift(shift_id) or {}).get("start_date", "")
    resolved_ed = fields.get("end_date") or (db_writer.get_shift(shift_id) or {}).get("end_date", "")
    if resolved_sd and resolved_ed and not _date_order_ok(resolved_sd, resolved_ed):
        return jsonify({"error": "La date de début doit être avant la date de fin"}), 400
    if "camera_source" in data:
        fields["camera_source"] = str(data["camera_source"])
    if "checkpoint_id" in data:
        if get_checkpoint(data["checkpoint_id"]) is None:
            return jsonify({"error": f"unknown checkpoint_id: {data['checkpoint_id']}"}), 400
        fields["checkpoint_id"] = data["checkpoint_id"]
    if "enabled_pipelines" in data:
        ep = data["enabled_pipelines"]
        if isinstance(ep, list) and len(ep) > 0:
            fields["enabled_pipelines"] = json.dumps(ep)
    if "enabled_checks" in data:
        raw_ec = data["enabled_checks"]
        if isinstance(raw_ec, dict):
            fields["enabled_checks"] = json.dumps({
                "barcode": bool(raw_ec.get("barcode", True)),
                "date":    bool(raw_ec.get("date",    True)),
                "anomaly": bool(raw_ec.get("anomaly", True)),
            })
    if not fields:
        return jsonify({"error": "no valid fields to update"}), 400
    ok = db_writer.update_shift(shift_id, fields)
    if not ok:
        return jsonify({"error": "update failed"}), 500
    _reschedule_shift(shift_id)
    updated = db_writer.get_shift(shift_id)
    return jsonify({"shift": updated})


@app.route('/api/shifts/<shift_id>', methods=['DELETE'])
def api_shifts_delete(shift_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    _remove_shift_jobs(shift_id)
    ok = db_writer.delete_shift(shift_id)
    if not ok:
        return jsonify({"error": "delete failed"}), 500
    return jsonify({"deleted": True})


@app.route('/api/shifts/<shift_id>/toggle', methods=['POST'])
def api_shifts_toggle(shift_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    new_active = db_writer.toggle_shift(shift_id)
    if new_active is None:
        return jsonify({"error": "toggle failed"}), 500
    _reschedule_shift(shift_id)
    return jsonify({"id": shift_id, "active": new_active})


# ==========================
# SHIFT VARIANTS
# ==========================

@app.route('/api/shifts/<shift_id>/variants', methods=['POST'])
def api_variants_create(shift_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    parent = db_writer.get_shift(shift_id)
    if parent is None:
        return jsonify({"error": "shift not found"}), 404
    if parent.get("type") == "one_off":
        return jsonify({"error": "Les shifts ponctuels ne peuvent pas avoir de personnalisations"}), 400
    data = request.get_json()
    if not data:
        return jsonify({"error": "missing JSON body"}), 400
    kind = data.get("kind", "")
    if kind not in ("timing", "availability"):
        return jsonify({"error": "kind must be 'timing' or 'availability'"}), 400
    start_date = data.get("start_date", "")
    end_date = data.get("end_date", "")
    days_of_week = data.get("days_of_week", [])
    if not start_date or not end_date or not days_of_week:
        return jsonify({"error": "start_date, end_date, days_of_week are required"}), 400
    if not _validate_date(start_date) or not _validate_date(end_date):
        return jsonify({"error": "start_date and end_date must be YYYY-MM-DD"}), 400
    if not _date_order_ok(start_date, end_date):
        return jsonify({"error": "La date de début doit être avant la date de fin"}), 400
    if kind == "timing":
        st = data.get("start_time")
        et = data.get("end_time")
        if st and et and not _time_order_ok(st, et):
            return jsonify({"error": "L'heure de début doit être avant l'heure de fin"}), 400
    variant = {
        "id": str(uuid.uuid4()),
        "shift_id": shift_id,
        "kind": kind,
        "active": data.get("active"),
        "start_time": data.get("start_time"),
        "end_time": data.get("end_time"),
        "start_date": start_date,
        "end_date": end_date,
        "days_of_week": json.dumps([d.lower() for d in days_of_week]),
        "enabled_checks": json.dumps(data["enabled_checks"]) if isinstance(data.get("enabled_checks"), dict) else None,
        "created_at": datetime.now(_TUNIS_TZ).replace(tzinfo=None).strftime('%Y-%m-%dT%H:%M:%S'),
    }
    result = db_writer.insert_variant(variant)
    if result is None:
        return jsonify({"error": "insert failed"}), 500
    return jsonify({"variant": result}), 201


@app.route('/api/shifts/<shift_id>/variants/<variant_id>', methods=['PUT'])
def api_variants_update(shift_id, variant_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    data = request.get_json()
    if not data:
        return jsonify({"error": "missing JSON body"}), 400
    fields = {}
    if "kind" in data:
        if data["kind"] not in ("timing", "availability"):
            return jsonify({"error": "kind must be 'timing' or 'availability'"}), 400
        fields["kind"] = data["kind"]
    for f in ("active", "start_time", "end_time", "start_date", "end_date"):
        if f in data:
            fields[f] = data[f]
    if "days_of_week" in data:
        fields["days_of_week"] = json.dumps([d.lower() for d in data["days_of_week"]])
    if "enabled_checks" in data:
        ec = data["enabled_checks"]
        fields["enabled_checks"] = json.dumps(ec) if isinstance(ec, dict) else None
    if "start_date" in fields and "end_date" in fields:
        if not _date_order_ok(fields["start_date"], fields["end_date"]):
            return jsonify({"error": "La date de début doit être avant la date de fin"}), 400
    if "start_time" in fields and "end_time" in fields:
        if not _time_order_ok(fields["start_time"], fields["end_time"]):
            return jsonify({"error": "L'heure de début doit être avant l'heure de fin"}), 400
    if not fields:
        return jsonify({"error": "no valid fields to update"}), 400
    ok = db_writer.update_variant(variant_id, fields)
    if not ok:
        return jsonify({"error": "update failed"}), 500
    return jsonify({"updated": True})


@app.route('/api/shifts/<shift_id>/variants/<variant_id>', methods=['DELETE'])
def api_variants_delete(shift_id, variant_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    ok = db_writer.delete_variant(variant_id)
    if not ok:
        return jsonify({"error": "delete failed"}), 500
    return jsonify({"deleted": True})


# ==========================
# ONE-OFF SESSIONS
# ==========================

@app.route('/api/one-off-sessions', methods=['GET'])
def api_one_off_list():
    if db_writer is None:
        return jsonify({"sessions": []})
    sessions = db_writer.get_all_one_off_sessions()
    return jsonify({"sessions": sessions})


@app.route('/api/one-off-sessions', methods=['POST'])
def api_one_off_create():
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    data = request.get_json(force=True) or {}
    label = (data.get("label") or "").strip()
    date = (data.get("date") or "").strip()
    start_time = (data.get("start_time") or "").strip()
    end_time = (data.get("end_time") or "").strip()
    end_next_day = bool(data.get("end_next_day", False))
    if not label or not date or not start_time or not end_time:
        return jsonify({"error": "label, date, start_time, end_time are required"}), 400
    if not end_next_day and not _time_order_ok(start_time, end_time):
        return jsonify({"error": "L'heure de début doit être avant l'heure de fin"}), 400
    if _one_off_start_already_passed(date, start_time):
        return jsonify({"error": "Impossible de créer un shift ponctuel si son heure de début est déjà passée"}), 400

    # ── Overlap check: recurring shifts on that day-of-week ──
    from datetime import date as _date_cls
    try:
        target_dow = _date_cls.fromisoformat(date).strftime("%a").lower()[:3]
    except ValueError:
        target_dow = ""
    if target_dow:
        for s in (db_writer.get_all_shifts() or []):
            if s.get("type") == "one_off":
                continue
            if not s.get("active"):
                continue
            try:
                ex_days = set(d.lower()[:3] for d in json.loads(s["days_of_week"]))
            except Exception:
                ex_days = set()
            if target_dow not in ex_days:
                continue
            if _times_overlap(start_time, end_time, s["start_time"], s["end_time"]):
                suggestions = []
                if _time_to_minutes(start_time) < _time_to_minutes(s["end_time"]):
                    suggestions.append(f"commencer à partir de {s['end_time']}")
                if _time_to_minutes(end_time) > _time_to_minutes(s["start_time"]):
                    suggestions.append(f"terminer avant {s['start_time']}")
                hint = " ou ".join(suggestions)
                return jsonify({
                    "error": f"Chevauchement avec le shift récurrent « {s['label']} » "
                             f"({s['start_time']}–{s['end_time']}) le {date}. "
                             f"Suggestion : {hint}."
                }), 409

    # ── Overlap check: other one-offs on the same date ──
    for oo in (db_writer.get_all_one_off_sessions() or []):
        if oo.get("session_date") != date and oo.get("date") != date:
            continue
        oo_start = oo.get("start_time", "")
        oo_end = oo.get("end_time", "")
        if oo_start and oo_end and _times_overlap(start_time, end_time, oo_start, oo_end):
            suggestions = []
            if _time_to_minutes(start_time) < _time_to_minutes(oo_end):
                suggestions.append(f"commencer à partir de {oo_end}")
            if _time_to_minutes(end_time) > _time_to_minutes(oo_start):
                suggestions.append(f"terminer avant {oo_start}")
            hint = " ou ".join(suggestions)
            return jsonify({
                "error": f"Chevauchement avec « {oo.get('label', 'session')} » "
                         f"({oo_start}–{oo_end}) le {date}. "
                         f"Suggestion : {hint}."
            }), 409

    import datetime as _dt
    # Parse enabled_checks for one-off session
    raw_ec = data.get("enabled_checks") or {}
    enabled_checks = {
        "barcode": bool(raw_ec.get("barcode", True)),
        "date":    bool(raw_ec.get("date",    True)),
        "anomaly": bool(raw_ec.get("anomaly", True)),
    }

    session = {
        "id": str(uuid.uuid4()),
        "label": label,
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "camera_source": data.get("camera_source", "0"),
        "checkpoint_id": data.get("checkpoint_id", "tracking"),
        "enabled_checks": json.dumps(enabled_checks),
        "created_at": _dt.datetime.now(_TUNIS_TZ).replace(tzinfo=None).isoformat(),
    }
    result = db_writer.insert_one_off_session(session)
    if result is None:
        return jsonify({"error": "insert failed"}), 500
    _remove_shift_jobs(session["id"])
    from scheduler import _schedule_shift
    _schedule_shift({
        "id": session["id"], "label": label, "type": "one_off",
        "start_time": start_time, "end_time": end_time,
        "session_date": date, "active": 1,
        "enabled_checks": json.dumps(enabled_checks),
    })
    return jsonify({"session": result}), 201


@app.route('/api/one-off-sessions/<session_id>', methods=['PUT'])
def api_one_off_update(session_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    data = request.get_json(force=True) or {}
    start_time = (data.get("start_time") or "").strip() or None
    end_time = (data.get("end_time") or "").strip() or None
    if start_time and end_time and not _time_order_ok(start_time, end_time):
        return jsonify({"error": "L'heure de début doit être avant l'heure de fin"}), 400
    current = db_writer.get_shift(session_id) or {}
    resolved_date = current.get("session_date", "")
    resolved_start = start_time or current.get("start_time", "")
    fields = {}
    if start_time:
        fields["start_time"] = start_time
    if end_time:
        fields["end_time"] = end_time
    if not fields:
        return jsonify({"error": "start_time or end_time required"}), 400
    if resolved_date and resolved_start and _one_off_start_already_passed(resolved_date, resolved_start):
        return jsonify({"error": "Impossible de modifier un shift ponctuel dont l'heure de début est déjà passée"}), 400
    ok = db_writer.update_one_off_session(session_id, fields)
    if not ok:
        return jsonify({"error": "update failed"}), 500
    _reschedule_shift(session_id)
    return jsonify({"updated": True})


@app.route('/api/one-off-sessions/<session_id>', methods=['DELETE'])
def api_one_off_delete(session_id):
    if db_writer is None:
        return jsonify({"error": "database not available"}), 503
    ok = db_writer.delete_one_off_session(session_id)
    if not ok:
        return jsonify({"error": "delete failed"}), 500
    _remove_shift_jobs(session_id)
    return jsonify({"deleted": True})


# ==========================
# MAIN
# ==========================

_shutdown_done = False

def _shutdown():
    """Graceful shutdown: close sessions and stop pipelines."""
    global _shutdown_done
    if _shutdown_done:
        return
    _shutdown_done = True
    for pid, st in _all_states():
        try:
            if getattr(st, '_stats_active', False):
                print(f"[SHUTDOWN][{pid}] Closing active stats session...")
                st.set_stats_recording(False)
        except Exception as e:
            print(f"[SHUTDOWN][{pid}] Error closing session: {e}")
        try:
            if st.is_running:
                st.stop_processing()
        except Exception:
            pass
    try:
        scheduler.shutdown(wait=False)
    except Exception:
        pass
    pipeline_manager._active_session_source = None
    pipeline_manager._active_session_group = None
    pipeline_manager._active_session_shift_id = None
    try:
        if db_writer:
            db_writer.stop()
    except Exception:
        pass
    print("[SHUTDOWN] Cleanup complete.")


def _signal_shutdown(sig, frame):
    _shutdown()
    os._exit(0)  # skip interpreter teardown to avoid CUDA C++ destructor crash


atexit.register(_shutdown)
for _sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(_sig, _signal_shutdown)


def _preview_source_key(source):
    return str(source)

def _normalize_preview_source(source):
    if isinstance(source, str) and source.isdigit():
        return int(source)
    return source


def _capture_preview_jpeg(source, width=640, height=480):
    """Open a camera briefly and return one JPEG frame, without starting models."""
    src = _normalize_preview_source(source)
    cap = cv2.VideoCapture(src, cv2.CAP_V4L2) if isinstance(src, int) else cv2.VideoCapture(src)
    try:
        if not cap.isOpened():
            return None, "camera_unavailable"

        if isinstance(src, int):
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

        frame = None
        for _ in range(8):
            ok, candidate = cap.read()
            if ok and candidate is not None:
                frame = candidate

        if frame is None:
            return None, "no_frame"

        frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            return None, "encode_failed"
        return buf.tobytes(), None
    finally:
        cap.release()


@app.route('/api/system/camera-preview', methods=['GET'])
@app.route('/api/cameras/preview', methods=['GET'])
def api_cameras_preview():
    """Return lightweight snapshots for the configured pipeline cameras."""
    snapshots = {}
    errors = {}
    active_sources = {}

    for _, st in _all_states():
        if st.is_running:
            active_sources[_preview_source_key(st.video_source)] = st

    sources = []
    seen = set()
    for pipe_cfg in PIPELINES:
        source = pipe_cfg.get("camera_source")
        key = _preview_source_key(source)
        if key not in seen:
            seen.add(key)
            sources.append(source)

    for source in sources:
        key = _preview_source_key(source)
        jpeg_bytes = None

        if key in active_sources:
            st = active_sources[key]
            deadline = time.monotonic() + 1.2
            while time.monotonic() < deadline:
                with st._jpeg_lock:
                    jpeg_bytes = st._jpeg_bytes_low or st._jpeg_bytes
                if jpeg_bytes is not None:
                    break
                gevent.sleep(0.05)
            if jpeg_bytes is None:
                errors[key] = "stream_warming_up"
        else:
            jpeg_bytes, error = _capture_preview_jpeg(source)
            if error:
                errors[key] = error

        if jpeg_bytes is not None:
            b64 = base64.b64encode(jpeg_bytes).decode("utf-8")
            snapshots[key] = f"data:image/jpeg;base64,{b64}"

    pipeline_previews = []
    for pipe_cfg in PIPELINES:
        source = pipe_cfg.get("camera_source")
        key = _preview_source_key(source)
        checkpoint = get_checkpoint(pipe_cfg.get("checkpoint_id")) or {}
        pipeline_previews.append({
            "id": pipe_cfg["id"],
            "label": pipe_cfg.get("label", pipe_cfg["id"]),
            "checkpoint_id": pipe_cfg.get("checkpoint_id"),
            "checkpoint_label": checkpoint.get("label", ""),
            "mode": checkpoint.get("mode", ""),
            "camera_source": source,
            "snapshot": snapshots.get(key),
            "available": key in snapshots,
            "error": errors.get(key),
        })

    return jsonify({
        "generated_at": datetime.now(_TUNIS_TZ).isoformat(),
        "snapshots": snapshots,
        "errors": errors,
        "cameras": CAMERAS,
        "pipelines": pipeline_previews,
    })


if __name__ == '__main__':
    init_all_pipelines()

    _load_all_shift_jobs()
    scheduler.add_job(
        cleanup_old_proof_images,
        CronTrigger(hour=3, minute=0, timezone="Africa/Tunis"),
        id="cleanup_proof_images", replace_existing=True,
    )
    scheduler.add_job(
        _feedback_screenshot_cleanup,
        CronTrigger(hour=3, minute=30, timezone="Africa/Tunis"),
        id="cleanup_screenshots", replace_existing=True,
    )
    scheduler.start()
    cleanup_old_proof_images()
    print("[SCHEDULER] APScheduler started")

    print("\n" + "=" * 60)
    print("  MULTI-PIPELINE WEB SERVER STARTED")
    print(f"  {len(pipelines)} pipeline(s) initialized")
    print("  Video stream + YOLO detection run independently")
    print("=" * 60)
    print(f"  http://localhost:{SERVER_PORT}")
    print(f"  http://196.179.229.162:{SERVER_PORT}/")
    print("=" * 60 + "\n")

    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    from gevent.pywsgi import WSGIServer
    http_server = WSGIServer((SERVER_HOST, SERVER_PORT), app, log=None)
    print(f"[SERVER] gevent WSGIServer listening on {SERVER_HOST}:{SERVER_PORT}")
    http_server.serve_forever()
