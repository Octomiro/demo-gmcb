import os
import queue
import threading
import time
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool

# ── DB connection (from environment, set in docker-compose.yml) ──
DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", "5434"))
DB_NAME = os.environ.get("DB_NAME", "farine_detection")
DB_USER = os.environ.get("DB_USER", "farine_khomsa")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "aa")

# ── Async writer settings ──
STATS_ENABLED_DEFAULT = False
SNAPSHOT_EVERY_N_PACKETS = 25
WRITE_QUEUE_MAXSIZE = 10000

_TUNIS_TZ = ZoneInfo("Africa/Tunis")


def _ts():
    return datetime.now(_TUNIS_TZ).replace(tzinfo=None).isoformat(timespec='seconds')


class DBWriter:
    def __init__(self):
        self.write_queue = queue.Queue(maxsize=WRITE_QUEUE_MAXSIZE)
        self._thread = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._active = STATS_ENABLED_DEFAULT
        self._current_session_id = None
        self._pg_pool = None

        self._available = self._connect()

    def _connect(self):
        """Open the connection pool and verify connectivity. Returns True on success."""
        try:
            self._pg_pool = ThreadedConnectionPool(
                minconn=1, maxconn=5,
                host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                user=DB_USER, password=DB_PASSWORD,
                connect_timeout=5,
            )
            # Verify and close zombie sessions left from a previous crash
            conn = self._pg_pool.getconn()
            try:
                self.close_zombie_sessions_pg(conn)
            finally:
                self._pg_pool.putconn(conn)
            print("[DBWriter] Backend: PostgreSQL — connected.")
            return True
        except Exception as e:
            print(f"[DBWriter] FATAL: PostgreSQL unreachable — {e}")
            return False

    def close_zombie_sessions_pg(self, conn):
        """Mark sessions that were never closed (server crash / kill) as interrupted."""
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE sessions SET ended_at = %s WHERE ended_at IS NULL",
                    ("interrupted:" + _ts(),),
                )
            conn.commit()
        except Exception as e:
            print(f"[DBWriter] zombie-session cleanup (PG) error: {e}")

    def start(self):
        if not self._available or (self._thread and self._thread.is_alive()):
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="DBWriter")
        self._thread.start()
        print("[DBWriter] Writer thread started.")

    def stop(self):
        self._stop_event.set()
        try:
            self.write_queue.put_nowait({"type": "stop"})
        except queue.Full:
            pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
        if self._pg_pool:
            try:
                self._pg_pool.closeall()
            except Exception:
                pass

    def set_active(self, active):
        with self._lock:
            self._active = bool(active)

    @property
    def is_active(self):
        with self._lock:
            return self._active

    @property
    def current_session_id(self):
        with self._lock:
            return self._current_session_id

    @property
    def backend(self):
        return "postgres"

    def open_session(self, checkpoint_id="", camera_source="", group_id="", shift_id=""):
        sid = str(uuid.uuid4())
        with self._lock:
            self._current_session_id = sid
        conn = self._get_pg_conn()
        if conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO sessions (id, group_id, shift_id, started_at, checkpoint_id, camera_source) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        (sid, group_id, shift_id, _ts(), checkpoint_id, camera_source),
                    )
                conn.commit()
            except Exception as e:
                print(f"[DBWriter] open_session error: {e}")
            finally:
                self._release_pg_conn(conn)
        return sid

    def close_session(self, session_id, totals=None, end_reason=None):
        if not self._available or not session_id:
            return
        totals = totals or {}
        ts = _ts()
        ended_at = f"{end_reason}:{ts}" if end_reason else ts
        params = (
            ended_at,
            totals.get("total", 0),
            totals.get("ok_count", 0),
            totals.get("nok_no_barcode", 0),
            totals.get("nok_no_date", 0),
            totals.get("nok_anomaly", 0),
            session_id,
        )
        conn = self._get_pg_conn()
        if conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE sessions SET ended_at=%s, total=%s, ok_count=%s, "
                        "nok_no_barcode=%s, nok_no_date=%s, nok_anomaly=%s WHERE id=%s",
                        params,
                    )
                conn.commit()
            except Exception as e:
                print(f"[DBWriter] close_session error: {e}")
            finally:
                self._release_pg_conn(conn)
        with self._lock:
            if self._current_session_id == session_id:
                self._current_session_id = None

    def get_session_kpis(self, session_id):
        if not self._available or not session_id:
            return {}
        conn = self._get_pg_conn()
        if not conn:
            return {}
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM sessions WHERE id = %s", (session_id,))
                row = cur.fetchone()
                return dict(row) if row else {}
        except Exception as e:
            print(f"[DBWriter] get_session_kpis error: {e}")
            return {}
        finally:
            self._release_pg_conn(conn)

    def list_sessions(self, limit=50):
        if not self._available:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, group_id, shift_id, started_at, ended_at, checkpoint_id, camera_source, "
                    "total, ok_count, nok_no_barcode, nok_no_date, nok_anomaly "
                    "FROM sessions ORDER BY started_at DESC LIMIT %s",
                    (limit,),
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] list_sessions error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def list_crossings(self, session_id, limit=5000):
        if not self._available or not session_id:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, session_id, packet_num, defect_type, crossed_at "
                    "FROM defective_packets WHERE session_id = %s ORDER BY packet_num ASC LIMIT %s",
                    (session_id, limit),
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] list_crossings error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def list_grouped_sessions(self, limit=50):
        """Return sessions merged by group_id.

        Sessions that share a group_id (started by the same toggleRecording call)
        are collapsed into one logical row.

        Counting logic:
        - total and ok_count come from the tracking pipeline only (the one
          that counts physical packets crossing the exit line). The anomaly
          pipeline sees the same packets so summing would double-count.
        - NOK breakdowns are additive: each pipeline detects different defects
          (barcode_date → nobarcode/nodate, anomaly → anomaly).
        """
        rows = self.list_sessions(limit=limit * 4)  # fetch more to cover all pipelines per group
        from collections import OrderedDict
        groups: OrderedDict = OrderedDict()
        # Checkpoint modes that count physical packets (authoritative for total/ok)
        _COUNTING_MODES = {"barcode_date", "tracking"}
        for r in rows:
            gid = r.get("group_id") or r["id"]  # no group → treat as own group
            if gid not in groups:
                groups[gid] = {
                    "id": gid,
                    "shift_id": r.get("shift_id", ""),
                    "started_at": r["started_at"],
                    "ended_at": r.get("ended_at"),
                    "total": 0,
                    "ok_count": 0,
                    "nok_no_barcode": 0,
                    "nok_no_date": 0,
                    "nok_anomaly": 0,
                    "checkpoint_ids": [],
                    "session_ids": [],
                    "sessions": [],
                }
            g = groups[gid]
            cp = r.get("checkpoint_id", "")
            # Only the tracking pipeline is authoritative for total / ok_count
            if cp in _COUNTING_MODES or not cp:
                g["total"] += r.get("total") or 0
                g["ok_count"] += r.get("ok_count") or 0
            # NOK breakdowns are additive across all pipelines
            g["nok_no_barcode"] += r.get("nok_no_barcode") or 0
            g["nok_no_date"] += r.get("nok_no_date") or 0
            g["nok_anomaly"] += r.get("nok_anomaly") or 0
            if cp and cp not in g["checkpoint_ids"]:
                g["checkpoint_ids"].append(cp)
            g["session_ids"].append(r["id"])
            g["sessions"].append(r)
            # earliest start / latest end
            if r["started_at"] and (not g["started_at"] or r["started_at"] < g["started_at"]):
                g["started_at"] = r["started_at"]
            if r.get("ended_at") and (not g["ended_at"] or r["ended_at"] > g["ended_at"]):
                g["ended_at"] = r["ended_at"]
        return list(groups.values())[:limit]

    def list_crossings_for_group(self, group_id, limit=5000):
        """Return crossings across all sessions in a group."""
        if not self._available or not group_id:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT dp.id, dp.session_id, dp.packet_num, dp.defect_type, dp.crossed_at "
                    "FROM defective_packets dp "
                    "JOIN sessions s ON s.id = dp.session_id "
                    "WHERE s.group_id = %s "
                    "ORDER BY dp.crossed_at ASC LIMIT %s",
                    (group_id, limit),
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] list_crossings_for_group error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def get_hourly_stats(self, session_id):
        """Return per-hour conformity stats for a session."""
        if not self._available or not session_id:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                # Get session info
                cur.execute(
                    "SELECT started_at, ended_at, total, ok_count FROM sessions WHERE id = %s",
                    (session_id,),
                )
                sess = cur.fetchone()
                if not sess:
                    return []

                # Count defects grouped by hour
                cur.execute(
                    "SELECT EXTRACT(HOUR FROM crossed_at::timestamp)::int AS hour, "
                    "COUNT(*) AS defect_count, "
                    "SUM(CASE WHEN defect_type = 'anomaly' THEN 1 ELSE 0 END)::int AS anomaly_count "
                    "FROM defective_packets WHERE session_id = %s "
                    "GROUP BY hour ORDER BY hour",
                    (session_id,),
                )
                defect_rows = {int(r["hour"]): dict(r) for r in cur.fetchall()}

                # Count ALL crossings (ok + nok) per hour from a crossing log
                # Since we only log defective packets, we derive from session totals
                # Use session start/end to figure out which hours are active
                cur.execute(
                    "SELECT EXTRACT(HOUR FROM crossed_at::timestamp)::int AS hour, COUNT(*) AS cnt "
                    "FROM defective_packets WHERE session_id = %s GROUP BY hour ORDER BY hour",
                    (session_id,),
                )

                started = sess.get("started_at")
                ended = sess.get("ended_at")
                total = sess.get("total", 0) or 0
                ok_count = sess.get("ok_count", 0) or 0

                # Build hourly buckets from defect data
                result = []
                for hour_val, info in defect_rows.items():
                    defect_count = info.get("defect_count", 0)
                    anomaly_count = info.get("anomaly_count", 0)
                    # We can't know exact total per hour without a full crossing log,
                    # so report defect stats per hour
                    result.append({
                        "hour": hour_val,
                        "defect_count": defect_count,
                        "anomaly_count": anomaly_count,
                        "conformity_pct": 0.0,
                        "cadence": 0,
                    })

                # If we have session-level totals, distribute proportionally
                # or compute conformity from the overall session rate
                if total > 0:
                    overall_conformity = (ok_count / total) * 100
                    total_defects = sum(r["defect_count"] for r in result)
                    for r in result:
                        if total_defects > 0:
                            weight = r["defect_count"] / total_defects
                            estimated_total_for_hour = int(total * weight) if total_defects > 0 else 0
                            ok_for_hour = max(0, estimated_total_for_hour - r["defect_count"])
                            r["conformity_pct"] = round(
                                (ok_for_hour / estimated_total_for_hour * 100) if estimated_total_for_hour > 0 else 100.0, 2
                            )
                            # cadence: packets per minute (rough estimate)
                            r["cadence"] = round(estimated_total_for_hour / 60, 1)
                        else:
                            r["conformity_pct"] = 100.0

                return result
        except Exception as e:
            print(f"[DBWriter] get_hourly_stats error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def _run(self):
        while not self._stop_event.is_set():
            try:
                event = self.write_queue.get(timeout=1.0)
            except queue.Empty:
                continue

            if event.get("type") == "stop":
                break

            if not self.is_active:
                self.write_queue.task_done()
                continue

            try:
                if event.get("type") == "session_update":
                    self._update_session_live(event)
                elif event.get("type") == "crossing":
                    self._write_crossing(event)
            except Exception as e:
                print(f"[DBWriter] Event write error: {e}")

            self.write_queue.task_done()

    def _update_session_live(self, ev):
        """UPDATE the sessions row with latest running totals (called every N packets).

        Dashboard sees live numbers; crash leaves last-known state instead of zeroes.
        """
        conn = self._get_pg_conn()
        if not conn:
            return
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE sessions SET total=%s, ok_count=%s, nok_no_barcode=%s, "
                    "nok_no_date=%s, nok_anomaly=%s WHERE id=%s",
                    (
                        ev.get("total", 0),
                        ev.get("ok_count", 0),
                        ev.get("nok_no_barcode", 0),
                        ev.get("nok_no_date", 0),
                        ev.get("nok_anomaly", 0),
                        ev.get("session_id"),
                    ),
                )
            conn.commit()
        finally:
            self._release_pg_conn(conn)

    def _write_crossing(self, ev):
        conn = self._get_pg_conn()
        if not conn:
            return
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO defective_packets (session_id, packet_num, defect_type, crossed_at) "
                    "VALUES (%s, %s, %s, %s)",
                    (
                        ev.get("session_id"),
                        ev.get("packet_num", 0),
                        ev.get("defect_type", "unknown"),
                        ev.get("crossed_at", _ts()),
                    ),
                )
            conn.commit()
        finally:
            self._release_pg_conn(conn)

    def _get_pg_conn(self):
        """Get a connection from the pool. Auto-reconnects if the pool is broken."""
        if not self._pg_pool:
            self._try_reconnect()
        if not self._pg_pool:
            return None
        try:
            conn = self._pg_pool.getconn()
            conn.autocommit = False
            return conn
        except Exception as e:
            print(f"[DBWriter] pool.getconn() failed: {e} — attempting reconnect")
            self._try_reconnect()
            return None

    def _release_pg_conn(self, conn):
        """Return a connection to the pool."""
        if self._pg_pool and conn:
            try:
                self._pg_pool.putconn(conn)
            except Exception:
                pass

    _reconnect_lock = threading.Lock()
    _last_reconnect_attempt = 0.0
    _RECONNECT_COOLDOWN = 10.0  # seconds between reconnect attempts

    def _try_reconnect(self):
        """Attempt to re-establish the connection pool after a failure.
        Rate-limited to once every _RECONNECT_COOLDOWN seconds to avoid log spam.
        """
        with self._reconnect_lock:
            now = time.monotonic()
            if now - self._last_reconnect_attempt < self._RECONNECT_COOLDOWN:
                return
            self._last_reconnect_attempt = now

        print("[DBWriter] Attempting PostgreSQL reconnect...")
        try:
            if self._pg_pool:
                try:
                    self._pg_pool.closeall()
                except Exception:
                    pass
                self._pg_pool = None
            self._pg_pool = ThreadedConnectionPool(
                minconn=1, maxconn=5,
                host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                user=DB_USER, password=DB_PASSWORD,
                connect_timeout=5,
            )
            self._available = True
            print("[DBWriter] Reconnected to PostgreSQL.")
        except Exception as e:
            self._pg_pool = None
            self._available = False
            print(f"[DBWriter] Reconnect failed: {e}")

    def health(self):
        """Return a health status dict. Expose via /api/health in the Flask app.

        Returns:
            {
                'db': 'ok' | 'unavailable',
                'queue_size': int,       # events waiting to be written
                'queue_max': int,
                'active': bool,          # whether stats recording is on
                'session_id': str | None # current open session
            }
        """
        db_status = "unavailable"
        if self._available and self._pg_pool:
            try:
                conn = self._pg_pool.getconn()
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                self._pg_pool.putconn(conn)
                db_status = "ok"
            except Exception:
                db_status = "unavailable"

        return {
            "db": db_status,
            "queue_size": self.write_queue.qsize(),
            "queue_max": self.write_queue.maxsize,
            "active": self.is_active,
            "session_id": self.current_session_id,
        }

    # ═══════════════════════════════════════════════
    # SHIFTS CRUD  (direct calls, not queue-based)
    # ═══════════════════════════════════════════════

    def _attach_variants(self, shifts):
        """Attach a 'variants' list to each shift dict in-place."""
        all_variants = self.get_all_variants()
        by_shift = {}
        for v in all_variants:
            by_shift.setdefault(v["shift_id"], []).append(v)
        for s in shifts:
            s["variants"] = by_shift.get(s["id"], [])
        return shifts

    def get_all_variants(self):
        """Return all shift_variants rows."""
        if not self._available:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, shift_id, kind, active, start_time, end_time, "
                    "start_date, end_date, days_of_week, created_at "
                    "FROM shift_variants ORDER BY created_at"
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] get_all_variants error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def get_variants_for_shift(self, shift_id):
        """Return all shift_variants rows for a specific shift."""
        if not self._available or not shift_id:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, shift_id, kind, active, start_time, end_time, "
                    "start_date, end_date, days_of_week, created_at "
                    "FROM shift_variants WHERE shift_id = %s ORDER BY created_at",
                    (shift_id,),
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] get_variants_for_shift error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def get_all_shifts(self):
        """Return all recurring shifts ordered by start_time, each with a 'variants' list."""
        if not self._available:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, label, type, start_time, end_time, start_date, end_date, "
                    "session_date, days_of_week, camera_source, checkpoint_id, active, created_at "
                    "FROM shifts WHERE type = 'recurring' OR type IS NULL ORDER BY start_time"
                )
                shifts = [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] get_all_shifts error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)
        return self._attach_variants(shifts)

    def get_shift(self, shift_id):
        """Return a single shift by id, or None."""
        if not self._available or not shift_id:
            return None
        conn = self._get_pg_conn()
        if not conn:
            return None
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM shifts WHERE id = %s", (shift_id,))
                row = cur.fetchone()
                return dict(row) if row else None
        except Exception as e:
            print(f"[DBWriter] get_shift error: {e}")
            return None
        finally:
            self._release_pg_conn(conn)

    def insert_shift(self, shift):
        """Insert a new recurring shift row."""
        if not self._available:
            return False
        params = (
            shift["id"], shift["label"], "recurring", shift["start_time"],
            shift["end_time"], shift.get("start_date"), shift.get("end_date"),
            None, shift["days_of_week"],
            shift.get("camera_source", "0"),
            shift.get("checkpoint_id", "tracking"),
            shift.get("enabled_pipelines", '["pipeline_barcode_date","pipeline_anomaly"]'),
            shift.get("active", 1),
            shift["created_at"],
        )
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO shifts (id, label, type, start_time, end_time, start_date, end_date, "
                    "session_date, days_of_week, camera_source, checkpoint_id, enabled_pipelines, active, created_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    params,
                )
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] insert_shift error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def update_shift(self, shift_id, fields):
        """Update specific fields of a shift. `fields` is a dict of column->value."""
        if not self._available or not shift_id or not fields:
            return False
        allowed = {"label", "start_time", "end_time", "start_date", "end_date",
                   "days_of_week", "camera_source", "checkpoint_id", "enabled_pipelines", "active"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return False
        set_clause = ", ".join(f"{k} = %s" for k in cols)
        values = list(cols.values()) + [shift_id]
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE shifts SET {set_clause} WHERE id = %s", values)
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] update_shift error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def delete_shift(self, shift_id):
        """Delete a shift by id."""
        if not self._available or not shift_id:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM shifts WHERE id = %s", (shift_id,))
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] delete_shift error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def toggle_shift(self, shift_id):
        """Flip active 0<->1. Returns new active value or None on failure."""
        if not self._available or not shift_id:
            return None
        conn = self._get_pg_conn()
        if not conn:
            return None
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE shifts SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END "
                    "WHERE id = %s RETURNING active",
                    (shift_id,),
                )
                row = cur.fetchone()
            conn.commit()
            return row[0] if row else None
        except Exception as e:
            print(f"[DBWriter] toggle_shift error: {e}")
            return None
        finally:
            self._release_pg_conn(conn)

    # ═══════════════════════════════════════════════
    # SHIFT VARIANTS CRUD
    # ═══════════════════════════════════════════════

    def insert_variant(self, variant):
        """Insert a shift_variant row. Returns the inserted dict or None."""
        if not self._available:
            return None
        params = (
            variant["id"], variant["shift_id"], variant["kind"],
            variant.get("active"), variant.get("start_time"), variant.get("end_time"),
            variant["start_date"], variant["end_date"],
            variant["days_of_week"], variant["created_at"],
        )
        conn = self._get_pg_conn()
        if not conn:
            return None
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO shift_variants (id, shift_id, kind, active, start_time, end_time, "
                    "start_date, end_date, days_of_week, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    params,
                )
            conn.commit()
            return variant
        except Exception as e:
            print(f"[DBWriter] insert_variant error: {e}")
            return None
        finally:
            self._release_pg_conn(conn)

    def update_variant(self, variant_id, fields):
        """Update specific fields of a shift_variant."""
        if not self._available or not variant_id or not fields:
            return False
        allowed = {"kind", "active", "start_time", "end_time", "start_date", "end_date", "days_of_week"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return False
        set_clause = ", ".join(f"{k} = %s" for k in cols)
        values = list(cols.values()) + [variant_id]
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE shift_variants SET {set_clause} WHERE id = %s", values)
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] update_variant error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def delete_variant(self, variant_id):
        """Delete a shift_variant by id."""
        if not self._available or not variant_id:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM shift_variants WHERE id = %s", (variant_id,))
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] delete_variant error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def delete_variants_for_shift(self, shift_id):
        """Delete all shift_variants for a given shift (used on shift delete)."""
        if not self._available or not shift_id:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM shift_variants WHERE shift_id = %s", (shift_id,))
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] delete_variants_for_shift error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    # ── One-off sessions (stored in unified shifts table, type='one_off') ────

    def get_all_one_off_sessions(self):
        """Return all one-off sessions from the unified shifts table."""
        if not self._available:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, label, session_date AS date, start_time, end_time, "
                    "camera_source, checkpoint_id, created_at "
                    "FROM shifts WHERE type = 'one_off' ORDER BY session_date, start_time"
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] get_all_one_off_sessions error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def insert_one_off_session(self, session):
        """Insert a one-off session into the unified shifts table."""
        if not self._available:
            return None
        params = (
            session["id"], session["label"], "one_off",
            session["start_time"], session["end_time"],
            session["date"],
            "[]",
            session.get("camera_source", "0"),
            session.get("checkpoint_id", "tracking"),
            1,
            session["created_at"],
        )
        conn = self._get_pg_conn()
        if not conn:
            return None
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO shifts "
                    "(id, label, type, start_time, end_time, session_date, days_of_week, "
                    "camera_source, checkpoint_id, active, created_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    params,
                )
            conn.commit()
            return session
        except Exception as e:
            print(f"[DBWriter] insert_one_off_session error: {e}")
            return None
        finally:
            self._release_pg_conn(conn)

    def update_one_off_session(self, session_id, fields):
        """Update start_time and/or end_time of a one-off session."""
        if not self._available or not session_id or not fields:
            return False
        allowed = {"start_time", "end_time"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return False
        set_clause = ", ".join(f"{k} = %s" for k in cols)
        values = list(cols.values()) + [session_id]
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE shifts SET {set_clause} WHERE id = %s AND type = 'one_off'",
                    values,
                )
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] update_one_off_session error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def delete_stats_session(self, session_id):
        """Hard-delete a stats session group and all its associated data.

        session_id may be either an individual session id or a group_id —
        both cases are covered so that the grouped view works correctly.

        Returns the list of individual session UUIDs that were deleted,
        so the caller can clean up proof image folders.
        """
        if not self._available or not session_id:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor() as cur:
                # Collect all individual session IDs in this group
                cur.execute(
                    "SELECT id FROM sessions WHERE id = %s OR group_id = %s",
                    (session_id, session_id),
                )
                ids = [row[0] for row in cur.fetchall()]
                if not ids:
                    return []
                # Delete defective_packets first (FK constraint)
                cur.execute(
                    "DELETE FROM defective_packets WHERE session_id IN "
                    "(SELECT id FROM sessions WHERE id = %s OR group_id = %s)",
                    (session_id, session_id),
                )
                # Delete all session rows belonging to this group
                cur.execute(
                    "DELETE FROM sessions WHERE id = %s OR group_id = %s",
                    (session_id, session_id),
                )
            conn.commit()
            return ids
        except Exception as e:
            print(f"[DBWriter] delete_stats_session error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def delete_one_off_session(self, session_id):
        """Delete a one-off session from the unified shifts table."""
        if not self._available or not session_id:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM shifts WHERE id = %s AND type = 'one_off'", (session_id,))
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] delete_one_off_session error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    # ─────────────────────────────────────────
    # AUTH USERS
    # ─────────────────────────────────────────

    def get_auth_user(self, email):
        """Return {'email', 'pw_hash', 'role'} or None."""
        if not self._available or not email:
            return None
        conn = self._get_pg_conn()
        if not conn:
            return None
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT email, pw_hash, role FROM auth_users WHERE email = %s", (email,))
                row = cur.fetchone()
                return dict(row) if row else None
        except Exception as e:
            print(f"[DBWriter] get_auth_user error: {e}")
            return None
        finally:
            self._release_pg_conn(conn)

    def list_auth_users(self):
        """Return all users (without pw_hash)."""
        if not self._available:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT email, role, created_at FROM auth_users ORDER BY created_at")
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] list_auth_users error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def upsert_auth_user(self, email, pw_hash, role="client"):
        """Insert or update a user."""
        if not self._available or not email:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO auth_users (email, pw_hash, role, created_at) "
                    "VALUES (%s, %s, %s, %s) "
                    "ON CONFLICT (email) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, role = EXCLUDED.role",
                    (email, pw_hash, role, _ts()),
                )
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] upsert_auth_user error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def delete_auth_user(self, email):
        """Delete a user by email."""
        if not self._available or not email:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM auth_users WHERE email = %s", (email,))
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] delete_auth_user error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    # ── Feedback ──────────────────────────────────────────────────────────────

    def create_feedback(self, title, comment, fb_type, scope, urgency, session_id, user_email, screenshot_path=None):
        if not self._available:
            return None
        conn = self._get_pg_conn()
        if not conn:
            return None
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "INSERT INTO feedbacks (title, comment, type, scope, urgency, session_id, user_email, screenshot_path, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
                    (title, comment, fb_type, scope, urgency, session_id or None, user_email or None, screenshot_path or None, _ts()),
                )
                row = cur.fetchone()
            conn.commit()
            return dict(row) if row else None
        except Exception as e:
            print(f"[DBWriter] create_feedback error: {e}")
            return None
        finally:
            self._release_pg_conn(conn)

    def update_feedback_screenshot(self, feedback_id, screenshot_path):
        if not self._available:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE feedbacks SET screenshot_path = %s WHERE id = %s", (screenshot_path, feedback_id))
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] update_feedback_screenshot error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def set_feedback_response(self, feedback_id, response_text):
        if not self._available:
            return False
        conn = self._get_pg_conn()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE feedbacks SET admin_response = %s, responded_at = %s WHERE id = %s",
                    (response_text, _ts(), feedback_id),
                )
            conn.commit()
            return True
        except Exception as e:
            print(f"[DBWriter] set_feedback_response error: {e}")
            return False
        finally:
            self._release_pg_conn(conn)

    def list_feedbacks(self, limit=200):
        if not self._available:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT %s",
                    (limit,),
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] list_feedbacks error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def list_feedbacks_for_user(self, user_email, limit=100):
        if not self._available or not user_email:
            return []
        conn = self._get_pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT * FROM feedbacks WHERE user_email = %s ORDER BY created_at DESC LIMIT %s",
                    (user_email, limit),
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            print(f"[DBWriter] list_feedbacks_for_user error: {e}")
            return []
        finally:
            self._release_pg_conn(conn)

    def cleanup_old_screenshots(self, screenshots_dir, max_age_days=15):
        """Delete screenshot files and DB records older than max_age_days."""
        if not self._available:
            return
        import os as _os
        from datetime import datetime as _dt, timedelta as _td
        cutoff = (_dt.utcnow() - _td(days=max_age_days)).isoformat()
        conn = self._get_pg_conn()
        if not conn:
            return
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, screenshot_path FROM feedbacks WHERE screenshot_path IS NOT NULL AND created_at < %s",
                    (cutoff,),
                )
                stale = cur.fetchall()
            for row in stale:
                path = row["screenshot_path"]
                if path:
                    full = _os.path.join(screenshots_dir, _os.path.basename(path))
                    try:
                        _os.remove(full)
                    except FileNotFoundError:
                        pass
                with conn.cursor() as cur2:
                    cur2.execute("UPDATE feedbacks SET screenshot_path = NULL WHERE id = %s", (row["id"],))
            conn.commit()
            if stale:
                print(f"[DBWriter] Cleaned up {len(stale)} old screenshot(s)")
        except Exception as e:
            print(f"[DBWriter] cleanup_old_screenshots error: {e}")
        finally:
            self._release_pg_conn(conn)
