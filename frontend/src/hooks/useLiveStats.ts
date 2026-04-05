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
  loading: boolean;
  error: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const POLL_MS = 1500;

export function useLiveStats(): LiveStats {
  const [p0, setP0] = useState<PipelineStats | null>(null);
  const [p1, setP1] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [r0, r1] = await Promise.all([
        backendApi.getPipelineStats("pipeline_barcode_date") as Promise<PipelineStats>,
        backendApi.getPipelineStats("pipeline_anomaly").catch(() => null) as Promise<PipelineStats | null>,
      ]);
      setP0(r0);
      setP1(r1);
      setError(null);
    } catch (e) {
      // keep previous p0/p1 — only update the error string
      setError((e as Error).message ?? "Erreur de connexion");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  // Barcode/date pipeline (p0) is the sole source of truth for packet count.
  // It is the last checkpoint on the line — every packet crosses it.
  // Anomaly pipeline (p1) only contributes its NOK anomaly count.
  const totalPackets = p0?.total_packets ?? 0;
  const nokBarcode = p0?.nok_no_barcode ?? 0;
  const nokDate = p0?.nok_no_date ?? 0;
  const nokAnomaly = p1?.nok_anomaly ?? 0;
  const totalNok = nokBarcode + nokDate + nokAnomaly;
  const conformes = totalPackets - totalNok;
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
    loading,
    error,
  };
}
