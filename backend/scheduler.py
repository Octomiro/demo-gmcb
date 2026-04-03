"""Scheduler — APScheduler shift/one-off management and proof image cleanup.

Extracted from web_server_backend_v2.py.  No logic changes — pure move.
"""

import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.jobstores.base import JobLookupError

from tracking_config import PIPELINES, get_checkpoint
from helpers import LIVE_IMAGES_ROOT
from pipeline_manager import (
    db_writer, pipelines, pipeline_checkpoint_ids,
    _all_states,
    _active_session_source, _active_session_group, _active_session_shift_id,
    _session_lock,
)
import pipeline_manager  # for mutable global writes

_TUNIS_TZ = ZoneInfo("Africa/Tunis")

scheduler = BackgroundScheduler(
    daemon=True,
    timezone="Africa/Tunis",
)


def _check_shift_variants(shift_id, today_str):
    """Check shift variants for today's date.
    Returns (should_run: bool, time_override: dict|None).
    """
    variants = db_writer.get_variants_for_shift(shift_id) if db_writer else []
    time_override = None
    for v in variants:
        start_d = v.get("start_date", "")
        end_d = v.get("end_date", "")
        if not (start_d <= today_str <= end_d):
            continue
        dow_raw = v.get("days_of_week", "[]")
        if isinstance(dow_raw, str):
            dow_raw = json.loads(dow_raw)
        if dow_raw:
            from datetime import date as _date
            today_dow = _date.fromisoformat(today_str).strftime("%a").lower()[:3]
            if today_dow not in [d.lower()[:3] for d in dow_raw]:
                continue
        kind = v.get("kind", "")
        if kind == "availability" and not v.get("active"):
            return False, None
        if kind == "timing":
            time_override = {
                "start_time": v.get("start_time"),
                "end_time": v.get("end_time"),
            }
    return True, time_override


def _shift_prewarm(shift_id):
    """Called 2 min before a shift's start_time to warm up pipelines."""
    if db_writer is None:
        return
    shift = db_writer.get_shift(shift_id)
    if not shift or not shift.get("active"):
        return

    label = shift.get("label", shift_id)
    today_str = datetime.now(_TUNIS_TZ).strftime("%Y-%m-%d")
    should_run, _time_ov = _check_shift_variants(shift_id, today_str)
    if not should_run:
        print(f"[PREWARM] Shift '{label}' skipped — disabled by variant for {today_str}")
        return

    print(f"[PREWARM] Shift '{label}' — pre-warming pipelines (2 min before start)")
    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None or st.is_running:
            continue
        cam_src = pipe_cfg["camera_source"]
        cp_id = pipe_cfg["checkpoint_id"]
        cur_cp = pipeline_checkpoint_ids.get(pid, "")
        if cp_id != cur_cp:
            cp = get_checkpoint(cp_id)
            if cp is not None:
                st.switch_checkpoint(cp)
                pipeline_checkpoint_ids[pid] = cp_id
        st.start_processing(cam_src)
        print(f"[PREWARM][{pid}] Pipeline started on {cam_src} (no stats recording)")


def _shift_start(shift_id):
    """Called when a shift's start_time fires. Starts ALL pipelines."""
    import uuid

    if db_writer is None:
        return
    shift = db_writer.get_shift(shift_id)
    if not shift or not shift.get("active"):
        return

    label = shift.get("label", shift_id)

    with _session_lock:
        if pipeline_manager._active_session_source is not None:
            any_live = any(
                st.is_running or getattr(st, '_stats_active', False)
                for _, st in _all_states()
            )
            if any_live:
                print(f"[SCHEDULER] Shift '{label}' skipped — pipelines already active "
                      f"(source={pipeline_manager._active_session_source}, "
                      f"group={(pipeline_manager._active_session_group or '')[:8]})")
                return
            print(f"[SCHEDULER] Shift '{label}' — clearing stale guard "
                  f"(source={pipeline_manager._active_session_source}, no pipelines running)")
            pipeline_manager._active_session_source = None
            pipeline_manager._active_session_group = None
            pipeline_manager._active_session_shift_id = None

        today_str = datetime.now(_TUNIS_TZ).strftime("%Y-%m-%d")
        should_run, _time_ov = _check_shift_variants(shift_id, today_str)
        if not should_run:
            print(f"[SCHEDULER] Shift '{label}' skipped — disabled by variant for {today_str}")
            return

        print(f"[SCHEDULER] Shift '{label}' starting — activating all pipelines")

        group_id = str(uuid.uuid4())
        pipeline_manager._active_session_source = "shift"
        pipeline_manager._active_session_group = group_id
        pipeline_manager._active_session_shift_id = shift_id

    for pipe_cfg in PIPELINES:
        pid = pipe_cfg["id"]
        st = pipelines.get(pid)
        if st is None:
            continue

        cam_src = pipe_cfg["camera_source"]
        cp_id = pipe_cfg["checkpoint_id"]
        cur_cp = pipeline_checkpoint_ids.get(pid, "")
        if cp_id != cur_cp:
            cp = get_checkpoint(cp_id)
            if cp is not None:
                result = st.switch_checkpoint(cp)
                pipeline_checkpoint_ids[pid] = cp_id
                print(f"[SCHEDULER][{pid}] Checkpoint switched to {cp_id}: {result.get('status')}")

        if not st.is_running:
            st.start_processing(cam_src)
            print(f"[SCHEDULER][{pid}] Started on camera {cam_src}")

        if not getattr(st, '_stats_active', False):
            st.set_stats_recording(True, group_id=group_id, shift_id=shift_id)
            print(f"[SCHEDULER][{pid}] Stats recording started (group {group_id[:8]}…)")

    print(f"[SCHEDULER] Shift '{label}' started automatically — all pipelines active")


def _shift_stop(shift_id):
    """Called when a shift's end_time fires. Stops ALL pipelines."""
    if db_writer is None:
        return
    shift = db_writer.get_shift(shift_id)
    label = shift.get("label", shift_id) if shift else shift_id

    with _session_lock:
        if pipeline_manager._active_session_source == "shift" and pipeline_manager._active_session_shift_id != shift_id:
            print(f"[SCHEDULER] Shift '{label}' stop skipped — current session owned by different shift")
            return
        if pipeline_manager._active_session_source == "manual":
            print(f"[SCHEDULER] Shift '{label}' end-of-window — manual session was active, resetting guard")
            pipeline_manager._active_session_source = None
            pipeline_manager._active_session_group = None
            pipeline_manager._active_session_shift_id = None
            return

    print(f"[SCHEDULER] Shift '{label}' stopping — deactivating all pipelines")

    for pid, st in _all_states():
        if getattr(st, '_stats_active', False):
            st.set_stats_recording(False)
            print(f"[SCHEDULER][{pid}] Stats recording stopped")
        if st.is_running:
            st.stop_processing()
            print(f"[SCHEDULER][{pid}] Stopped")

    with _session_lock:
        pipeline_manager._active_session_source = None
        pipeline_manager._active_session_group = None
        pipeline_manager._active_session_shift_id = None

    print(f"[SCHEDULER] Shift '{label}' stopped automatically — all pipelines inactive")


def _remove_shift_jobs(shift_id):
    """Remove start/stop jobs for a shift (if they exist)."""
    for prefix in ("start_", "stop_", "prewarm_"):
        try:
            scheduler.remove_job(f"{prefix}{shift_id}")
        except JobLookupError:
            pass


def _schedule_shift(shift):
    """Add start + stop jobs for one active shift."""
    shift_id = shift["id"]
    shift_type = shift.get("type", "recurring")
    s_hour, s_min = shift["start_time"].split(":")
    e_hour, e_min = shift["end_time"].split(":")

    if shift_type == "one_off":
        session_date = shift.get("session_date", "")
        if not session_date:
            print(f"[SCHEDULER] One-off shift '{shift.get('label', shift_id)}' has no session_date — skipping")
            return
        from datetime import datetime as _dt
        tz = _TUNIS_TZ
        try:
            start_dt = _dt.strptime(f"{session_date} {shift['start_time']}", "%Y-%m-%d %H:%M").replace(tzinfo=tz)
            end_dt = _dt.strptime(f"{session_date} {shift['end_time']}", "%Y-%m-%d %H:%M").replace(tzinfo=tz)
        except ValueError as e:
            print(f"[SCHEDULER] One-off shift date parse error: {e}")
            return
        if end_dt < _dt.now(tz):
            print(f"[SCHEDULER] One-off shift '{shift.get('label', shift_id)}' already past — skipping")
            return
        prewarm_dt = start_dt - timedelta(minutes=2)
        if prewarm_dt > _dt.now(tz):
            scheduler.add_job(
                _shift_prewarm, DateTrigger(run_date=prewarm_dt),
                id=f"prewarm_{shift_id}", args=[shift_id], replace_existing=True,
            )
        scheduler.add_job(
            _shift_start, DateTrigger(run_date=start_dt),
            id=f"start_{shift_id}", args=[shift_id], replace_existing=True,
        )
        scheduler.add_job(
            _shift_stop, DateTrigger(run_date=end_dt),
            id=f"stop_{shift_id}", args=[shift_id], replace_existing=True,
        )
        print(f"[SCHEDULER] Scheduled one-off '{shift.get('label', shift_id)}' "
              f"on {session_date} {shift['start_time']}-{shift['end_time']}")
    else:
        days_raw = shift["days_of_week"]
        if isinstance(days_raw, str):
            days_raw = json.loads(days_raw)
        day_str = ",".join(d.lower() for d in days_raw)
        cron_start = shift.get("start_date") or None
        cron_end = shift.get("end_date") or None
        pre_total = int(s_hour) * 60 + int(s_min) - 2
        if pre_total < 0:
            pre_total += 24 * 60
        pre_hour, pre_min = divmod(pre_total, 60)
        scheduler.add_job(
            _shift_prewarm,
            CronTrigger(day_of_week=day_str, hour=pre_hour, minute=pre_min,
                        timezone="Africa/Tunis",
                        start_date=cron_start, end_date=cron_end),
            id=f"prewarm_{shift_id}", args=[shift_id], replace_existing=True,
        )
        scheduler.add_job(
            _shift_start,
            CronTrigger(day_of_week=day_str, hour=int(s_hour), minute=int(s_min),
                        timezone="Africa/Tunis",
                        start_date=cron_start, end_date=cron_end),
            id=f"start_{shift_id}", args=[shift_id], replace_existing=True,
        )
        scheduler.add_job(
            _shift_stop,
            CronTrigger(day_of_week=day_str, hour=int(e_hour), minute=int(e_min),
                        timezone="Africa/Tunis",
                        start_date=cron_start, end_date=cron_end),
            id=f"stop_{shift_id}", args=[shift_id], replace_existing=True,
        )
        print(f"[SCHEDULER] Scheduled shift '{shift.get('label', shift_id)}' "
              f"{shift['start_time']}-{shift['end_time']} on {day_str}")


def _reschedule_shift(shift_id):
    """Remove then re-add jobs for a shift."""
    _remove_shift_jobs(shift_id)
    if db_writer is None:
        return
    shift = db_writer.get_shift(shift_id)
    if shift and shift.get("active"):
        _schedule_shift(shift)


def _load_all_shift_jobs():
    """Read all active shifts + one-off sessions from DB and schedule them."""
    if db_writer is None:
        print("[SCHEDULER] No DB — skipping shift scheduling")
        return
    shifts = db_writer.get_all_shifts()
    count = 0
    for s in shifts:
        if s.get("active"):
            _schedule_shift(s)
            count += 1
    one_offs = db_writer.get_all_one_off_sessions()
    for oo in one_offs:
        oo_shift = {
            "id": oo["id"],
            "label": oo.get("label", "One-off"),
            "type": "one_off",
            "start_time": oo["start_time"],
            "end_time": oo["end_time"],
            "session_date": oo.get("date", ""),
            "active": 1,
        }
        _schedule_shift(oo_shift)
        count += 1
    print(f"[SCHEDULER] Loaded {count} active job(s) (shifts + one-offs)")


def cleanup_old_proof_images():
    """Delete proof image directories older than 7 days."""
    import shutil
    live_root = LIVE_IMAGES_ROOT
    if not live_root.is_dir():
        return
    cutoff = time.time() - 7 * 86400
    removed = 0
    for entry in live_root.iterdir():
        if not entry.is_dir():
            continue
        try:
            mtime = entry.stat().st_mtime
            if mtime < cutoff:
                shutil.rmtree(entry)
                removed += 1
        except Exception as e:
            print(f"[CLEANUP] Failed to remove {entry.name}: {e}")
    if removed:
        print(f"[CLEANUP] Removed {removed} proof image folder(s) older than 7 days")
