#!/usr/bin/env python3
# ==============================================================================
#  ██████╗ ███████╗██╗     ███████╗████████╗███████╗
#  ██╔══██╗██╔════╝██║     ██╔════╝╚══██╔══╝██╔════╝
#  ██║  ██║█████╗  ██║     █████╗     ██║   █████╗
#  ██║  ██║██╔══╝  ██║     ██╔══╝     ██║   ██╔══╝
#  ██████╔╝███████╗███████╗███████╗   ██║   ███████╗
#  ╚═════╝ ╚══════╝╚══════╝╚══════╝   ╚═╝   ╚══════╝
#
#  PERFORMANCE MONITOR — DELETE THIS FILE AFTER TESTING
#  ────────────────────────────────────────────────────
#
#  PASSIVE observer for the GMCB backend.
#  Does NOT start/stop pipelines. Does NOT hammer APIs.
#
#  YOU start a session from the dashboard (Démarrer une session).
#  This script just watches and records:
#    1. Per-model inference latency (barcode + anomaly) for PLC team
#    2. GPU utilisation, VRAM, temperature
#    3. CPU, RAM
#    4. Packets processed, OK/NOK counts
#    5. Writes CSV timeseries + final PLC-ready report
#
#  HOW TO RUN:
#    Terminal 1:  python app.py
#    Terminal 2:  npm run dev        (open dashboard, start session)
#    Terminal 3:  python stress_test.py              # runs until Ctrl+C
#                 python stress_test.py --duration 3600  # stop after 1h
#
#  Press Ctrl+C at any time → instant report with all data collected.
#
#  DELETE THIS FILE WHEN DONE
# ==============================================================================

# ── TEMPORARY IMPORTS (delete with file) ──────────────────────────────────────
import argparse
import csv
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

import psutil
import requests
# ── END TEMPORARY IMPORTS ─────────────────────────────────────────────────────

# ── TEMPORARY CONFIG (delete with file) ───────────────────────────────────────
DEFAULT_HOST     = "http://localhost:5000"
DEFAULT_DURATION = 5 * 3600   # 5 hours
PRINT_INTERVAL   = 30         # live stats line every 30s
CSV_INTERVAL     = 20         # write a CSV row every 20s
SNAPSHOT_INTERVAL = 15 * 60   # write a snapshot report every 15 minutes
SNAPSHOT_FILE    = "perf_snapshots.txt"  # append-only report file

PIPELINE_BARCODE = "pipeline_barcode_date"
PIPELINE_ANOMALY = "pipeline_anomaly"
PIPELINE_IDS     = [PIPELINE_BARCODE, PIPELINE_ANOMALY]
# ── END TEMPORARY CONFIG ──────────────────────────────────────────────────────


# ── TEMPORARY: Metrics (delete with file) ─────────────────────────────────────
@dataclass
class PipelineMetrics:
    """Per-pipeline inference timing (for PLC report)."""
    name: str = ""
    inference_ms: deque = field(default_factory=lambda: deque(maxlen=500_000))
    det_fps:      deque = field(default_factory=lambda: deque(maxlen=500_000))
    total_packets: int  = 0
    ok_count:     int   = 0
    nok_count:    int   = 0
    is_running:   bool  = False

@dataclass
class Metrics:
    # System
    gpu_util:       deque = field(default_factory=lambda: deque(maxlen=500_000))
    gpu_mem_mb:     deque = field(default_factory=lambda: deque(maxlen=500_000))
    gpu_temp:       deque = field(default_factory=lambda: deque(maxlen=500_000))
    cpu_pct:        deque = field(default_factory=lambda: deque(maxlen=500_000))
    ram_mb:         deque = field(default_factory=lambda: deque(maxlen=500_000))
    # Per-pipeline
    barcode:   PipelineMetrics = field(default_factory=lambda: PipelineMetrics(name="barcode_date"))
    anomaly:   PipelineMetrics = field(default_factory=lambda: PipelineMetrics(name="anomaly"))
    # Polling health
    poll_count:     int = 0
    poll_errors:    int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)
# ── END TEMPORARY: Metrics ────────────────────────────────────────────────────


# ── TEMPORARY: GPU monitor (delete with file) ─────────────────────────────────
def gpu_monitor(m: Metrics, stop: threading.Event):
    cmd = ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,temperature.gpu",
           "--format=csv,noheader,nounits"]
    while not stop.is_set():
        try:
            out = subprocess.check_output(cmd, timeout=3).decode().strip()
            util, mem, temp = [x.strip() for x in out.split(",")]
            with m.lock:
                m.gpu_util.append(float(util))
                m.gpu_mem_mb.append(float(mem))
                m.gpu_temp.append(float(temp))
        except Exception:
            pass
        time.sleep(1)
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: CPU/RAM monitor (delete with file) ─────────────────────────────
def sys_monitor(m: Metrics, stop: threading.Event):
    while not stop.is_set():
        with m.lock:
            m.cpu_pct.append(psutil.cpu_percent(interval=None))
            m.ram_mb.append(psutil.virtual_memory().used / 1024 / 1024)
        time.sleep(1)
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: Per-pipeline inference poller (delete with file) ────────────────
def pipeline_stats_poller(host: str, m: Metrics, stop: threading.Event):
    """Poll both pipeline stats endpoints to read inference_ms and det_fps."""
    sess = requests.Session()
    while not stop.is_set():
        for pid, pm in [(PIPELINE_BARCODE, m.barcode), (PIPELINE_ANOMALY, m.anomaly)]:
            try:
                r = sess.get(f"{host}/api/pipelines/{pid}/stats", timeout=3)
                with m.lock:
                    m.poll_count += 1
                if r.ok:
                    d = r.json()
                    # inference_ms and det_fps are top-level in the response
                    ims  = d.get("inference_ms", 0)
                    dfps = d.get("det_fps", 0)
                    with m.lock:
                        if ims > 0:
                            pm.inference_ms.append(ims)
                        if dfps > 0:
                            pm.det_fps.append(dfps)
                        pm.total_packets = d.get("total_packets", 0)
                        pm.ok_count  = d.get("packages_ok", 0)
                        pm.nok_count = d.get("packages_nok", 0)
                        pm.is_running = d.get("is_running", False)
            except Exception:
                with m.lock:
                    m.poll_errors += 1
        time.sleep(1)
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: CSV logger (delete with file) ──────────────────────────────────
def csv_logger(m: Metrics, stop: threading.Event, filepath: str):
    """Write a row of metrics every CSV_INTERVAL seconds."""
    with open(filepath, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "timestamp", "elapsed_s",
            "cpu_pct", "ram_mb",
            "gpu_util_pct", "gpu_mem_mb", "gpu_temp_c",
            "barcode_running", "barcode_inference_ms", "barcode_det_fps", "barcode_packets", "barcode_ok", "barcode_nok",
            "anomaly_running", "anomaly_inference_ms", "anomaly_det_fps", "anomaly_packets", "anomaly_ok", "anomaly_nok",
        ])
        t0 = time.monotonic()
        while not stop.is_set():
            time.sleep(CSV_INTERVAL)
            elapsed = int(time.monotonic() - t0)
            with m.lock:
                row = [
                    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    elapsed,
                    round(list(m.cpu_pct)[-1], 1)  if m.cpu_pct  else 0,
                    round(list(m.ram_mb)[-1], 0)    if m.ram_mb   else 0,
                    round(list(m.gpu_util)[-1], 1)  if m.gpu_util else 0,
                    round(list(m.gpu_mem_mb)[-1], 0) if m.gpu_mem_mb else 0,
                    round(list(m.gpu_temp)[-1], 1)  if m.gpu_temp else 0,
                    int(m.barcode.is_running),
                    round(list(m.barcode.inference_ms)[-1], 1) if m.barcode.inference_ms else 0,
                    round(list(m.barcode.det_fps)[-1], 1)      if m.barcode.det_fps else 0,
                    m.barcode.total_packets, m.barcode.ok_count, m.barcode.nok_count,
                    int(m.anomaly.is_running),
                    round(list(m.anomaly.inference_ms)[-1], 1) if m.anomaly.inference_ms else 0,
                    round(list(m.anomaly.det_fps)[-1], 1)      if m.anomaly.det_fps else 0,
                    m.anomaly.total_packets, m.anomaly.ok_count, m.anomaly.nok_count,
                ]
            writer.writerow(row)
            f.flush()
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: Helper stats functions (delete with file) ──────────────────────
def _avg(d):  return round(sum(d)/len(d), 1) if d else 0
def _mx(d):   return round(max(d), 1) if d else 0
def _mn(d):   return round(min(d), 1) if d else 0
def _pct(d, p):
    s = sorted(d)
    return round(s[min(int(len(s)*p), len(s)-1)], 1) if s else 0
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: 15-minute snapshot writer (delete with file) ───────────────────
def write_snapshot(m: Metrics, elapsed: int, filepath: str):
    """Append a formatted snapshot table to the report file every 15 minutes."""
    hrs = elapsed // 3600
    mins = (elapsed % 3600) // 60

    with m.lock:
        b_ims = list(m.barcode.inference_ms)
        a_ims = list(m.anomaly.inference_ms)
        b_fps = list(m.barcode.det_fps)
        a_fps = list(m.anomaly.det_fps)
        b_pkt = m.barcode.total_packets
        a_pkt = m.anomaly.total_packets
        b_ok  = m.barcode.ok_count
        b_nok = m.barcode.nok_count
        a_ok  = m.anomaly.ok_count
        a_nok = m.anomaly.nok_count
        b_run = m.barcode.is_running
        a_run = m.anomaly.is_running
        gpu_u = list(m.gpu_util)
        gpu_m = list(m.gpu_mem_mb)
        gpu_t = list(m.gpu_temp)
        cpu   = list(m.cpu_pct)
        ram   = list(m.ram_mb)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Build ranges for recent window (last ~15 min = ~900 samples at 1/s)
    window = 900
    b_ims_w = b_ims[-window:] if b_ims else []
    a_ims_w = a_ims[-window:] if a_ims else []
    b_fps_w = b_fps[-window:] if b_fps else []
    a_fps_w = a_fps[-window:] if a_fps else []
    gpu_u_w = gpu_u[-window:] if gpu_u else []
    gpu_m_w = gpu_m[-window:] if gpu_m else []
    gpu_t_w = gpu_t[-window:] if gpu_t else []
    cpu_w   = cpu[-window:]   if cpu   else []
    ram_w   = ram[-window:]   if ram   else []

    snapshot = f"""
╔══════════════════════════════════════════════════════════════════════════╗
║  SNAPSHOT @ {now}  —  elapsed {hrs}h{mins:02d}m                         ║
╠══════════════════════════════════════════════════════════════════════════╣
║                                                                          ║
║  Metric              │  Barcode+Date              │  Anomaly             ║
║  ────────────────────┼────────────────────────────┼──────────────────────║
║  Running             │  {'YES' if b_run else 'NO':<27}│  {'YES' if a_run else 'NO':<21}║
║  Inference           │  {_mn(b_ims_w):.1f}–{_mx(b_ims_w):.1f} ms (avg {_avg(b_ims_w):.1f}){'':<3}│  {_mn(a_ims_w):.1f}–{_mx(a_ims_w):.1f} ms (avg {_avg(a_ims_w):.1f}) ║
║  Det FPS             │  {_mn(b_fps_w):.0f}–{_mx(b_fps_w):.0f} fps (avg {_avg(b_fps_w):.0f}){'':<5}│  {_mn(a_fps_w):.0f}–{_mx(a_fps_w):.0f} fps (avg {_avg(a_fps_w):.0f})   ║
║  Packets             │  {b_pkt} ({b_ok} OK, {b_nok} NOK){'':<4}│  {a_pkt} ({a_ok} OK, {a_nok} NOK)  ║
║  ────────────────────┼────────────────────────────┴──────────────────────║
║  GPU                 │  {_mn(gpu_u_w):.0f}–{_mx(gpu_u_w):.0f}%, {_avg(gpu_m_w):.0f} MB VRAM, {_mn(gpu_t_w):.0f}→{_mx(gpu_t_w):.0f}°C          ║
║  CPU                 │  {_mn(cpu_w):.1f}–{_mx(cpu_w):.1f}% (avg {_avg(cpu_w):.1f}%)                          ║
║  RAM                 │  {_avg(ram_w)/1024:.1f} GB (avg)                                       ║
╚══════════════════════════════════════════════════════════════════════════╝
"""
    # Print to console
    print(snapshot)
    # Append to file
    with open(filepath, "a") as f:
        f.write(snapshot)
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: Live stats printer (delete with file) ──────────────────────────
def print_live(m: Metrics, elapsed: int, duration: int):
    with m.lock:
        gpu_u = list(m.gpu_util)[-5:]
        gpu_t = list(m.gpu_temp)[-5:]
        gpu_m = list(m.gpu_mem_mb)[-5:]
        cpu   = list(m.cpu_pct)[-5:]
        b_ims = list(m.barcode.inference_ms)[-5:]
        a_ims = list(m.anomaly.inference_ms)[-5:]
        b_fps = list(m.barcode.det_fps)[-5:]
        a_fps = list(m.anomaly.det_fps)[-5:]
        b_pkt = m.barcode.total_packets
        a_pkt = m.anomaly.total_packets
        b_run = m.barcode.is_running
        a_run = m.anomaly.is_running

    hrs = elapsed // 3600
    mins = (elapsed % 3600) // 60
    secs = elapsed % 60

    if duration > 0:
        rem  = max(duration - elapsed, 0)
        rem_h = rem // 3600
        rem_m = (rem % 3600) // 60
        time_str = f"[{hrs:02d}:{mins:02d}:{secs:02d} / -{rem_h}h{rem_m:02d}m]"
    else:
        time_str = f"[{hrs:02d}:{mins:02d}:{secs:02d}]"

    b_status = "RUN" if b_run else "OFF"
    a_status = "RUN" if a_run else "OFF"

    print(
        f"{time_str}  "
        f"CPU:{_avg(cpu)}%  GPU:{_avg(gpu_u)}% {_avg(gpu_m):.0f}MB {_avg(gpu_t)}°C  |  "
        f"Barcode[{b_status}]: {_avg(b_ims)}ms {_avg(b_fps)}fps {b_pkt}pkt  |  "
        f"Anomaly[{a_status}]: {_avg(a_ims)}ms {_avg(a_fps)}fps {a_pkt}pkt"
    )
# ── END ───────────────────────────────────────────────────────────────────────


# ── TEMPORARY: PLC-ready final report (delete with file) ──────────────────────
def print_final_report(m: Metrics, duration: int, csv_path: str):
    with m.lock:
        b_ims = sorted(m.barcode.inference_ms)
        a_ims = sorted(m.anomaly.inference_ms)
        b_fps = list(m.barcode.det_fps)
        a_fps = list(m.anomaly.det_fps)
        gpu_u = list(m.gpu_util)
        gpu_m = list(m.gpu_mem_mb)
        gpu_t = list(m.gpu_temp)
        cpu   = list(m.cpu_pct)
        ram   = list(m.ram_mb)

    sep = "═" * 76
    hrs = duration // 3600
    mins = (duration % 3600) // 60

    print(f"\n{sep}")
    print(f"  GMCB — SESSION PERFORMANCE REPORT")
    print(f"  {datetime.now():%Y-%m-%d %H:%M}  |  Monitored: {hrs}h{mins:02d}m  |  CSV: {csv_path}")
    print(sep)

    if not b_ims and not a_ims:
        print("\n  ⚠  No inference data collected.")
        print("     Make sure you started a session from the dashboard")
        print("     BEFORE or WHILE this monitor was running.")
        print(f"\n{sep}\n")
        return

    # ── PLC DECISION-TIME TABLE ──
    print(f"""
  ┌─────────────────────────────────────────────────────────────────────┐
  │  PLC DECISION TIME — how long from frame capture to OK/NOK         │
  │  (share this table with the PLC integration team)                  │
  ├───────────────────────┬──────────────────┬─────────────────────────┤
  │                       │  Barcode+Date    │  Anomaly Detection      │
  ├───────────────────────┼──────────────────┼─────────────────────────┤
  │  Samples collected    │  {len(b_ims):>8d}       │  {len(a_ims):>8d}                │
  │  Min inference        │  {_mn(b_ims):>8.1f} ms   │  {_mn(a_ims):>8.1f} ms            │
  │  Average inference    │  {_avg(b_ims):>8.1f} ms   │  {_avg(a_ims):>8.1f} ms            │
  │  Median (p50)         │  {_pct(b_ims,.50):>8.1f} ms   │  {_pct(a_ims,.50):>8.1f} ms            │
  │  p95                  │  {_pct(b_ims,.95):>8.1f} ms   │  {_pct(a_ims,.95):>8.1f} ms            │
  │  p99                  │  {_pct(b_ims,.99):>8.1f} ms   │  {_pct(a_ims,.99):>8.1f} ms            │
  │  MAX (worst case)     │  {_mx(b_ims):>8.1f} ms   │  {_mx(a_ims):>8.1f} ms            │
  ├───────────────────────┼──────────────────┼─────────────────────────┤
  │  Detection FPS avg    │  {_avg(b_fps):>8.1f} fps  │  {_avg(a_fps):>8.1f} fps           │
  │  Detection FPS min    │  {_mn(b_fps):>8.1f} fps  │  {_mn(a_fps):>8.1f} fps           │
  │  Packets processed    │  {m.barcode.total_packets:>8d}       │  {m.anomaly.total_packets:>8d}                │
  │  OK                   │  {m.barcode.ok_count:>8d}       │  {m.anomaly.ok_count:>8d}                │
  │  NOK                  │  {m.barcode.nok_count:>8d}       │  {m.anomaly.nok_count:>8d}                │
  └───────────────────────┴──────────────────┴─────────────────────────┘

  → PLC available time = cycle_period - MAX_inference
    Example: if conveyor cycle = 500ms and worst-case = {max(_mx(b_ims), _mx(a_ims)):.0f}ms
             then PLC has {max(500 - max(_mx(b_ims), _mx(a_ims)), 0):.0f}ms for ejection logic
""")

    # ── GPU ──
    print(f"  GPU  (NVIDIA RTX 5080)")
    print(f"    Utilisation : avg {_avg(gpu_u)}%  max {_mx(gpu_u)}%")
    print(f"    VRAM        : avg {_avg(gpu_m):.0f} MB  max {_mx(gpu_m):.0f} MB  (of 16303 MB)")
    print(f"    Temperature : avg {_avg(gpu_t)}°C  max {_mx(gpu_t)}°C")

    # ── CPU/RAM ──
    print(f"\n  SYSTEM")
    print(f"    CPU     : avg {_avg(cpu)}%  max {_mx(cpu)}%")
    print(f"    RAM     : avg {_avg(ram):.0f} MB  max {_mx(ram):.0f} MB")

    # ── Pass / Fail ──
    print(f"\n  REGRESSION CHECKS")
    issues = []
    if _mx(gpu_t) > 85:
        issues.append(f"    ✗ GPU temperature peak {_mx(gpu_t)}°C > 85°C")
    if b_ims and _mx(b_ims) > 200:
        issues.append(f"    ✗ Barcode max inference {_mx(b_ims)}ms > 200ms")
    if a_ims and _mx(a_ims) > 300:
        issues.append(f"    ✗ Anomaly max inference {_mx(a_ims)}ms > 300ms")
    if not issues:
        print("    ✓ ALL CHECKS PASSED")
    else:
        for i in issues:
            print(i)

    print(f"\n{sep}")
    print(f"  Full timeseries data: {csv_path}")
    print(f"  Open in Excel / Google Sheets for graphing")
    print(f"{sep}\n")
# ── END TEMPORARY: Report ─────────────────────────────────────────────────────


# ── TEMPORARY: Main (delete with file) ────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Passive performance monitor for GMCB — DELETE AFTER USE.\n"
                    "Start session from the dashboard. This script only WATCHES.")
    parser.add_argument("--host",     default=DEFAULT_HOST)
    parser.add_argument("--duration", type=int, default=DEFAULT_DURATION,
                        help="seconds, 0 = run until Ctrl+C (default: 0)")
    parser.add_argument("--csv",      default=None,
                        help="CSV output path (default: perf_YYYYMMDD_HHMMSS.csv)")
    args = parser.parse_args()

    host     = args.host.rstrip("/")
    duration = args.duration
    csv_path = args.csv or f"perf_{datetime.now():%Y%m%d_%H%M%S}.csv"

    # Check backend is reachable
    try:
        r = requests.get(f"{host}/api/pipelines", timeout=3)
        r.raise_for_status()
        pipes = r.json().get("pipelines", [])
        running = [p["id"] for p in pipes if p.get("is_running")]
    except Exception as e:
        print(f"[MONITOR] Cannot reach backend at {host}: {e}")
        sys.exit(1)

    dur_str = f"{duration//3600}h{(duration%3600)//60:02d}m" if duration > 0 else "∞ (Ctrl+C to stop)"

    print(f"""
╔══════════════════════════════════════════════════════════════════╗
║  GMCB PERFORMANCE MONITOR  —  passive, read-only               ║
║  DELETE THIS FILE WHEN DONE                                     ║
╠══════════════════════════════════════════════════════════════════╣
║  Host     : {host:<51}║
║  Duration : {dur_str:<51}║
║  CSV      : {csv_path:<51}║
║  Pipelines: {', '.join(running) if running else 'none running yet':<51}║
╠══════════════════════════════════════════════════════════════════╣
║  Start a session from the dashboard — this script just watches  ║
║  Press Ctrl+C any time → instant report                         ║
╚══════════════════════════════════════════════════════════════════╝
""")

    # Launch background monitor threads
    metrics  = Metrics()
    stop_evt = threading.Event()

    bg_threads = [
        threading.Thread(target=gpu_monitor,           args=(metrics, stop_evt), daemon=True, name="gpu-mon"),
        threading.Thread(target=sys_monitor,           args=(metrics, stop_evt), daemon=True, name="sys-mon"),
        threading.Thread(target=pipeline_stats_poller, args=(host, metrics, stop_evt), daemon=True, name="pipe-poll"),
        threading.Thread(target=csv_logger,            args=(metrics, stop_evt, csv_path), daemon=True, name="csv-log"),
    ]
    for t in bg_threads:
        t.start()

    # Main loop — print live stats + write snapshot every 15 min
    t0 = time.monotonic()
    snapshot_path = SNAPSHOT_FILE
    last_snapshot = 0
    try:
        while True:
            elapsed = int(time.monotonic() - t0)
            if duration > 0 and elapsed >= duration:
                break
            if elapsed > 0 and elapsed % PRINT_INTERVAL == 0:
                print_live(metrics, elapsed, duration)
            # 15-minute snapshot
            if elapsed > 0 and elapsed // SNAPSHOT_INTERVAL > last_snapshot:
                last_snapshot = elapsed // SNAPSHOT_INTERVAL
                write_snapshot(metrics, elapsed, snapshot_path)
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[MONITOR] Stopped — generating report…")

    # Report
    actual_duration = int(time.monotonic() - t0)
    stop_evt.set()
    print_final_report(metrics, actual_duration, csv_path)


if __name__ == "__main__":
    main()
# ── END TEMPORARY: Main ──────────────────────────────────────────────────────
