import { useState, useEffect, useCallback, useRef } from "react";
import { oneOffApi, BackendOneOff, CreateOneOffPayload } from "@/core/backendApi";
import { OneOffSession } from "@/pages/gmcb/gmcbData";
import { useOneOffBroadcast } from "./useSyncBroadcast";

function backendToOneOff(s: BackendOneOff): OneOffSession {
  return {
    id: s.id,
    name: s.label,
    date: s.date,
    start: s.start_time,
    end: s.end_time,
    autoStart: true,
    createdAt: s.created_at,
  };
}

export interface UseOneOffSessionsReturn {
  oneOffSessions: OneOffSession[];
  loading: boolean;
  addOneOff: (payload: CreateOneOffPayload) => Promise<OneOffSession>;
  updateOneOff: (id: string, fields: { start_time?: string; end_time?: string }) => Promise<void>;
  removeOneOff: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useOneOffSessions(): UseOneOffSessionsReturn {
  const [oneOffSessions, setOneOffSessions] = useState<OneOffSession[]>([]);
  const [loading, setLoading] = useState(true);
  const mutating = useRef(false);

  const silentLoad = useCallback(async () => {
    if (mutating.current) return;
    try {
      const { sessions } = await oneOffApi.list();
      setOneOffSessions(sessions.map(backendToOneOff));
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { sessions } = await oneOffApi.list();
      setOneOffSessions(sessions.map(backendToOneOff));
    } catch (e) {
      console.error("[useOneOffSessions] load error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const broadcast = useOneOffBroadcast(silentLoad);

  // Initial load + silent poll every 30 s as cross-device fallback
  useEffect(() => {
    load();
    const id = setInterval(silentLoad, 30_000);
    return () => { clearInterval(id); broadcast.close(); };
  }, [load, silentLoad]);

  const addOneOff = useCallback(async (payload: CreateOneOffPayload) => {
    mutating.current = true;
    try {
      const { session } = await oneOffApi.create(payload);
      const mapped = backendToOneOff(session);
      setOneOffSessions((prev) => [...prev, mapped]);
      broadcast.notify();
      return mapped;
    } finally { mutating.current = false; }
  }, [broadcast]);

  const updateOneOff = useCallback(async (id: string, fields: { start_time?: string; end_time?: string }) => {
    mutating.current = true;
    try {
      await oneOffApi.update(id, fields);
      setOneOffSessions((prev) => prev.map((s) =>
        s.id === id
          ? { ...s, ...(fields.start_time && { start: fields.start_time }), ...(fields.end_time && { end: fields.end_time }) }
          : s
      ));
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [broadcast]);

  const removeOneOff = useCallback(async (id: string) => {
    mutating.current = true;
    try {
      await oneOffApi.delete(id);
      setOneOffSessions((prev) => prev.filter((s) => s.id !== id));
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [broadcast]);

  return { oneOffSessions, loading, addOneOff, updateOneOff, removeOneOff, reload: load };
}
