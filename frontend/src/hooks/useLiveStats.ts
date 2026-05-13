import { useState, useEffect, useRef, useCallback } from "react";
import { backendApi, PRODUCTION_CADENCE } from "@/core/backendApi";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineStats {
  pipeline_id: string;
  is_running: boolean;
  total_packets: number;
  packages_ok: number;
  packages_nok: number;
  nok_no_barcode: number;
  nok_no_date: number;
  nok_anomaly: number;
  stats_active: boolean;
  session_id: string | null;
  checkpoint_label: string;
  is_paused: boolean;
  fifo_queue: string[];
  perf: {
    video_fps: number;
    det_fps: number;
    inference_ms: number;
  };
  db_connected: boolean;
  enabled_checks: { barcode: boolean; date: boolean; anomaly: boolean };
  camera_available?: boolean;
}

export interface ActiveChecks {
  barcode: boolean;
  date: boolean;
  anomaly: boolean;
}

export interface LiveStats {
  p0: PipelineStats | null;
  p1: PipelineStats | null;
  totalPackets: number;
  conformes: number;
  nokBarcode: number;
  nokDate: number;
  nokAnomaly: number;
  totalNok: number;
  conformityPct: number;
  cadence: number;
  isRunning: boolean;
  isPrewarmed: boolean;  // pipeline running but stats NOT recording (pre-warm state)
  sessionId0: string | null;
  sessionId1: string | null;
  fifoQueue: string[];
  dbConnected: boolean;
  activeChecks: ActiveChecks;
  loading: boolean;
  error: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const PIPELINE_IDS = {
  barcodeDate: "pipeline_barcode_date",
  anomaly: "pipeline_anomaly",
} as const;

// Polling cadence used only as a fallback when SSE is unavailable
// (older browsers, corporate proxies that strip text/event-stream, etc.)
const FALLBACK_POLL_MS = 1500;

// SSE event payload — subset of PipelineStats emitted by backend/stats_bus.
// See backend/detection/base.py :: TrackingState._publish_stats.
interface StatsEvent {
  pipeline_id: string;
  is_running: boolean;
  stats_active: boolean;
  session_id: string | null;
  total_packets: number;
  packages_ok: number;
  packages_nok: number;
  nok_no_barcode: number;
  nok_no_date: number;
  nok_anomaly: number;
  fifo_queue: string[];
  enabled_checks: ActiveChecks;
  perf: { video_fps: number; det_fps: number; inference_ms: number };
  checkpoint_label: string;
  source?: "crossing" | "tick";
  dropped?: number;
}

function mergePipeline(
  prev: PipelineStats | null,
  evt: StatsEvent,
): PipelineStats {
  // Spread `prev` first so fields not carried by the SSE event
  // (is_paused, db_connected, camera_available) are preserved from the
  // initial HTTP fetch and never clobbered by undefined.
  return {
    ...(prev ?? ({} as PipelineStats)),
    pipeline_id: evt.pipeline_id,
    is_running: evt.is_running,
    stats_active: evt.stats_active,
    session_id: evt.session_id,
    total_packets: evt.total_packets,
    packages_ok: evt.packages_ok,
    packages_nok: evt.packages_nok,
    nok_no_barcode: evt.nok_no_barcode,
    nok_no_date: evt.nok_no_date,
    nok_anomaly: evt.nok_anomaly,
    fifo_queue: evt.fifo_queue,
    enabled_checks: evt.enabled_checks,
    perf: { ...(prev?.perf ?? { video_fps: 0, det_fps: 0, inference_ms: 0 }), ...evt.perf },
    checkpoint_label: evt.checkpoint_label,
  };
}

export function useLiveStats(): LiveStats {
  const [p0, setP0] = useState<PipelineStats | null>(null);
  const [p1, setP1] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fallback polling handle — only populated if SSE fails to connect.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Guard against React-18 StrictMode double-mount reopening SSE twice.
  const mountedRef = useRef(false);

  const fetchInitial = useCallback(async () => {
    try {
      const [r0, r1] = await Promise.all([
        backendApi.getPipelineStats(PIPELINE_IDS.barcodeDate) as Promise<PipelineStats>,
        backendApi.getPipelineStats(PIPELINE_IDS.anomaly).catch(() => null) as Promise<PipelineStats | null>,
      ]);
      setP0(r0);
      setP1(r1);
      setError(null);
    } catch (e) {
      // Keep previous p0/p1 — only update the error string.
      setError((e as Error).message ?? "Erreur de connexion");
    } finally {
      setLoading(false);
    }
  }, []);

  const startFallbackPolling = useCallback(() => {
    if (pollIntervalRef.current) return;
    pollIntervalRef.current = setInterval(fetchInitial, FALLBACK_POLL_MS);
  }, [fetchInitial]);

  const stopFallbackPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    // 1. One HTTP fetch for immediate paint — fills is_paused, db_connected,
    //    camera_available fields that the SSE event doesn't carry.
    fetchInitial();

    // 2. Browsers without EventSource (rare in 2025 but cheap to guard) fall
    //    straight to polling — same cadence as the pre-SSE behaviour.
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      startFallbackPolling();
      return () => {
        stopFallbackPolling();
      };
    }

    // 3. Open the SSE stream. EventSource auto-reconnects on drops; we only
    //    swap to polling if we've never managed to connect or the browser
    //    declares the stream permanently closed.
    const es = new EventSource("/api/stats/stream");
    esRef.current = es;

    const onOpen = () => {
      // Once we're connected, cancel any fallback poll that was covering us.
      stopFallbackPolling();
      setError(null);
    };

    const onStats = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as StatsEvent;
        if (data.pipeline_id === PIPELINE_IDS.barcodeDate) {
          setP0((prev) => mergePipeline(prev, data));
        } else if (data.pipeline_id === PIPELINE_IDS.anomaly) {
          setP1((prev) => mergePipeline(prev, data));
        }
        setLoading(false);
      } catch {
        // Ignore a malformed event — the next one will fix it.
      }
    };

    const onError = () => {
      // EventSource.readyState:
      //   0 = CONNECTING (transient — will auto-retry, don't panic)
      //   2 = CLOSED      (permanent — fall back to polling)
      if (es.readyState === EventSource.CLOSED) {
        setError("Realtime stream closed — falling back to polling");
        startFallbackPolling();
      }
      // readyState === 0 is handled by EventSource's built-in reconnect.
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("stats", onStats as EventListener);
    es.addEventListener("error", onError);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("stats", onStats as EventListener);
      es.removeEventListener("error", onError);
      es.close();
      esRef.current = null;
      stopFallbackPolling();
      mountedRef.current = false;
    };
  }, [fetchInitial, startFallbackPolling, stopFallbackPolling]);

  // Barcode/date pipeline (p0) is the sole source of truth for packet count.
  // It is the last checkpoint on the line — every packet crosses it.
  // Anomaly pipeline (p1) only contributes its NOK anomaly count.
  const totalPackets = p0?.total_packets ?? 0;
  const nokBarcode = p0?.nok_no_barcode ?? 0;
  const nokDate = p0?.nok_no_date ?? 0;
  const nokAnomaly = p1?.nok_anomaly ?? 0;
  const totalNok = nokBarcode + nokDate + nokAnomaly;
  // conformes = packets confirmed OK by p0 (barcode+date).
  // Using packages_ok directly avoids negative counts when p0 total < sum of NOK types.
  const conformes = p0?.packages_ok ?? 0;
  const conformityPct =
    totalPackets > 0
      ? Math.round((conformes / totalPackets) * 100 * 100) / 100
      : 0;

  return {
    p0,
    p1,
    totalPackets,
    conformes,
    nokBarcode,
    nokDate,
    nokAnomaly,
    totalNok,
    conformityPct,
    cadence: PRODUCTION_CADENCE,
    isRunning: Boolean(p0?.stats_active || p1?.stats_active),
    isPrewarmed: Boolean(
      (p0?.is_running && !p0?.stats_active) ||
      (p1?.is_running && !p1?.stats_active)
    ),
    sessionId0: p0?.session_id ?? null,
    sessionId1: p1?.session_id ?? null,
    fifoQueue: p0?.fifo_queue ?? [],
    dbConnected: p0?.db_connected ?? p1?.db_connected ?? true,
    activeChecks: {
      barcode: p0?.stats_active ? (p0.enabled_checks?.barcode ?? true) : false,
      date:    p0?.stats_active ? (p0.enabled_checks?.date    ?? true) : false,
      anomaly: p1?.stats_active ? (p1.enabled_checks?.anomaly ?? true) : false,
    },
    loading,
    error,
  };
}
