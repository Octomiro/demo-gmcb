import { useState, useEffect, useCallback } from "react";
import { backendApi } from "@/core/backendApi";
import { getTunisiaIsoDateFromTimestamp } from "@/pages/gmcb/gmcbData";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  id: string;           // group_id for merged sessions, raw uuid for legacy
  group_id?: string;
  shift_id?: string;
  session_ids?: string[]; // raw pipeline session ids inside this group
  started_at: string;
  ended_at: string | null;
  end_reason?: string | null;   // 'preempted' | 'interrupted' | 'camera_unavailable' | null (normal stop)
  checkpoint_id: string;
  checkpoint_ids?: string[]; // all checkpoints in the group (e.g. ["barcode_date","anomaly"])
  camera_source: string;
  total: number;
  ok_count: number;
  nok_no_barcode: number;
  nok_no_date: number;
  nok_anomaly: number;
  enabled_checks?: { barcode: boolean; date: boolean; anomaly: boolean } | null;
  sessions?: Session[];  // raw sub-sessions inside a merged group
}

export interface DaySummary {
  date: string;
  sessions: Session[];
  totalPackets: number;
  totalConformes: number;
  totalAnomalies: number;
  sessionCount: number;
  conformityPct: number;
}

export interface UseSessionHistoryReturn {
  sessions: Session[];
  days: DaySummary[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupByDate(sessions: Session[]): DaySummary[] {
  const map = new Map<string, Session[]>();

  for (const s of sessions) {
    const date = getTunisiaIsoDateFromTimestamp(s.started_at);
    if (!date) continue;
    const arr = map.get(date);
    if (arr) arr.push(s);
    else map.set(date, [s]);
  }

  const days: DaySummary[] = [];
  for (const [date, group] of map) {
    const totalPackets = group.reduce((sum, s) => sum + (s.total ?? 0), 0);
    const totalConformes = group.reduce((sum, s) => sum + (s.ok_count ?? 0), 0);
    const totalAnomalies = group.reduce(
      (sum, s) =>
        sum +
        (s.nok_no_barcode ?? 0) +
        (s.nok_no_date ?? 0) +
        (s.nok_anomaly ?? 0),
      0,
    );
    days.push({
      date,
      sessions: group,
      totalPackets,
      totalConformes,
      totalAnomalies,
      sessionCount: group.length,
      conformityPct:
        totalPackets > 0
          ? Math.round((totalConformes / totalPackets) * 100 * 100) / 100
          : 0,
    });
  }

  // Most recent first
  days.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
  return days;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSessionHistory(): UseSessionHistoryReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [days, setDays] = useState<DaySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = (await backendApi.getSessions(100)) as { sessions: Session[] };
      const list = data?.sessions ?? [];
      setSessions(list);
      setDays(groupByDate(list));
    } catch (e) {
      setError((e as Error).message ?? "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { sessions, days, loading, error, refetch: load };
}
