import { useState, useEffect, useCallback, useRef } from "react";
import { shiftsApi, variantsApi, BackendShift, BackendVariant, CreateShiftPayload, UpdateShiftPayload, CreateVariantPayload } from "@/core/backendApi";
import { RecurringRule, RuleVariant, todayIso, addDays } from "@/pages/gmcb/gmcbData";
import { useShiftsBroadcast } from "./useSyncBroadcast";

// ─── Mapping backend ↔ frontend ───────────────────────────────────────────────

function backendVariantToRuleVariant(v: BackendVariant): RuleVariant {
  let weekdays: string[] = [];
  try {
    const parsed = JSON.parse(v.days_of_week);
    weekdays = Array.isArray(parsed) ? parsed : [];
  } catch {
    weekdays = [];
  }
  return {
    id: v.id,
    kind: v.kind,
    // active: undefined means not set (timing variants), true/false for availability
    ...(v.active !== undefined && v.active !== null && { active: v.active === 1 }),
    ...(v.start_time !== undefined && v.start_time !== null && { start: v.start_time }),
    ...(v.end_time !== undefined && v.end_time !== null && { end: v.end_time }),
    startDate: v.start_date,
    endDate: v.end_date,
    weekdays,
  };
}

function backendToRule(s: BackendShift): RecurringRule {
  let weekdays: string[] = [];
  try {
    const parsed = JSON.parse(s.days_of_week);
    weekdays = Array.isArray(parsed) ? parsed : [];
  } catch {
    weekdays = [];
  }
  return {
    id: s.id,
    name: s.label,
    start: s.start_time,
    end: s.end_time,
    startDate: s.start_date ?? todayIso(),
    endDate: s.end_date ?? addDays(todayIso(), 365),
    weekdays,
    autoStart: true,
    active: s.active === 1,
    variants: (s.variants ?? []).map(backendVariantToRuleVariant),
    // keep raw fields for writes
    _camera_source: s.camera_source,
    _checkpoint_id: s.checkpoint_id,
  } as RecurringRule & { _camera_source: string; _checkpoint_id: string };
}

function ruleDraftToPayload(draft: {
  name: string;
  start: string;
  end: string;
  startDate?: string;
  endDate?: string;
  weekdays: string[];
  camera_source?: string;
  checkpoint_id?: string;
}): CreateShiftPayload {
  return {
    label: draft.name,
    start_time: draft.start,
    end_time: draft.end,
    ...(draft.startDate !== undefined && { start_date: draft.startDate }),
    ...(draft.endDate !== undefined && { end_date: draft.endDate }),
    days_of_week: draft.weekdays,
    ...(draft.camera_source !== undefined && { camera_source: draft.camera_source }),
    ...(draft.checkpoint_id !== undefined && { checkpoint_id: draft.checkpoint_id }),
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type ShiftSaveError = string | null;

export type VariantDraft = {
  kind: "timing" | "availability";
  active?: boolean;
  start?: string;
  end?: string;
  startDate: string;
  endDate: string;
  weekdays: string[];
};

export interface UseShiftsReturn {
  shifts: RecurringRule[];
  loading: boolean;
  error: ShiftSaveError;
  createShift: (draft: {
    name: string; start: string; end: string; startDate?: string; endDate?: string; weekdays: string[];
    camera_source?: string; checkpoint_id?: string;
  }) => Promise<RecurringRule>;
  updateShift: (
    id: string,
    fields: Partial<{ name: string; start: string; end: string; startDate: string; endDate: string; weekdays: string[]; camera_source?: string; checkpoint_id?: string; }>
  ) => Promise<RecurringRule>;
  deleteShift: (id: string) => Promise<void>;
  toggleShift: (id: string) => Promise<boolean>;
  /** Create a per-day exception variant for a shift. Reloads the shift list. */
  createVariant: (shiftId: string, draft: VariantDraft) => Promise<void>;
  /** Update an existing variant by id. Reloads the shift list. */
  updateVariant: (shiftId: string, variantId: string, draft: Partial<VariantDraft>) => Promise<void>;
  /** Delete a variant by id. Reloads the shift list. */
  deleteVariant: (shiftId: string, variantId: string) => Promise<void>;
  /** Delete a variant without reload — call refreshAfterBatch() when done. */
  deleteVariantRaw: (shiftId: string, variantId: string) => Promise<void>;
  /** Reload shifts + broadcast once after a batch of raw mutations. */
  refreshAfterBatch: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useShifts(): UseShiftsReturn {
  const [shifts, setShifts] = useState<RecurringRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShiftSaveError>(null);
  // Track if a mutation is in flight so background poll doesn't clobber optimistic state
  const mutating = useRef(false);

  const silentLoad = useCallback(async () => {
    if (mutating.current) return;
    try {
      const { shifts: raw } = await shiftsApi.list();
      setShifts(raw.map(backendToRule));
    } catch { /* ignore background errors */ }
  }, []);

  /** Reload that ignores the mutating guard — for use inside mutation callbacks. */
  const forceLoad = useCallback(async () => {
    try {
      const { shifts: raw } = await shiftsApi.list();
      setShifts(raw.map(backendToRule));
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { shifts: raw } = await shiftsApi.list();
      setShifts(raw.map(backendToRule));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // BroadcastChannel: other tabs notify us when they mutate
  const broadcast = useShiftsBroadcast(silentLoad);

  // Initial load + silent poll every 30 s as cross-device fallback
  useEffect(() => {
    load();
    const id = setInterval(silentLoad, 30_000);
    return () => { clearInterval(id); broadcast.close(); };
  }, [load, silentLoad]);

  const createShift = useCallback(async (draft: {
    name: string; start: string; end: string; startDate?: string; endDate?: string; weekdays: string[];
    camera_source?: string; checkpoint_id?: string;
  }) => {
    mutating.current = true;
    try {
      const { shift: raw } = await shiftsApi.create(ruleDraftToPayload(draft));
      const rule = backendToRule(raw);
      setShifts((prev) => [...prev, rule]);
      broadcast.notify();
      return rule;
    } finally { mutating.current = false; }
  }, [broadcast]);

  const updateShift = useCallback(async (id: string, fields: Partial<{
    name: string; start: string; end: string; startDate: string; endDate: string; weekdays: string[];
    camera_source?: string; checkpoint_id?: string;
  }>) => {
    const payload: UpdateShiftPayload = {
      ...(fields.name !== undefined && { label: fields.name }),
      ...(fields.start !== undefined && { start_time: fields.start }),
      ...(fields.end !== undefined && { end_time: fields.end }),
      ...(fields.startDate !== undefined && { start_date: fields.startDate }),
      ...(fields.endDate !== undefined && { end_date: fields.endDate }),
      ...(fields.weekdays !== undefined && { days_of_week: fields.weekdays }),
      ...(fields.camera_source !== undefined && { camera_source: fields.camera_source }),
      ...(fields.checkpoint_id !== undefined && { checkpoint_id: fields.checkpoint_id }),
    };
    mutating.current = true;
    try {
      const { shift: raw } = await shiftsApi.update(id, payload);
      const rule = backendToRule(raw);
      setShifts((prev) => prev.map((r) => r.id === id ? { ...rule, variants: r.variants } : r));
      broadcast.notify();
      return rule;
    } finally { mutating.current = false; }
  }, [broadcast]);

  const deleteShift = useCallback(async (id: string) => {
    mutating.current = true;
    try {
      await shiftsApi.delete(id);
      setShifts((prev) => prev.filter((r) => r.id !== id));
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [broadcast]);

  const toggleShift = useCallback(async (id: string) => {
    mutating.current = true;
    try {
      const { active } = await shiftsApi.toggle(id);
      const isActive = active === 1;
      setShifts((prev) => prev.map((r) => r.id === id ? { ...r, active: isActive } : r));
      broadcast.notify();
      return isActive;
    } finally { mutating.current = false; }
  }, [broadcast]);

  function variantDraftToPayload(draft: Partial<VariantDraft>): Partial<CreateVariantPayload> {
    return {
      ...(draft.kind !== undefined && { kind: draft.kind }),
      ...(draft.active !== undefined && { active: draft.active ? 1 : 0 }),
      ...(draft.start !== undefined && { start_time: draft.start }),
      ...(draft.end !== undefined && { end_time: draft.end }),
      ...(draft.startDate !== undefined && { start_date: draft.startDate }),
      ...(draft.endDate !== undefined && { end_date: draft.endDate }),
      ...(draft.weekdays !== undefined && { days_of_week: draft.weekdays }),
    };
  }

  const createVariant = useCallback(async (shiftId: string, draft: VariantDraft) => {
    const payload = variantDraftToPayload(draft) as CreateVariantPayload;
    mutating.current = true;
    try {
      await variantsApi.create(shiftId, payload);
      await forceLoad();
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [forceLoad, broadcast]);

  const updateVariant = useCallback(async (shiftId: string, variantId: string, draft: Partial<VariantDraft>) => {
    mutating.current = true;
    try {
      await variantsApi.update(shiftId, variantId, variantDraftToPayload(draft));
      await forceLoad();
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [forceLoad, broadcast]);

  const deleteVariant = useCallback(async (shiftId: string, variantId: string) => {
    mutating.current = true;
    try {
      await variantsApi.delete(shiftId, variantId);
      await forceLoad();
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [forceLoad, broadcast]);

  /** Delete a variant without reloading — caller must call refreshAfterBatch() when done. */
  const deleteVariantRaw = useCallback(async (shiftId: string, variantId: string) => {
    mutating.current = true;
    await variantsApi.delete(shiftId, variantId);
  }, []);

  /** Call after a batch of raw mutations to reload + broadcast once. */
  const refreshAfterBatch = useCallback(async () => {
    try {
      await forceLoad();
      broadcast.notify();
    } finally { mutating.current = false; }
  }, [forceLoad, broadcast]);

  return { shifts, loading, error, createShift, updateShift, deleteShift, toggleShift, createVariant, updateVariant, deleteVariant, deleteVariantRaw, refreshAfterBatch, reload: load };
}
