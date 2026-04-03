# Architecture Report — Backend Analysis & Refactoring Plan

**Date:** 2026-04-03  
**Scope:** `tracking_state.py` (1981 lines) + `web_server_backend_v2.py` (1906 lines)  
**Priority:** Real-time detection correctness is #1. Dashboard must never interfere with detection.

---

## 1. CURRENT STATE — WHAT EACH FILE DOES

### `tracking_state.py` — 1981 lines, ONE class `TrackingState`

This single class handles **everything** for a pipeline:

| Responsibility | Lines (approx.) | Description |
|---|---|---|
| **Video capture (Reader thread)** | ~120 lines | Opens USB/RTSP/file, reads frames at native FPS, handles rotation, V4L2/DSHOW |
| **YOLO detection (Detector thread)** | ~450 lines | Runs YOLO + ByteTrack, processes 3 different modes (tracking, date, anomaly) |
| **MJPEG compositing (Compositor thread)** | ~130 lines | Draws bboxes/exit lines/HUD on frames, encodes JPEG |
| **Barcode+Date tracking logic** | ~200 lines | Per-track package state, barcode/date association, exit line crossing, OK/NOK decision |
| **Anomaly detection pipeline** | ~300 lines | EfficientAD crop/mask/batch inference, multi-scan strategy, zone-based workflow |
| **Model loading & switching** | ~120 lines | Load/unload YOLO, secondary model, EfficientAD, warmup |
| **DB session management** | ~80 lines | Open/close sessions, push events to queue, snapshot counters |
| **Proof image saving** | ~80 lines | Save NOK crops to disk via background thread pool |
| **Pause/Resume** | ~100 lines | Pause video, preserve stats, resume from saved position |
| **Exit line geometry** | ~80 lines | Configurable position/orientation/inversion, recompute on rotation |
| **Stats & perf tracking** | ~50 lines | Thread-safe stats dict for API |
| **Utilities** | ~50 lines | IoU, intersection-over-box, rotate frame |

### `web_server_backend_v2.py` — 1906 lines

| Responsibility | Lines (approx.) | Description |
|---|---|---|
| **Flask app + CORS + gevent** | ~30 lines | App setup, monkey patching |
| **Pipeline init** | ~80 lines | Load YOLO models, warm up, create TrackingState per pipeline |
| **JWT auth** | ~80 lines | Login, /me, user CRUD — SHA256 password hashing |
| **MJPEG feed endpoint** | ~60 lines | /video_feed with low-bandwidth options |
| **Pipeline control API** | ~250 lines | /api/start, /stop, /pause, /resume, per-pipeline start/stop/switch |
| **Stats API** | ~120 lines | /api/stats, /api/perf, /api/fifo, /api/stats/status |
| **Session management API** | ~150 lines | /api/session/start, /stop, /status, /reset-guard, toggle |
| **Config/UI API** | ~80 lines | /api/config, /api/exit_line, /api/rotate, /api/checkpoints, /api/cameras |
| **Session history API** | ~60 lines | /api/stats/sessions, crossings, proof images |
| **Shifts CRUD** | ~250 lines | Full CRUD for recurring shifts, validation, duplicate check |
| **Shift variants CRUD** | ~120 lines | Timing/availability overrides |
| **One-off sessions CRUD** | ~90 lines | Single-date sessions |
| **APScheduler** | ~250 lines | Prewarm, start, stop jobs; variant checks; recurring + one-off triggers |
| **Shutdown** | ~40 lines | Graceful cleanup, signal handlers |
| **Main entrypoint** | ~30 lines | Init pipelines, seed users, start scheduler, gevent WSGI |

---

## 2. CORE PROBLEM — WHY THIS IS RISKY FOR PRODUCTION

### 2.1 The detector thread shares a GIL-heavy process with Flask/compositor

The detector thread does:
1. YOLO inference (releases GIL → OK on GPU)
2. ByteTrack post-processing (pure Python → holds GIL)
3. Barcode/date matching loops (pure Python → holds GIL)
4. `output_fifo.count("OK")` on every crossing (O(n) scan of a growing list)
5. DB queue pushes (thread-safe but competes for locks)

Meanwhile the Flask/gevent server:
- Serializes JSON for `/api/stats` (holds GIL)
- Re-encodes JPEG in `/video_feed` if downscaling (heavy CPU, holds GIL)
- Runs APScheduler callbacks on background threads (holds GIL)

**Risk:** On a busy conveyor with many packets, the pure-Python post-processing in the detector competes with Flask JSON serialization and scheduler callbacks for the GIL. This won't cause wrong detections, but can cause **late detections** — the detector skips frames because `_det_event` was set while it was blocked.

### 2.2 Everything shares one `output_fifo` list

`output_fifo` is an unbounded Python list. It grows forever during a session. Every crossing calls `.count("OK")` and `.count("NOK")` which is O(n). After 10,000 packets, this is measurably slow. After 100,000, it becomes a bottleneck inside the detector thread.

### 2.3 The compositor decodes+re-encodes per viewer

When `/video_feed?low=1` is used, the Flask handler decodes the JPEG that the compositor already encoded, resizes it, and re-encodes. This happens **per HTTP response chunk**, blocking a gevent greenlet. With multiple viewers, this multiplies.

### 2.4 Three detection modes are interleaved in one 450-line function

`_detection_loop()` has `if self.mode == "date": ... elif self.mode == "anomaly": ... else (tracking): ...` — the tracking and anomaly paths are each 150-200 lines of deeply nested code inside one function. A bug fix in one mode risks breaking another. The anomaly path has its own zone logic, crop/mask, batched inference, multi-scan state machine — all inline.

### 2.5 JWT secret has a hardcoded fallback

```python
_JWT_SECRET = os.environ.get("JWT_SECRET", "2c6e8bd1080d...")
```
Same vulnerability we fixed for DB credentials. Should crash if missing.

### 2.6 `seed_default_auth_users()` is called at startup

We already removed this from db_writer.py but web_server_backend_v2.py still calls it at line 1891. Will crash. Need to remove.

### 2.7 Session guard uses module-level globals

`_active_session_source`, `_active_session_group`, `_active_session_shift_id` are globals protected by `_session_lock`. This works but is fragile — any unhandled exception in scheduler callbacks can leave the guard stuck.

---

## 3. PROPOSED FILE SPLIT

### Target structure:

```
backend/
├── app.py                    # Flask app, routes, startup (was web_server_backend_v2.py)
│                              # ONLY: route definitions, request parsing, JSON responses
│
├── pipeline_manager.py       # Multi-pipeline orchestration
│                              # init_pipeline(), init_all_pipelines()
│                              # Pipeline registry, view switching, session guard
│
├── detection/
│   ├── __init__.py
│   ├── reader.py             # Video reader thread (_reader_loop)
│   ├── tracker.py            # Barcode+date tracking mode (_detection_loop tracking branch)
│   ├── anomaly_detector.py   # Anomaly detection mode (_detection_loop anomaly branch)
│   ├── compositor.py         # MJPEG compositor thread (_compositor_loop)
│   └── base.py               # Shared state: TrackingState.__init__, stats, reset, 
│                              # exit line geometry, pause/resume, model switching
│
├── anomaly_inference.py      # EfficientAD network definitions + predict() [ALREADY DONE]
├── helpers.py                # BBox metrics, letterbox [ALREADY DONE]
│
├── scheduler.py              # APScheduler: shift start/stop/prewarm, variant checks
│                              # Completely decoupled from Flask routes
│
├── auth.py                   # JWT auth: login, password hashing, token verification
│                              # Middleware decorator for protected routes
│
├── tracking_config.py        # Config [ALREADY DONE]
├── db_writer.py              # Async DB writer [ALREADY DONE]
└── requirements.txt          # [ALREADY DONE]
```

### Why this split protects detection:

| Concern | Current risk | After split |
|---|---|---|
| **GIL contention** | Flask JSON + scheduler + detector all compete | Detection threads live in their own module; Flask does minimal work per request (read pre-computed stats dict) |
| **Code coupling** | Changing compositor drawing code could break anomaly state machine | Each mode is in its own file; compositor only reads overlay dicts |
| **Unbounded list** | `output_fifo.count()` is O(n) inside detector | Replace with running counters (`_ok_count`, `_nok_count`) incremented at crossing time — O(1) |
| **Proof image I/O** | `cv2.imwrite` in thread pool but sharing executor with model inference | Keep separate executor; proof saving never touches detection data after snapshot |
| **Scheduler race** | Guard globals can get stuck | Scheduler module owns its state cleanly; guard reset is automatic on stale detection |

---

## 4. WHAT CHANGES IN EACH FILE (detailed)

### 4.1 `detection/base.py` — TrackingState core (~300 lines)

Extracted from current `tracking_state.py`:
- `__init__()` — all state variables
- `_empty_overlay()`, `_empty_stats()`, `_empty_perf()`
- `_reset_session()`, `_reset_session_for_resume()`
- `start_processing()`, `stop_processing()`, `pause_processing()`, `resume_processing()`
- `switch_checkpoint()`
- `set_stats_recording()`, `_db_totals()`
- `cycle_rotation_ccw()`, `_recompute_exit_line_y()`
- Exit line geometry helpers
- `_compute_iou()`, `_intersection_over_box()`, `_det_box_matches_package()`

**No logic changes.** Pure extraction.

### 4.2 `detection/reader.py` — Video reader thread (~100 lines)

Extracted: `_reader_loop()` as a standalone function that takes a `TrackingState` reference.

**No logic changes.** Only the function signature changes.

### 4.3 `detection/tracker.py` — Barcode+date tracking mode (~250 lines)

Extracted: the "tracking" branch from `_detection_loop()`, plus the exit-line crossing block.
Also responsible for secondary date model parallel inference.

**Improvement:** Replace `output_fifo.count("OK")` with `self._ok_count += 1` at crossing time, read counter instead of scanning.

### 4.4 `detection/anomaly_detector.py` — Anomaly detection mode (~350 lines)

Extracted: the "anomaly" branch from `_detection_loop()`, plus:
- `_load_ad_models()`
- `_ad_crop_and_mask()`
- `_ad_detect_anomaly()`, `_ad_detect_anomaly_batch()`
- `_ad_final_decision()`
- `_save_nok_packet()`, `_save_nok_packet_bg()`

**No logic changes.** The anomaly state machine, zone logic, and multi-scan strategy remain identical.

### 4.5 `detection/compositor.py` — MJPEG compositor (~130 lines)

Extracted: `_compositor_loop()`.

**Improvement:** Move the low-bandwidth re-encoding logic here (currently in Flask route) so it's done once for all viewers at a given quality level, not per-request.

### 4.6 `pipeline_manager.py` — Orchestration (~100 lines)

Extracted from `web_server_backend_v2.py`:
- `init_pipeline()`, `init_all_pipelines()`
- Pipeline registry (`pipelines` dict, `pipeline_checkpoint_ids`)
- `_view_state()`, `_all_states()`
- Session guard (`_active_session_source`, etc.)

### 4.7 `scheduler.py` — APScheduler (~250 lines)

Extracted from `web_server_backend_v2.py`:
- `_shift_prewarm()`, `_shift_start()`, `_shift_stop()`
- `_check_shift_variants()`
- `_schedule_shift()`, `_reschedule_shift()`, `_remove_shift_jobs()`
- `_load_all_shift_jobs()`
- Scheduler instance

### 4.8 `auth.py` — Authentication (~80 lines)

Extracted from `web_server_backend_v2.py`:
- `_verify_password()`, `_hash_password()`
- JWT secret (from env, no fallback)
- Login, /me endpoints (as a Flask Blueprint)
- User CRUD endpoints

### 4.9 `app.py` — Flask routes only (~400 lines)

What remains after extraction:
- Flask app creation, CORS
- Import blueprints (auth)
- Import pipeline_manager
- Route definitions: start/stop/pause/resume, stats, config, shifts, one-offs
- Each route is a thin wrapper: parse request → call manager/state method → return JSON
- `_shutdown()`, signal handlers
- `if __name__ == '__main__'` entrypoint

---

## 5. THINGS TO FIX DURING THE SPLIT

### 5.1 Critical fixes

| # | Issue | File | Fix |
|---|---|---|---|
| 1 | `output_fifo.count()` is O(n) inside detector | tracking_state.py | Replace with `_ok_count`/`_nok_count` integer counters |
| 2 | Hardcoded JWT secret fallback | web_server_backend_v2.py | `os.environ["JWT_SECRET"]` (crash if missing) |
| 3 | `seed_default_auth_users()` call at startup | web_server_backend_v2.py:1891 | Remove (function no longer exists) |
| 4 | `from db_config import SNAPSHOT_EVERY_N_PACKETS` | tracking_state.py:13 | Change to `from db_writer import SNAPSHOT_EVERY_N_PACKETS` |
| 5 | `from anomaly_on_video import get_ad_constants` | tracking_state.py:247 | Change to `from anomaly_inference import get_ad_constants` |
| 6 | `from efficientad import predict as effpredict` | tracking_state.py (3 places) | Change to `from anomaly_inference import predict as effpredict` |
| 7 | `_DB_AVAILABLE` try/except fallback | tracking_state.py:12-18 | Remove fallback — db_writer is always available |
| 8 | `MODEL_PATH, PACKAGE_CLASS_NAME, BARCODE_CLASS_NAME` imports | web_server_backend_v2.py:33 | Remove (already deleted from tracking_config.py) |

### 5.2 Performance improvements

| # | Improvement | Impact |
|---|---|---|
| 1 | Replace `output_fifo` list with deque(maxlen=20) + running counters | O(1) instead of O(n) in detector thread |
| 2 | Move low-bandwidth JPEG re-encoding from Flask route to compositor | Done once, not per-viewer |
| 3 | Pre-compute `ok_count`/`nok_count` instead of calling `.count()` | Eliminates repeated list scans |

### 5.3 Things NOT to change

| Item | Why keep it |
|---|---|
| 3-thread architecture (reader/detector/compositor) | Proven to work; keeps stream smooth regardless of YOLO speed |
| ByteTrack via Ultralytics `.track()` | Stable, GPU-accelerated |
| `_det_event` / `_raw_changed` threading events | Correct wake/sleep pattern |
| `_session_gen` counter for thread lifecycle | Prevents race conditions on camera switch |
| `_raw_history` deque for compositor sync | Eliminates visual bbox shift on moving conveyor |
| Anomaly multi-scan strategy & zone logic | Core business logic, battle-tested |
| Proof image saving via ThreadPoolExecutor | Non-blocking, bounded, correct |
| gevent WSGI with monkey_patch(thread=False) | Required for CUDA + Flask coexistence |
| Session guard mutex pattern | Prevents scheduler/manual collisions |

---

## 6. MIGRATION ORDER

| Step | Action | Files touched |
|---|---|---|
| 1 | Fix critical imports (5.1 #4-8) in current tracking_state.py + web_server_backend_v2.py | 2 files |
| 2 | Fix JWT secret + remove seed call (5.1 #2-3) | 1 file |
| 3 | Extract `detection/base.py` from TrackingState | New file + tracking_state.py |
| 4 | Extract `detection/reader.py` | New file |
| 5 | Extract `detection/tracker.py` + fix output_fifo (5.2 #1) | New file |
| 6 | Extract `detection/anomaly_detector.py` | New file |
| 7 | Extract `detection/compositor.py` | New file |
| 8 | Create `tracking_state.py` as thin import that re-exports TrackingState | tracking_state.py |
| 9 | Extract `pipeline_manager.py` | New file |
| 10 | Extract `scheduler.py` | New file |
| 11 | Extract `auth.py` | New file |
| 12 | Reduce web_server_backend_v2.py → `app.py` | Rename + trim |
| 13 | Syntax-check all files | `python3 -c "import ast; ..."` |
| 14 | Integration test: start server, verify /video_feed + /api/stats | Manual |

Each step is independently testable. If step N breaks, we can revert just that step.

---

## 7. QUESTIONS FOR YOU BEFORE WE START

1. **Date-only mode**: The `date` checkpoint/mode seems like a debugging tool (no tracking, no counting). Is it used in production or can we remove it?

2. **Video file playback**: `_reader_loop` has logic for `.mp4` files (looping, seeking, FPS pacing). Is this only for development/demo or does production ever process recorded files?

3. **`/api/config` POST endpoint**: This lets anyone change `conf_paquet`, `conf_barcode`, etc. at runtime via HTTP with no auth. Is this intentional or should it be admin-only/removed?

4. **Proof image storage**: Currently saves PNGs to `liveImages/<session>/`. In production with 24/7 operation, this will fill disk. Do you have a cleanup strategy, or should we add one?

5. **Exit line UI controls** (`/api/exit_line`, `/api/rotate`, `/api/exit_line_position`): Are these used by the dashboard in production, or only during setup? This determines whether they go in app.py or a separate calibration module.

6. **`/video_feed` low-bandwidth mode**: Is this actively used (remote monitoring), or was it experimental? This determines whether we optimize it or remove it.

---

## 8. ANSWERS & DECISIONS

| # | Question | Answer | Decision |
|---|---|---|---|
| 1 | Date-only mode | Was initial mode before barcode+date was found. No longer used. | **REMOVE** `"date"` checkpoint & `mode == "date"` branch from detector |
| 2 | Video file playback | Production is live cameras only. Playback was for dev/testing. | **REMOVE** all `.mp4` file logic: seeking, looping, FPS pacing, `_is_video_file`, `VIDEO_EXTENSIONS`, pause/resume for video files |
| 3 | `/api/config` POST | No role logic yet, keep open for now | **KEEP** as-is for now. Will add auth middleware later when roles are implemented. |
| 4 | Proof images | Switch to WebP, add 7-day auto-cleanup | **CHANGE** PNG → WebP. Add scheduled cleanup job (daily, delete images older than 7 days). |
| 5 | Exit line UI controls | Were used during training/testing only. Exit line params are already baked into each checkpoint in `tracking_config.py`. | **REMOVE** `/api/exit_line`, `/api/exit_line_orientation`, `/api/exit_line_invert`, `/api/exit_line_position`, `/api/rotate`. Exit line geometry is set per-checkpoint at model load time. |
| 6 | `/video_feed` low-bandwidth mode | Question was: does anyone view the MJPEG stream remotely at reduced quality? | **KEEP** — The `?low=1` mode is useful if someone views the stream over a slower network. We'll optimize it (move re-encoding to compositor) but keep the feature. |

---

## 9. COUNTING & DOUBLE-COUNTING PROBLEM

### How counting works today

Each pipeline has its own `TrackingState` with independent counters:

```
pipeline_barcode_date (cam0)     pipeline_anomaly (cam2)
├── total_packets = 150          ├── total_packets = 148
├── output_fifo = [OK,NOK,OK..] ├── output_fifo = [OK,OK,NOK..]
├── _nok_no_barcode = 3          ├── _nok_anomaly = 5
└── _nok_no_date = 2             └── (no barcode/date counts)
```

When stats recording starts, both pipelines open a DB session linked by the same `group_id`:
```
sessions table:
  id=aaa  group_id=GRP1  checkpoint_id=barcode_date  total=150  ok=145  nok_no_barcode=3  nok_no_date=2
  id=bbb  group_id=GRP1  checkpoint_id=anomaly        total=148  ok=143  nok_anomaly=5
```

### The bug: `list_grouped_sessions()` SUMS across pipelines

```python
g["total"] += r.get("total") or 0        # 150 + 148 = 298  ← WRONG (real packets: ~150)
g["ok_count"] += r.get("ok_count") or 0  # 145 + 143 = 288  ← WRONG
```

The dashboard shows ~298 total packets when the real count is ~150. The NOK breakdowns (`nok_no_barcode`, `nok_no_date`, `nok_anomaly`) are correct individually but the totals are inflated.

### The fix: DON'T sum totals — use the barcode_date pipeline as the authoritative packet counter

The `barcode_date` pipeline is the one that tracks actual physical packets crossing the exit line. It sees every packet and counts it exactly once. The `anomaly` pipeline also sees the same packets but its purpose is anomaly detection, not counting.

**Solution:**
- `list_grouped_sessions()` should take `total` and `ok_count` from the **barcode_date session only** (the tracking pipeline)
- NOK breakdowns are additive across pipelines (each pipeline detects different defects):
  - `nok_no_barcode` → from barcode_date pipeline
  - `nok_no_date` → from barcode_date pipeline  
  - `nok_anomaly` → from anomaly pipeline
- The dashboard shows: `total = barcode_date.total`, `nok = nok_no_barcode + nok_no_date + nok_anomaly`

### Ejection logic: OR — any pipeline flags NOK → eject

You're right. Each pipeline writes its own `defective_packets` rows independently:
- `pipeline_barcode_date` writes: `defect_type = "nobarcode"` or `"nodate"`
- `pipeline_anomaly` writes: `defect_type = "anomaly"`

The ejector watches the `defective_packets` table (or a direct signal from either pipeline). If EITHER pipeline flags a packet as defective, it gets ejected. No AND logic needed — they detect **different defects**, not the same defect twice.

The `crossed_at` timestamp + known physical position of each pipeline's exit line on the real conveyor gives you the timing for when to fire the ejector.

---

## 10. SUMMARY OF BIG CHANGES

### What gets REMOVED (dead code cleanup)

| Removed | Why |
|---|---|
| `mode == "date"` detection branch + `"date"` checkpoint | No longer used; was initial experiment |
| Video file playback (`.mp4` seeking, looping, FPS pacing) | Production = live cameras only |
| `pause_processing()` / `resume_processing()` for video files | Only made sense for file playback |
| `_is_video_file`, `VIDEO_EXTENSIONS`, `_paused_frame_pos`, `_paused_source` | Related to file playback |
| `/api/exit_line`, `/api/exit_line_orientation`, `/api/exit_line_invert`, `/api/exit_line_position` | Exit line params baked into checkpoint config |
| `/api/rotate` | Rotation baked into checkpoint config (or not needed) |
| `seed_default_auth_users()` call | Already removed from db_writer |
| `MODEL_PATH`, `PACKAGE_CLASS_NAME`, `BARCODE_CLASS_NAME` imports | Already removed from tracking_config |
| `_DB_AVAILABLE` fallback / SQLite fallback | postgres-only now |
| `from db_config import ...` | File deleted, inlined to db_writer |
| `from efficientad import ...` / `from anomaly_on_video import ...` | Replaced by `anomaly_inference` |
| PNG proof images | Replaced with WebP |

### What gets CHANGED (improvements)

| Change | Why |
|---|---|
| `output_fifo` → `deque(maxlen=20)` + `_ok_count`/`_nok_count` counters | O(1) instead of O(n) in detector thread |
| Proof images: PNG → WebP | ~60-70% smaller files, faster dashboard loading |
| 7-day auto-cleanup for proof images | Prevent disk fill on 24/7 production |
| `list_grouped_sessions()` counting fix | Don't double-count packets across pipelines |
| JWT secret: hardcoded fallback → `os.environ["JWT_SECRET"]` | Security fix |
| Low-bandwidth MJPEG re-encoding moved to compositor | Done once, not per-viewer |

### What STAYS EXACTLY THE SAME (battle-tested detection logic)

| Kept | Why |
|---|---|
| 3-thread architecture (reader/detector/compositor) | Proven smooth stream + parallel YOLO |
| ByteTrack tracking via `.track()` | Stable, GPU-accelerated |
| Barcode+date association logic (IoU + inside check) | Core production logic |
| Anomaly multi-scan strategy (zone, crop, batch, MAJORITY) | Core production logic |
| Secondary date model parallel inference | Maximizes accuracy |
| Session guard (scheduler vs manual collision prevention) | Required for shift automation |
| gevent WSGI + `monkey_patch(thread=False)` | Required for CUDA + Flask |

### Architecture: Services vs Endpoints (Controllers)

**"Services" (business logic — never import Flask):**

| Service | File | Responsibility |
|---|---|---|
| Detection Engine | `detection/base.py` | TrackingState class — lifecycle, model switching, state |
| Video Reader | `detection/reader.py` | Camera capture thread |
| Barcode+Date Tracker | `detection/tracker.py` | Tracking mode detection + exit line crossing |
| Anomaly Detector | `detection/anomaly_detector.py` | EfficientAD mode detection |
| Compositor | `detection/compositor.py` | MJPEG frame encoding |
| Pipeline Manager | `pipeline_manager.py` | Multi-pipeline init, registry, session guard |
| Scheduler | `scheduler.py` | APScheduler shift automation |
| DB Writer | `db_writer.py` | Async database operations [DONE] |
| Anomaly Inference | `anomaly_inference.py` | EfficientAD networks + predict [DONE] |
| Auth Service | `auth.py` | Password hashing, JWT token create/verify |

**"Controllers" (Flask endpoints — thin wrappers that call services):**

All in `app.py`:

| Endpoint Group | Routes | Calls |
|---|---|---|
| Stream | `GET /video_feed` | reads `TrackingState._jpeg_bytes` |
| Pipeline Control | `POST /api/start`, `/stop`, `/pause`, `/resume` | `pipeline_manager` → `TrackingState` |
| Per-Pipeline | `POST /api/pipelines/<id>/start`, `/stop`, `/switch` | `pipeline_manager` → `TrackingState` |
| Stats | `GET /api/stats`, `/perf`, `/fifo`, `/stats/status` | reads `TrackingState.stats` dict |
| Session | `POST /api/session/start`, `/stop`, `/status`, `/reset-guard` | `pipeline_manager` session guard |
| Recording | `POST /api/stats/toggle` | `TrackingState.set_stats_recording()` |
| History | `GET /api/stats/sessions`, `/session/<id>`, `/crossings` | `db_writer` queries |
| Proof Images | `GET /api/proof/<session>/<defect>/<num>` | static file serve |
| Config | `GET/POST /api/config` | reads/writes `CONFIG` dict |
| Checkpoints | `GET /api/checkpoints`, `/cameras`, `/pipelines` | reads config |
| Shifts CRUD | `GET/POST/PUT/DELETE /api/shifts/...` | `db_writer` + `scheduler` |
| One-offs CRUD | `GET/POST/PUT/DELETE /api/one-off-sessions/...` | `db_writer` + `scheduler` |
| Auth | `POST /api/auth/login`, `GET /api/auth/me`, CRUD `/api/auth/users` | `auth` service |
| Health | `GET /api/health` | `db_writer.health()` |
