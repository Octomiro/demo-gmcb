import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ShieldCheck, Play, Square, Repeat, Calendar, AlertCircle, Plus,
  ChevronLeft, ChevronRight, Trash2, Loader2, Zap, Clock, X,
} from "lucide-react";
import {
  ADMIN_WEEKDAYS, ADMIN_SHIFT_OPTIONS,
  todayIso, formatAdminDate, formatAdminMonth, addDays, formatTunisiaTime, formatStopCountdown,
  weekdayKeyFromIso, getMonthDays, isPastIsoDate, sortWeekdays,
  getTunisiaCurrentMinutes,
  buildRuleSession, getSessionsForDate, getActiveSessions,
  getShiftBadgeColor, getRuleScheduleSummaries, getNextShiftNameForDate,
  getDefaultRuleDraft, getDefaultSingleDraft, getDefaultRuleActionDraft,
  isSingleDateAvailabilityVariant, isSingleDateTimingVariant,
  ruleVariantApplies,
  type RecurringRule, type OneOffSession, type PlannedSession,
} from "./gmcbData";
import {
  StatCard, DashboardPanel, AdminActionCard, AdminModal,
} from "./gmcbComponents";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useShifts } from "@/hooks/useShifts";
import { useOneOffSessions } from "@/hooks/useOneOffSessions";
import { useLiveStats } from "@/hooks/useLiveStats";
import { useSessionHistory, type DaySummary, type Session } from "@/hooks/useSessionHistory";
import { backendApi } from "@/core/backendApi";
import { useGMCBFeedback } from "@/contexts/GMCBFeedbackContext";
import { HistDayModal } from "./GMCBHistorique";


interface RuleActionModalState {
  open: boolean; mode: string; ruleId: string | null;
  variantId: string | null;
  draft: { start: string; end: string; startDate: string; endDate: string; weekdays: string[] };
}

function timeToMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

const GMCBAdmin = () => {

  const navigate = useNavigate();
  const today = todayIso();
  const stats = useLiveStats();
  const { days: historyDays } = useSessionHistory();
  const { openFeedbackModal } = useGMCBFeedback();
  const [historyDay, setHistoryDay] = useState<DaySummary | null>(null);
  const [planningModalOpen, setPlanningModalOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [prewarmLoading, setPrewarmLoading] = useState(false);
  const [guardStale, setGuardStale] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);
  const [monthCursor, setMonthCursor] = useState(today.slice(0, 7));
  const [now, setNow] = useState(() => new Date());

  // ── Shifts from backend ──────────────────────────────────────────────────
  const {
    shifts: recurringRules,
    loading: shiftsLoading,
    error: shiftsError,
    createShift,
    updateShift,
    deleteShift,
    toggleShift,
    createVariant,
    updateVariant,
    deleteVariant,
    deleteVariantRaw,
    refreshAfterBatch,
  } = useShifts();

  // One-off sessions — persisted to backend
  const { oneOffSessions, addOneOff, updateOneOff, removeOneOff } = useOneOffSessions();
  const [editingOneOffId, setEditingOneOffId] = useState<string | null>(null);
  const [oneOffEditDraft, setOneOffEditDraft] = useState<{ start: string; end: string; date: string }>({ start: "", end: "", date: "" });
  const [editingRuleForDate, setEditingRuleForDate] = useState<{ ruleId: string; date: string; start: string; end: string; variantId?: string } | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState(() => getDefaultRuleDraft(today));
  const [singleDraft, setSingleDraft] = useState(() => getDefaultSingleDraft(selectedDate));
  const [recurringModalOpen, setRecurringModalOpen] = useState(false);
  const [singleModalOpen, setSingleModalOpen] = useState(false);
  const [ruleActionModal, setRuleActionModal] = useState<RuleActionModalState>({
    open: false, mode: "timing", ruleId: null, variantId: null,
    draft: getDefaultRuleActionDraft(today),
  });
  const [shiftToDelete, setShiftToDelete] = useState<{ id: string, type: 'recurring' | 'single' } | null>(null);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [confirmSessionOpen, setConfirmSessionOpen] = useState(false);
  // Which checks to enforce for the session (barcode/date independent, anomaly = pipeline_1)
  const [enabledChecks, setEnabledChecks] = useState({ barcode: true, date: true, anomaly: true });
  const [scheduledStop, setScheduledStop] = useState<string | null>(null);
  const [stopTimeInput, setStopTimeInput] = useState("");
  const [adminStopPickerOpen, setAdminStopPickerOpen] = useState(false);
  const [adminStopTimeInput, setAdminStopTimeInput] = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const sessionStartedAtRef = useRef<string | null>(null);

  const selectedSessions = getSessionsForDate(selectedDate, recurringRules, oneOffSessions);
  const selectedActiveSessions = getActiveSessions(selectedSessions);
  const todaySessions = getSessionsForDate(today, recurringRules, oneOffSessions);
  const todayActiveSessions = getActiveSessions(todaySessions);
  const selectedDateIsPast = isPastIsoDate(selectedDate, today);
  const nextShiftName = getNextShiftNameForDate(selectedDate, recurringRules, oneOffSessions);
  const activeRulesCount = getActiveSessions(todaySessions).filter((s) => s.source === "rule").length;
  const todayWeekday = weekdayKeyFromIso(today);
  const exceptionCount = recurringRules.reduce((t, r) => t + (r.variants || []).filter((v) => v.kind === "availability" && !v.active && ruleVariantApplies(v, today, todayWeekday)).length, 0);
  const monthDays = getMonthDays(monthCursor);
  const selectedRuleForAction = recurringRules.find((r) => r.id === ruleActionModal.ruleId) || null;
  const shiftToDeleteLabel = shiftToDelete
    ? shiftToDelete.type === "recurring"
      ? recurringRules.find((rule) => rule.id === shiftToDelete.id)?.name
      : oneOffSessions.find((session) => session.id === shiftToDelete.id)?.name
    : null;
  const currentMinutes = getTunisiaCurrentMinutes(now);

  // Track session start time
  useEffect(() => {
    if (stats.isRunning) {
      if (!sessionStartedAtRef.current) {
        const t = formatTunisiaTime(new Date(), true);
        sessionStartedAtRef.current = t;
        setSessionStartedAt(t);
      }
    } else {
      sessionStartedAtRef.current = null;
      setSessionStartedAt(null);
      setScheduledStop(null);
    }
  }, [stats.isRunning]);

  // Fetch scheduled stop when modal opens
  useEffect(() => {
    if (sessionModalOpen && stats.isRunning) {
      backendApi.getScheduledStop().then(r => {
        setScheduledStop(r.scheduled_stop);
        if (r.scheduled_stop) {
          const d = new Date(r.scheduled_stop);
          setStopTimeInput(`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`);
        }
      }).catch(() => {});
    }
  }, [sessionModalOpen, stats.isRunning]);

  // Keep scheduledStop in sync every 30s while session is running
  useEffect(() => {
    if (!stats.isRunning) { setScheduledStop(null); return; }
    const sync = () => backendApi.getScheduledStop().then(r => setScheduledStop(r.scheduled_stop ?? null)).catch(() => {});
    sync();
    const id = setInterval(sync, 30_000);
    return () => clearInterval(id);
  }, [stats.isRunning]);

  useEffect(() => {
    if (!singleModalOpen && !selectedDateIsPast) {
      setSingleDraft((c) => ({ ...c, date: selectedDate }));
    }
  }, [selectedDate, selectedDateIsPast, singleModalOpen]);

  useEffect(() => {
    const intervalId = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(intervalId);
  }, []);

  // Poll session guard state every 30s to detect stuck guard
  useEffect(() => {
    let cancelled = false;
    async function checkGuard() {
      try {
        const s = await backendApi.sessionStatus();
        if (!cancelled) setGuardStale(Boolean(s.guard_stale));
      } catch { /* backend unreachable, ignore */ }
    }
    checkGuard();
    const id = setInterval(checkGuard, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function startSession() {
    setSessionLoading(true);
    try {
      if (!enabledChecks.barcode && !enabledChecks.date && !enabledChecks.anomaly) {
        toast.error("Activez au moins un contrôle avant de démarrer.");
        return;
      }
      // Derive which physical pipelines to start from enabled checks
      const enabledPipelines: string[] = [];
      if (enabledChecks.barcode || enabledChecks.date) enabledPipelines.push("pipeline_barcode_date");
      if (enabledChecks.anomaly) enabledPipelines.push("pipeline_anomaly");
      await backendApi.startAll(undefined, enabledPipelines, enabledChecks);
      await backendApi.toggleRecording();
    } catch {
      toast.error("Impossible de démarrer la session. Vérifiez que le système est en ligne.");
    } finally {
      setSessionLoading(false);
    }
  }

  async function stopSession() {
    setSessionLoading(true);
    try {
      await backendApi.toggleRecording();
      await backendApi.stopAll();
    } catch {
      toast.error("Impossible d'arrêter la session. Réessayez dans un instant.");
    } finally {
      setSessionLoading(false);
    }
  }

  async function resetGuard() {
    try {
      await backendApi.resetSessionGuard();
      setGuardStale(false);
      toast.success("Verrou de session réinitialisé — les shifts automatiques peuvent de nouveau démarrer.");
    } catch {
      toast.error("Réinitialisation échouée. Réessayez.");
    }
  }

  async function prewarmModels() {    setPrewarmLoading(true);
    try {
      await backendApi.prewarm();
      toast.success("Modèles pré-chargés — pipelines actifs, enregistrement en attente du début du shift.");
    } catch {
      toast.error("Impossible de pré-démarrer les modèles. Vérifiez la connexion au système.");
    } finally {
      setPrewarmLoading(false);
    }
  }

  function toggleWeekday(key: string) {
    setRuleDraft((c) => ({ ...c, weekdays: c.weekdays.includes(key) ? c.weekdays.filter((k) => k !== key) : [...c.weekdays, key] }));
  }

  function openNewRecurringModal() {
    setEditingRuleId(null);
    const nextName = `Shift ${recurringRules.length + 1}`;
    setRuleDraft({ ...getDefaultRuleDraft(today), name: nextName });
    setRecurringModalOpen(true);
  }

  function openEditRecurringModal(rule: RecurringRule) {
    setEditingRuleId(rule.id); setRuleDraft({ name: rule.name, start: rule.start, end: rule.end, startDate: rule.startDate, endDate: rule.endDate, weekdays: sortWeekdays(rule.weekdays), enabledPipelines: rule.enabledPipelines ?? ["pipeline_barcode_date", "pipeline_anomaly"] }); setRecurringModalOpen(true);
  }

  function closeRecurringModal() { setEditingRuleId(null); setRuleDraft(getDefaultRuleDraft(today)); setRecurringModalOpen(false); }

  function openSingleModal() { if (selectedDateIsPast) return; setSingleDraft(getDefaultSingleDraft(selectedDate)); setSingleModalOpen(true); }
  function closeSingleModal() { setSingleDraft(getDefaultSingleDraft(selectedDate)); setSingleModalOpen(false); }

  function openRuleActionModal(rule: RecurringRule, mode: string, preset: Record<string, any> = {}) {
    setRuleActionModal({
      open: true, mode, ruleId: rule.id, variantId: preset.variantId || null,
      draft: { start: preset.start || rule.start, end: preset.end || rule.end, startDate: preset.startDate || selectedDate || today, endDate: preset.endDate || selectedDate || addDays(today, 30), weekdays: sortWeekdays(preset.weekdays || rule.weekdays) },
    });
  }

  function closeRuleActionModal() { setRuleActionModal({ open: false, mode: "timing", ruleId: null, variantId: null, draft: getDefaultRuleActionDraft(today) }); }

  function openExistingVariantModal(rule: RecurringRule, variant: any) {
    setRuleActionModal({
      open: true, mode: variant.kind === "timing" ? "timing" : "disable", ruleId: rule.id, variantId: variant.id,
      draft: { start: variant.start || rule.start, end: variant.end || rule.end, startDate: variant.startDate, endDate: variant.endDate, weekdays: sortWeekdays(variant.weekdays) },
    });
  }

  function toggleRuleActionWeekday(key: string) {
    setRuleActionModal((c) => ({ ...c, draft: { ...c.draft, weekdays: c.draft.weekdays.includes(key) ? c.draft.weekdays.filter((k) => k !== key) : sortWeekdays([...c.draft.weekdays, key]) } }));
  }

  async function addRecurringRule() {
    if (!ruleDraft.name || !ruleDraft.start || !ruleDraft.end || ruleDraft.weekdays.length === 0) return;
    if (ruleDraft.start >= ruleDraft.end) {
      toast.error("L'heure de début doit être avant l'heure de fin");
      return;
    }
    if (!editingRuleId) {
      // Duplicate check: same times + at least one overlapping weekday
      const newDays = new Set(ruleDraft.weekdays);
      const dup = recurringRules.find(
        (r) => r.start === ruleDraft.start && r.end === ruleDraft.end &&
          r.weekdays.some((d) => newDays.has(d))
      );
      if (dup) {
        toast.error(`Un shift identique existe déjà : ${dup.name} (${dup.start}–${dup.end})`);
        return;
      }
    }
    if (editingRuleId) {
      try {
        const updated = await updateShift(editingRuleId, {
          name: ruleDraft.name,
          start: ruleDraft.start,
          end: ruleDraft.end,
          startDate: ruleDraft.startDate,
          endDate: ruleDraft.endDate,
          weekdays: sortWeekdays(ruleDraft.weekdays),
          enabledPipelines: ruleDraft.enabledPipelines,
        });
        // Preserve local variants, trimming days no longer in the rule
        const allowed = new Set(updated.weekdays);
        // variants are local-only; callers keep their own state
      } catch {
        toast.error("Impossible de modifier ce shift. Réessayez.");
        return;
      }
      setEditingRuleId(null); setRuleDraft(getDefaultRuleDraft(today)); setRecurringModalOpen(false); return;
    }
    try {
      await createShift({
        name: ruleDraft.name,
        start: ruleDraft.start,
        end: ruleDraft.end,
        startDate: ruleDraft.startDate,
        endDate: ruleDraft.endDate,
        weekdays: sortWeekdays(ruleDraft.weekdays),
        enabledPipelines: ruleDraft.enabledPipelines,
      });
    } catch (err: any) {
      const raw = err?.message || "";
      // Extract backend JSON error from thrown message like '...409: {"error":"..."}'
      try {
        const jsonStr = raw.substring(raw.indexOf("{"));
        const parsed = JSON.parse(jsonStr);
        if (parsed.error) {
          toast.error(parsed.error, { duration: 8000 });
        } else {
          toast.error("Impossible de créer le shift. Réessayez.");
        }
      } catch {
        toast.error("Impossible de créer le shift. Réessayez.");
      }
      return;
    }
    toast.success("Shift créé avec succès.");
    setRuleDraft(getDefaultRuleDraft(today)); setRecurringModalOpen(false);
  }

  async function addSingleSession() {
    if (selectedDateIsPast || !singleDraft.date || !singleDraft.start || !singleDraft.end) return;
    if (singleDraft.start >= singleDraft.end) {
      toast.error("L'heure de début doit être avant l'heure de fin");
      return;
    }
    if (singleDraft.date === today && timeToMinutes(singleDraft.start) < currentMinutes) {
      toast.error("Impossible d'ajouter un shift ponctuel si son heure de début est déjà passée");
      return;
    }
    const existingForDay = getSessionsForDate(singleDraft.date, recurringRules, oneOffSessions);
    // Block exact duplicate (same start AND end)
    const exactDup = existingForDay.find(
      (s) => s.start === singleDraft.start && s.end === singleDraft.end
    );
    if (exactDup) {
      toast.error(`Ce créneau existe déjà : ${exactDup.name} (${exactDup.start}–${exactDup.end})`);
      return;
    }
    // Warn on overlap (but still allow)
    const overlapping = existingForDay.filter(
      (s) => s.start < singleDraft.end && singleDraft.start < s.end
    );
    if (overlapping.length > 0) {
      const names = overlapping.map((s) => `${s.name} (${s.start}–${s.end})`).join(", ");
      toast.warning(`Chevauchement détecté avec : ${names}`);
    }
    const name = getNextShiftNameForDate(singleDraft.date, recurringRules, oneOffSessions);
    try {
      await addOneOff({ label: name, date: singleDraft.date, start_time: singleDraft.start, end_time: singleDraft.end });
      toast.success(`${name} créé avec succès (${singleDraft.start}–${singleDraft.end})`);
      setSingleDraft(getDefaultSingleDraft(selectedDate));
      setSingleModalOpen(false);
    } catch (e) {
      const raw = (e as Error).message || "";
      try {
        const jsonStr = raw.substring(raw.indexOf("{"));
        const parsed = JSON.parse(jsonStr);
        if (parsed.error) {
          toast.error(parsed.error, { duration: 8000 });
        } else {
          toast.error("Impossible de créer le créneau. Réessayez.");
        }
      } catch {
        toast.error("Impossible de créer le créneau. Réessayez.");
      }
    }
  }

  async function confirmDeletion() {
    if (!shiftToDelete) return;
    const shiftLabel = shiftToDelete.type === "recurring"
      ? recurringRules.find((rule) => rule.id === shiftToDelete.id)?.name
      : oneOffSessions.find((session) => session.id === shiftToDelete.id)?.name;
    try {
      if (shiftToDelete.type === 'recurring') {
        await deleteShift(shiftToDelete.id);
        toast.success(`${shiftLabel || "Le shift"} supprimé avec succès`);
      } else {
        await removeOneOff(shiftToDelete.id);
        toast.success(`${shiftLabel || "Le shift"} supprimé avec succès`);
      }
    } catch {
      toast.error("Impossible de supprimer. Réessayez.");
    } finally {
      setShiftToDelete(null);
    }
  }

  function deleteRecurringRule(id: string) { setShiftToDelete({ id, type: 'recurring' }); }
  function deleteSingleSession(id: string) { setShiftToDelete({ id, type: 'single' }); }

  function openOneOffEditModal(session: { sourceId: string; start: string; end: string; date?: string }) {
    setEditingOneOffId(session.sourceId);
    const s = oneOffSessions.find((o) => o.id === session.sourceId);
    setOneOffEditDraft({ start: session.start, end: session.end, date: (s as any)?.date || session.date || selectedDate });
  }

  async function saveOneOffEdit() {
    if (!editingOneOffId) return;
    if (oneOffEditDraft.start >= oneOffEditDraft.end) {
      toast.error("L'heure de début doit être avant l'heure de fin");
      return;
    }
    try {
      await updateOneOff(editingOneOffId, { start_time: oneOffEditDraft.start, end_time: oneOffEditDraft.end });
      setEditingOneOffId(null);
    } catch {
      toast.error("Impossible de sauvegarder les horaires. Réessayez.");
    }
  }

  async function toggleRuleForSelectedDate(ruleId: string) {
    if (selectedDateIsPast) return;
    const wk = weekdayKeyFromIso(selectedDate);
    const rule = recurringRules.find((r) => r.id === ruleId);
    if (!rule) return;
    if (!rule.weekdays.includes(wk)) {
      const activeOnDays = sortWeekdays(rule.weekdays).map((k) => ADMIN_WEEKDAYS.find((d) => d.key === k)?.label).filter(Boolean).join(", ");
      toast.error(`"${rule.name}" n'est pas planifié ce jour — actif uniquement le ${activeOnDays}.`);
      return;
    }
    const session = getSessionsForDate(selectedDate, recurringRules, oneOffSessions).find((s) => s.source === "rule" && s.sourceId === ruleId);
    if (!session) return;
    try {
      // Delete any existing single-date availability variants for this exact date+weekday (raw = no reload per call)
      const exact = (rule.variants || []).filter((v) => isSingleDateAvailabilityVariant(v, selectedDate, wk));
      for (const v of exact) {
        await deleteVariantRaw(ruleId, v.id);
      }
      // After deleting, derive what the session looks like without those exact variants
      const filtered = (rule.variants || []).filter((v) => !isSingleDateAvailabilityVariant(v, selectedDate, wk));
      const base = buildRuleSession({ ...rule, variants: filtered }, selectedDate);
      const hasExact = exact.some((v) => v.active === true);
      if (session.disabled) {
        if (base.disabled) {
          await createVariant(ruleId, { kind: "availability", active: true, startDate: selectedDate, endDate: selectedDate, weekdays: [wk] });
        } else {
          await refreshAfterBatch();
        }
      } else {
        if (hasExact && base.disabled) {
          await refreshAfterBatch();
        } else {
          await createVariant(ruleId, { kind: "availability", active: false, startDate: selectedDate, endDate: selectedDate, weekdays: [wk] });
        }
      }
    } catch {
      toast.error("Impossible de modifier la disponibilité. Réessayez.");
      await refreshAfterBatch();
    }
  }

  function openRuleTimingForSelectedDate(ruleId: string) {
    if (selectedDateIsPast) return;
    const wk = weekdayKeyFromIso(selectedDate);
    const rule = recurringRules.find((r) => r.id === ruleId);
    const session = selectedSessions.find((s) => s.source === "rule" && s.sourceId === ruleId);
    if (!rule || !session) return;
    const existing = (rule.variants || []).find((v) => isSingleDateTimingVariant(v, selectedDate, wk));
    setEditingRuleForDate({
      ruleId,
      date: selectedDate,
      start: existing ? (existing.start || session.start) : session.start,
      end: existing ? (existing.end || session.end) : session.end,
      variantId: existing?.id,
    });
  }

  async function saveRuleTimingForDate() {
    if (!editingRuleForDate) return;
    if (editingRuleForDate.start >= editingRuleForDate.end) {
      toast.error("L'heure de début doit être avant l'heure de fin");
      return;
    }
    const rule = recurringRules.find((r) => r.id === editingRuleForDate.ruleId);
    if (!rule) return;
    const wk = weekdayKeyFromIso(editingRuleForDate.date);
    // Zombie check: if timing matches parent exactly, discard/delete
    if (editingRuleForDate.start === rule.start && editingRuleForDate.end === rule.end) {
      if (editingRuleForDate.variantId) {
        await deleteVariant(rule.id, editingRuleForDate.variantId);
        toast.success("Horaires réinitialisés aux horaires d'origine");
      }
      setEditingRuleForDate(null);
      return;
    }
    try {
      const payload = { kind: "timing" as const, start: editingRuleForDate.start, end: editingRuleForDate.end, startDate: editingRuleForDate.date, endDate: editingRuleForDate.date, weekdays: [wk] };
      if (editingRuleForDate.variantId) {
        await updateVariant(rule.id, editingRuleForDate.variantId, payload);
      } else {
        await createVariant(rule.id, payload);
      }
      toast.success("Horaires modifiés pour cette journée");
      setEditingRuleForDate(null);
    } catch {
      toast.error("Impossible de sauvegarder les horaires de ce jour. Réessayez.");
    }
  }

  async function saveRuleAction() {
    if (!selectedRuleForAction || ruleActionModal.draft.weekdays.length === 0) return;
    if (ruleActionModal.mode === "timing" && (!ruleActionModal.draft.start || !ruleActionModal.draft.end)) return;
    // Validate time order for timing variants
    if (ruleActionModal.mode === "timing" && ruleActionModal.draft.start >= ruleActionModal.draft.end) {
      toast.error("L'heure de début doit être avant l'heure de fin");
      return;
    }
    // Validate date range order
    if (ruleActionModal.draft.startDate > ruleActionModal.draft.endDate) {
      toast.error("La date de début doit être avant la date de fin");
      return;
    }
    // Validate customisation stays within parent shift's date range
    if (
      ruleActionModal.draft.startDate < selectedRuleForAction.startDate ||
      ruleActionModal.draft.endDate > selectedRuleForAction.endDate
    ) {
      toast.error(
        `La personnalisation doit rester dans la période du shift mère ` +
        `(${formatAdminDate(selectedRuleForAction.startDate, { day: "2-digit", month: "2-digit", year: "numeric" })} ` +
        `→ ${formatAdminDate(selectedRuleForAction.endDate, { day: "2-digit", month: "2-digit", year: "numeric" })})`
      );
      return;
    }
    // If timing matches parent shift exactly → this variant is redundant (zombie)
    // Delete it if it was an existing one, otherwise just discard silently
    if (
      ruleActionModal.mode === "timing" &&
      ruleActionModal.draft.start === selectedRuleForAction.start &&
      ruleActionModal.draft.end === selectedRuleForAction.end
    ) {
      if (ruleActionModal.variantId) {
        await deleteVariant(selectedRuleForAction.id, ruleActionModal.variantId);
      }
      closeRuleActionModal();
      return;
    }
    const draft = ruleActionModal.mode === "timing"
      ? { kind: "timing" as const, start: ruleActionModal.draft.start, end: ruleActionModal.draft.end, startDate: ruleActionModal.draft.startDate, endDate: ruleActionModal.draft.endDate, weekdays: sortWeekdays(ruleActionModal.draft.weekdays) }
      : { kind: "availability" as const, active: false, startDate: ruleActionModal.draft.startDate, endDate: ruleActionModal.draft.endDate, weekdays: sortWeekdays(ruleActionModal.draft.weekdays) };
    try {
      if (ruleActionModal.variantId) {
        await updateVariant(selectedRuleForAction.id, ruleActionModal.variantId, draft);
      } else {
        await createVariant(selectedRuleForAction.id, draft);
      }
    } catch {
      toast.error("Impossible de sauvegarder la personnalisation. Réessayez.");
      return;
    }
    closeRuleActionModal();
  }

  async function deleteRuleActionVariant() {
    if (!selectedRuleForAction || !ruleActionModal.variantId) return;
    await deleteVariant(selectedRuleForAction.id, ruleActionModal.variantId);
    closeRuleActionModal();
  }

  function changeMonth(step: number) {
    const d = new Date(`${monthCursor}-01T00:00:00`);
    d.setMonth(d.getMonth() + step);
    setMonthCursor(`${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}`);
  }

  return (
    <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#1a1a1a" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 50, height: 50, background: "linear-gradient(135deg,#0f766e,#0f172a)", borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 12px 30px rgba(15,118,110,0.22)" }}>
            <ShieldCheck size={24} color="white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: "#0f172a" }}>Admin Dashboard</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#667085" }}>Pilotage manuel, shifts automatiques, exceptions calendaires et consultation de l'historique.</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ padding: "9px 12px", borderRadius: 999, background: stats.isRunning ? "#ecfdf3" : stats.isPrewarmed ? "#fef9c3" : "#f8fafc", border: `1px solid ${stats.isRunning ? "#bbf7d0" : stats.isPrewarmed ? "#fde047" : "#e2e8f0"}`, fontSize: 12, fontWeight: 700, color: stats.isRunning ? "#15803d" : stats.isPrewarmed ? "#854d0e" : "#475569" }}>
            {stats.isRunning ? "Session active" : stats.isPrewarmed ? "Modèles préchauffés" : "Aucune session active"}
          </div>
          {!stats.isRunning && !stats.isPrewarmed && (
            <button onClick={prewarmModels} disabled={prewarmLoading} title="Démarrer les pipelines 2 min avant le shift (sans enregistrement)" style={{ border: "1px solid #fde047", borderRadius: 12, padding: "10px 14px", background: "#fefce8", color: "#854d0e", fontSize: 13, fontWeight: 700, cursor: prewarmLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: prewarmLoading ? 0.6 : 1 }}>
              {prewarmLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={15} />} Pré-démarrer
            </button>
          )}
          {stats.isRunning ? (
            <>
              {/* Programmer arrêt inline picker */}
              <div style={{ position: "relative" }}>
                {scheduledStop ? (
                  <button
                    onClick={async () => { await backendApi.scheduleStop(null); setScheduledStop(null); toast.success("Arrêt programmé annulé."); }}
                    style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#92400e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                    title="Cliquer pour annuler"
                  >
                    <Clock size={15} /> Arrêt à {formatTunisiaTime(scheduledStop)} <X size={13} />
                  </button>
                ) : (
                  <button
                    onClick={() => { setAdminStopPickerOpen(v => !v); }}
                    style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: adminStopPickerOpen ? "#78350f" : "#b45309", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <Clock size={15} /> Programmer arrêt
                  </button>
                )}
                {adminStopPickerOpen && !scheduledStop && (
                  <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 28px rgba(0,0,0,0.15)", padding: 16, zIndex: 200, minWidth: 230 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 10 }}>Heure d'arrêt automatique :</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input type="time" value={adminStopTimeInput} onChange={e => setAdminStopTimeInput(e.target.value)}
                        style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "7px 10px", fontSize: 14, fontWeight: 600 }} />
                      <button
                        disabled={!adminStopTimeInput}
                        onClick={async () => {
                          if (!adminStopTimeInput) return;
                          try {
                            const r = await backendApi.scheduleStop(adminStopTimeInput);
                            setScheduledStop(r.scheduled_stop);
                            setAdminStopPickerOpen(false);
                            setAdminStopTimeInput("");
                            toast.success(`Session s'arrêtera ${formatStopCountdown(r.scheduled_stop)}.`);
                          } catch { toast.error("Erreur lors de la programmation."); }
                        }}
                        style={{ background: "#b45309", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: adminStopTimeInput ? "pointer" : "not-allowed", opacity: adminStopTimeInput ? 1 : 0.5 }}
                      >OK</button>
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>Heure locale Tunisie (Africa/Tunis)</div>
                  </div>
                )}
              </div>
              <button onClick={stopSession} disabled={sessionLoading} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sessionLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: sessionLoading ? 0.6 : 1 }}>
                {sessionLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Square size={15} />} Arrêter maintenant
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setConfirmSessionOpen(true)} disabled={sessionLoading} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sessionLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: sessionLoading ? 0.6 : 1 }}>
                {sessionLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={15} />} Démarrer une session
              </button>
            </>
          )}
        </div>
      </div>

      {/* Shifts API status */}
      {shiftsLoading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "10px 14px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, fontSize: 13, color: "#0369a1" }}>
          <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Chargement des shifts depuis le backend…
        </div>
      )}
      {shiftsError && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>
          <AlertCircle size={15} /> Erreur backend : {shiftsError}
        </div>
      )}
      {guardStale && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, padding: "10px 14px", background: "#fff7ed", border: "1px solid #fdba74", borderRadius: 10, fontSize: 13, color: "#c2410c" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={15} />
            <span><strong>Verrou de session bloqué</strong> — le scheduleur ne peut pas lancer les shifts automatiques. Aucun pipeline n'est actif mais le verrou interne est resté ouvert (arrêt inattendu ou session manuelle non clôturée).</span>
          </div>
          <button onClick={resetGuard} style={{ flexShrink: 0, border: "1px solid #fdba74", borderRadius: 8, padding: "6px 12px", background: "#fff7ed", color: "#c2410c", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
            Réinitialiser le verrou
          </button>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14, marginBottom: 20 }}>
        <div onClick={() => { if (stats.isRunning) setSessionModalOpen(true); }} style={{ cursor: stats.isRunning ? "pointer" : "default" }}>
          <StatCard icon={<Play size={20} color="#0f766e" />} iconBg="#d1fae5" value={stats.isRunning ? "En cours" : stats.isPrewarmed ? "Préchauffé" : "En attente"} label={stats.isRunning ? "Session active — cliquer pour détails" : stats.isPrewarmed ? "Modèles actifs — enregistrement démarrera au début du shift" : "Prêt pour un démarrage manuel ou automatique"} />
        </div>
        <StatCard icon={<Repeat size={20} color="#1d4ed8" />} iconBg="#dbeafe" value={activeRulesCount} label="Shifts automatiques actifs aujourd'hui" />
        <StatCard icon={<Calendar size={20} color="#b45309" />} iconBg="#fef3c7" value={todayActiveSessions.length} label="Shifts actifs aujourd'hui" />
        <StatCard icon={<AlertCircle size={20} color="#dc2626" />} iconBg="#fee2e2" value={exceptionCount} label="Exceptions et désactivations enregistrées" />
      </div>

      {/* Session Info Modal */}
      {sessionModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.7)", backdropFilter: "blur(8px)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => setSessionModalOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 480, maxWidth: "94vw", padding: "28px 32px", boxShadow: "0 24px 80px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#0f172a" }}>Session active</h3>
              <button onClick={() => setSessionModalOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}><X size={18} color="#94a3b8" /></button>
            </div>

            {/* Session Info */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ padding: 14, borderRadius: 12, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#15803d", textTransform: "uppercase", marginBottom: 4 }}>Démarrée à</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{sessionStartedAt || "—"}</div>
              </div>
              <div style={{ padding: 14, borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: 4 }}>Paquets analysés</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{stats.totalPackets.toLocaleString()}</div>
              </div>
              <div style={{ padding: 14, borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: 4 }}>Conformité</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{stats.conformityPct.toFixed(1)}%</div>
              </div>
              <div style={{ padding: 14, borderRadius: 12, background: "#fee2e2", border: "1px solid #fca5a5" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", textTransform: "uppercase", marginBottom: 4 }}>Anomalies</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#dc2626" }}>{stats.totalNok}</div>
              </div>
            </div>

            {/* Auto-stop scheduler */}
            <div style={{ padding: 16, borderRadius: 12, background: "#fffbeb", border: "1px solid #fde68a", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Clock size={16} color="#b45309" />
                <span style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>Arrêt programmé</span>
              </div>
              {scheduledStop ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, color: "#0f172a" }}>
                    La session s'arrêtera automatiquement à <strong>{formatTunisiaTime(scheduledStop)}</strong>
                  </span>
                  <button
                    onClick={async () => {
                      await backendApi.scheduleStop(null);
                      setScheduledStop(null);
                      toast.success("Arrêt programmé annulé.");
                    }}
                    style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700, color: "#dc2626", cursor: "pointer" }}
                  >Annuler</button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="time"
                    value={stopTimeInput}
                    onChange={e => setStopTimeInput(e.target.value)}
                    style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", fontSize: 14, fontWeight: 600 }}
                  />
                  <button
                    disabled={!stopTimeInput}
                    onClick={async () => {
                      if (!stopTimeInput) return;
                      try {
                        const r = await backendApi.scheduleStop(stopTimeInput);
                        setScheduledStop(r.scheduled_stop);
                        toast.success(`Session s'arrêtera ${formatStopCountdown(r.scheduled_stop)}.`);
                      } catch { toast.error("Erreur lors de la programmation."); }
                    }}
                    style={{ background: "#0d9488", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: stopTimeInput ? "pointer" : "not-allowed", opacity: stopTimeInput ? 1 : 0.5 }}
                  >Programmer</button>
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setSessionModalOpen(false); navigate("/clients/gmcb/qualite"); }}
                style={{ flex: 1, padding: "10px 16px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#f8fafc", fontSize: 13, fontWeight: 700, cursor: "pointer", color: "#0f172a" }}
              >Voir le live</button>
              <button
                onClick={async () => {
                  setSessionLoading(true);
                  try {
                    await backendApi.toggleRecording();
                    await backendApi.stopAll();
                    try { await backendApi.scheduleStop(null); } catch {}
                    setSessionModalOpen(false);
                    toast.success("Session arrêtée.");
                  } catch { toast.error("Erreur lors de l'arrêt."); }
                  finally { setSessionLoading(false); }
                }}
                disabled={sessionLoading}
                style={{ flex: 1, padding: "10px 16px", borderRadius: 10, border: "none", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sessionLoading ? "wait" : "pointer", opacity: sessionLoading ? 0.6 : 1 }}
              >
                {sessionLoading ? "Arrêt…" : "Arrêter maintenant"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 18, alignItems: "start" }}>
        {/* Left column */}
        <div style={{ display: "grid", gap: 18 }}>
          <DashboardPanel title="Contrôle live" subtitle="Démarrage immédiat, fermeture manuelle et visibilité sur la session en cours.">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
              <div
                onClick={() => { if (stats.isRunning) setSessionModalOpen(true); }}
                style={{ borderRadius: 16, padding: 18, background: "linear-gradient(135deg,#f0fdf4,#ecfeff)", border: "1px solid #d1fae5", cursor: stats.isRunning ? "pointer" : "default", transition: "box-shadow 0.15s" }}
                onMouseEnter={e => { if (stats.isRunning) (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 16px rgba(15,118,110,0.15)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#0f766e", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Session active</div>
                  {scheduledStop && <div style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "2px 8px", borderRadius: 6 }}>⏱ Arrêt à {formatTunisiaTime(scheduledStop)}</div>}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>{stats.isRunning ? "En cours" : "Aucune"}</div>
                <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
                  {stats.isRunning
                    ? `${stats.totalPackets.toLocaleString()} paquets analysés • ${stats.conformityPct}% de conformité`
                    : "L'administrateur peut lancer une session instantanément ou depuis une session planifiée du calendrier."}
                </div>
              </div>
              <div style={{ borderRadius: 16, padding: 18, background: "#fff7ed", border: "1px solid #fed7aa" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#c2410c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Mode automatique</div>
                <div style={{ fontSize: 14, color: "#7c2d12", lineHeight: 1.6 }}>
                  Les shifts automatiques se déclenchent selon leur planning. Les exceptions par jour permettent de désactiver un shift sur une date donnée sans toucher au reste du calendrier.
                </div>
              </div>
            </div>
          </DashboardPanel>

          <DashboardPanel title="Shifts automatiques">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14, marginBottom: 18 }}>
              <AdminActionCard icon={<Repeat size={18} />} title="Créer un shift automatique" text="Ajoutez un planning récurrent de base dans une modale dédiée, puis affinez les jours ou périodes depuis chaque shift." buttonLabel="Ajouter un shift auto" onClick={openNewRecurringModal} />
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              {recurringRules.map((rule) => {
                const ruleIsActive = rule.active !== false && rule.weekdays.length > 0;
                const summaries = getRuleScheduleSummaries(rule);
                const baseSummary = summaries.find((s) => s.category === "base") || null;
                const variantSummaries = summaries.filter((s) => s.category === "variant");
                return (
                  <div key={rule.id} style={{ border: "1px solid #edf2f7", borderRadius: 14, padding: 16, display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>{rule.name}</span>
                        <span style={{ padding: "4px 8px", borderRadius: 999, background: ruleIsActive ? "#dcfce7" : "#fee2e2", color: ruleIsActive ? "#15803d" : "#dc2626", fontSize: 11, fontWeight: 700 }}>
                          {ruleIsActive ? "Automatique" : "Désactivé"}
                        </span>
                      </div>
                      <div style={{ display: "grid", gap: 6 }}>
                        {baseSummary && <div style={{ fontSize: 13, lineHeight: 1.6, color: "#667085", fontWeight: 700 }}>{baseSummary.text}</div>}
                        <div style={{ fontSize: 12, color: "#98a2b3" }}>
                          Actif du {formatAdminDate(rule.startDate, { day: "2-digit", month: "2-digit", year: "numeric" })} au {formatAdminDate(rule.endDate, { day: "2-digit", month: "2-digit", year: "numeric" })}
                        </div>
                        {variantSummaries.map((s) => (
                          <button key={s.id} onClick={() => openExistingVariantModal(rule, s.variant)} style={{ fontSize: 13, lineHeight: 1.6, color: s.tone === "danger" ? "#dc2626" : "#475467", fontWeight: 500, background: "transparent", border: "none", padding: 0, textAlign: "left", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
                            {s.text}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => openEditRecurringModal(rule)} style={{ border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8", borderRadius: 10, padding: "9px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Modifier</button>
                      <button onClick={() => openRuleActionModal(rule, "timing")} style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", borderRadius: 10, padding: "9px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Personnaliser</button>
                      <button onClick={() => openRuleActionModal(rule, "disable")} style={{ border: "1px solid #f59e0b", background: "#fff7ed", color: "#b45309", borderRadius: 10, padding: "9px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Désactiver</button>
                      <button onClick={() => deleteRecurringRule(rule.id)} style={{ border: "1px solid #fecaca", background: "#fff5f5", color: "#dc2626", borderRadius: 10, padding: "9px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                        <Trash2 size={14} /> Supprimer
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </DashboardPanel>


        </div>

        {/* Right column */}
        <div style={{ display: "grid", gap: 18 }}>
          <DashboardPanel title="Calendrier de pilotage" subtitle={`Mois affiché: ${formatAdminMonth(monthCursor)}`}
            action={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => changeMonth(-1)} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #d0d5dd", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><ChevronLeft size={16} /></button>
                <button onClick={() => changeMonth(1)} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #d0d5dd", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><ChevronRight size={16} /></button>
              </div>
            }>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 8, marginBottom: 10 }}>
              {ADMIN_WEEKDAYS.map((d) => <div key={d.key} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: "#98a2b3", paddingBottom: 4 }}>{d.short}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 8 }}>
              {monthDays.map((dateIso, i) => {
                if (!dateIso) return <div key={`empty-${i}`} style={{ minHeight: 72, borderRadius: 14, background: "#f8fafc" }} />;
                const daySessions = getSessionsForDate(dateIso, recurringRules, oneOffSessions);
                const activeDaySessions = getActiveSessions(daySessions);
                const isSelected = dateIso === selectedDate;
                const isToday = dateIso === today;
                const isPast = isPastIsoDate(dateIso, today);
                const hasDisabled = daySessions.some((s) => s.disabled);
                // Check session history for this date
                const hasHistory = historyDays.some((d) => d.date === dateIso);
                const historyEntry = hasHistory ? historyDays.find((d) => d.date === dateIso) : null;
                const displayCount = (isPast && historyEntry)
                  ? historyEntry.sessionCount
                  : activeDaySessions.length;
                const displayLabel = (isPast && historyEntry) ? "session" : "shift";
                return (
                  <button key={dateIso} onClick={() => {
                      if (isPast) {
                        if (hasHistory) {
                          const found = historyDays.find((d) => d.date === dateIso);
                          if (found) setHistoryDay(found);
                        }
                        return;
                      }
                      setSelectedDate(dateIso);
                      setSingleDraft((c) => ({ ...c, date: dateIso }));
                      setPlanningModalOpen(true);
                    }}
                    style={{ minHeight: 72, borderRadius: 14, border: `${isToday ? "2px" : "1px"} solid ${isSelected || isToday ? "#0f766e" : "#e5e7eb"}`, background: isSelected ? "#ecfdf5" : isToday ? "#f0fdf4" : isPast ? "#f1f5f9" : "#fff", padding: 10, textAlign: "left", cursor: isPast ? (hasHistory ? "pointer" : "not-allowed") : "pointer", position: "relative", opacity: isPast ? (hasHistory ? 0.75 : 0.4) : 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: isToday ? "#0f766e" : "#0f172a" }}>{dateIso.slice(8, 10)}</div>
                      {isToday && <div style={{ fontSize: 9, fontWeight: 800, color: "#fff", background: "#0f766e", borderRadius: 4, padding: "1px 4px", textTransform: "uppercase" }}>Auj.</div>}
                    </div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{displayCount} {displayLabel}{displayCount > 1 ? "s" : ""}</div>
                    {isPast && <div style={{ fontSize: 10, color: hasHistory ? "#4338ca" : "#64748b", marginTop: 4, fontWeight: 700 }}>{hasHistory ? "Voir historique" : "Lecture seule"}</div>}
                    {hasDisabled && <div style={{ fontSize: 10, color: "#dc2626", marginTop: 4, fontWeight: 700 }}>Exception</div>}
                  </button>
                );
              })}
            </div>
          </DashboardPanel>

        </div>
      </div>

      {/* Day planning modal */}
      <AdminModal
        open={planningModalOpen}
        title={`Journée du ${formatAdminDate(selectedDate, { weekday: "long", day: "numeric", month: "long" })}`}
        subtitle={`Détail des shifts planifiés. ${selectedActiveSessions.length} actif${selectedActiveSessions.length > 1 ? "s" : ""} sur cette date.`}
        onClose={() => setPlanningModalOpen(false)}>
        <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
          {selectedSessions.length === 0 ? (
            <div style={{ padding: 16, borderRadius: 14, background: "#f8fafc", border: "1px dashed #cbd5e1", fontSize: 13, color: "#64748b" }}>
              Aucun shift prévu ce jour. Vous pouvez ajouter un shift ponctuel ci-dessous.
            </div>
          ) : selectedSessions.map((session) => {
            const selectedDayHistory = historyDays.find((d) => d.date === selectedDate);
            const matchingHistorySession = selectedDayHistory?.sessions?.find(
              (hs) => hs.shift_id === session.id || hs.shift_id === session.sourceId
            );
            const hasActuallyEnded = Boolean(matchingHistorySession?.ended_at);
            const sessionEnded = hasActuallyEnded || selectedDate < today || (selectedDate === today && timeToMinutes(session.end) <= currentMinutes);
            const sessionInProgress = !hasActuallyEnded && selectedDate === today && timeToMinutes(session.start) <= currentMinutes && !sessionEnded;
            const sessionReadOnly = selectedDateIsPast || sessionEnded;
            return (
              <div key={session.id} style={{ border: `1px solid ${sessionReadOnly ? "#bbf7d0" : sessionInProgress ? "#99f6e4" : session.disabled ? "#fecaca" : "#e5e7eb"}`, background: sessionReadOnly ? "#f0fdf4" : sessionInProgress ? "#f0fdfa" : session.disabled ? "#fff7f7" : "#fff", borderRadius: 14, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: getShiftBadgeColor(session), display: "inline-block" }} />
                      <span style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>{session.name}</span>
                      {session.source === "single" && <span style={{ padding: "4px 8px", borderRadius: 999, background: "#faf5ff", color: "#7e22ce", fontSize: 11, fontWeight: 700 }}>Ponctuel</span>}
                      {session.source === "rule" && <span style={{ padding: "4px 8px", borderRadius: 999, background: "#dcfce7", color: "#15803d", fontSize: 11, fontWeight: 700 }}>Automatique</span>}
                    </div>
                    <div style={{ fontSize: 13, color: "#667085" }}>{session.start} - {session.end}</div>
                    {session.disabled && <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 700, marginTop: 6 }}>Désactivée pour cette date</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                    {sessionReadOnly ? (
                      <div style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#166534", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700 }}>Terminé</div>
                    ) : sessionInProgress ? (
                      <div style={{ border: "1px solid #99f6e4", background: "#f0fdfa", color: "#0f766e", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: "#0d9488", display: "inline-block", animation: "pulse 1.5s infinite" }} />
                        En cours
                      </div>
                    ) : session.source === "single" ? (
                      <>
                        <button onClick={() => openOneOffEditModal(session)} style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Modifier</button>
                        <button onClick={() => deleteSingleSession(session.sourceId)} style={{ border: "1px solid #fecaca", background: "#fff5f5", color: "#dc2626", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Supprimer</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => openRuleTimingForSelectedDate(session.sourceId)} style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Modifier</button>
                        <button onClick={() => toggleRuleForSelectedDate(session.sourceId)} style={{ border: `1px solid ${session.disabled ? "#16a34a" : "#f59e0b"}`, background: session.disabled ? "#f0fdf4" : "#fff7ed", color: session.disabled ? "#15803d" : "#b45309", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                          {session.disabled ? "Réactiver" : "Désactiver"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid #eef2f7", paddingTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14 }}>
            <AdminActionCard icon={<Calendar size={18} />} title="Ajouter un shift ponctuel" text={`Ajoute un shift unique le ${formatAdminDate(selectedDate, { day: "2-digit", month: "2-digit", year: "numeric" })} dans une modale simple.`} buttonLabel="+ Ajouter au calendrier" onClick={openSingleModal} tone="teal" disabled={selectedDateIsPast} />
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 18, background: "#f8fafc", display: "grid", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>Prochain shift créé</div>
              <div style={{ fontSize: 13, color: "#667085", lineHeight: 1.6 }}>Nom prévu: <span style={{ color: "#0f172a", fontWeight: 800 }}>{nextShiftName}</span></div>
              <div style={{ fontSize: 13, color: "#667085", lineHeight: 1.6 }}>Mode: <span style={{ color: "#15803d", fontWeight: 800 }}>Auto start</span></div>
            </div>
          </div>
        </div>
      </AdminModal>

      {/* Recurring rule modal */}
      <AdminModal open={recurringModalOpen} title={editingRuleId ? "Modifier le shift automatique" : "Ajouter un shift automatique"} subtitle={editingRuleId ? "Modifiez la règle de base du shift: horaires, période et jours actifs." : "Horaires, période d'activation et jours actifs."} onClose={closeRecurringModal}
        footer={<>
          <button onClick={closeRecurringModal} style={{ border: "1px solid #d0d5dd", borderRadius: 12, padding: "10px 14px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Annuler</button>
          <button onClick={addRecurringRule} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#0f172a", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}><Plus size={15} />{editingRuleId ? "Enregistrer" : "Créer le shift"}</button>
        </>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Nom du shift</div>
            <div style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 13, background: "#f8fafc", color: "#0f172a", fontWeight: 800 }}>
              {ruleDraft.name}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début</div>
            <input type="time" value={ruleDraft.start} onChange={(e) => setRuleDraft({ ...ruleDraft, start: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin</div>
            <input type="time" value={ruleDraft.end} onChange={(e) => setRuleDraft({ ...ruleDraft, end: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début activation</div>
            <input type="date" value={ruleDraft.startDate} onChange={(e) => setRuleDraft({ ...ruleDraft, startDate: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin activation</div>
            <input type="date" value={ruleDraft.endDate} onChange={(e) => setRuleDraft({ ...ruleDraft, endDate: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>Jours actifs</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {ADMIN_WEEKDAYS.map((d) => {
              const active = ruleDraft.weekdays.includes(d.key);
              return <button key={d.key} onClick={() => toggleWeekday(d.key)} style={{ border: `1px solid ${active ? "#0f766e" : "#d0d5dd"}`, background: active ? "#ecfdf5" : "#fff", color: active ? "#0f766e" : "#475467", borderRadius: 999, padding: "8px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{d.label}</button>;
            })}
          </div>
          <div style={{ fontSize: 12, color: ruleDraft.weekdays.length === 0 ? "#b42318" : "#15803d", fontWeight: 700 }}>
            {ruleDraft.weekdays.length === 0 ? "Choisissez au moins un jour." : `Actif sur: ${sortWeekdays(ruleDraft.weekdays).map((k) => ADMIN_WEEKDAYS.find((d) => d.key === k)?.label).filter(Boolean).join(", ")}`}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#15803d", fontWeight: 600 }}>Ce shift démarrera automatiquement selon ce planning.</div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>Pipelines actifs</div>
          {[
            { id: "pipeline_barcode_date", label: "Barcode & Date" },
            { id: "pipeline_anomaly", label: "Détection Anomalie" },
          ].map(({ id, label }) => {
            const checked = (ruleDraft.enabledPipelines ?? []).includes(id);
            return (
              <label key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", color: checked ? "#0f766e" : "#94a3b8", fontWeight: checked ? 600 : 400 }}>
                <input type="checkbox" checked={checked}
                  onChange={() => setRuleDraft((c) => { const cur = c.enabledPipelines ?? []; return { ...c, enabledPipelines: checked ? cur.filter((p) => p !== id) : [...cur, id] }; })}
                  style={{ width: 15, height: 15, accentColor: "#0f766e", cursor: "pointer" }} />
                {label}
              </label>
            );
          })}
          <div style={{ fontSize: 11, color: "#64748b" }}>Les pipelines non cochés ne seront pas démarrés lors de ce shift.</div>
        </div>
      </AdminModal>

      {/* Rule action modal */}
      <AdminModal open={ruleActionModal.open}
        title={ruleActionModal.mode === "timing" ? (ruleActionModal.variantId ? `Modifier la personnalisation de ${selectedRuleForAction?.name || "ce shift"}` : `Personnaliser ${selectedRuleForAction?.name || "ce shift"}`) : `Désactiver ${selectedRuleForAction?.name || "le shift"}`}
        subtitle={ruleActionModal.mode === "timing" ? "Créez un horaire personnalisé sur une période et uniquement sur les jours sélectionnés." : "Choisissez les jours et la période sur lesquels cette action doit s'appliquer."}
        onClose={closeRuleActionModal}
        footer={<>
          {ruleActionModal.variantId && <button onClick={deleteRuleActionVariant} style={{ border: "1px solid #fecaca", borderRadius: 12, padding: "10px 14px", background: "#fff5f5", color: "#dc2626", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Supprimer</button>}
          <button onClick={closeRuleActionModal} style={{ border: "1px solid #d0d5dd", borderRadius: 12, padding: "10px 14px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Annuler</button>
          <button onClick={saveRuleAction} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: ruleActionModal.mode === "disable" ? "#f59e0b" : "#0f172a", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
            <Plus size={15} />{ruleActionModal.mode === "timing" ? (ruleActionModal.variantId ? "Enregistrer" : "Créer la personnalisation") : "Confirmer"}
          </button>
        </>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 18 }}>
          {ruleActionModal.mode === "timing" && (<>
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début</div>
              <input type="time" value={ruleActionModal.draft.start} onChange={(e) => setRuleActionModal((c) => ({ ...c, draft: { ...c.draft, start: e.target.value } }))} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin</div>
              <input type="time" value={ruleActionModal.draft.end} onChange={(e) => setRuleActionModal((c) => ({ ...c, draft: { ...c.draft, end: e.target.value } }))} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
            </div>
          </>)}
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début période</div>
            <input type="date"
              min={selectedRuleForAction?.startDate}
              max={selectedRuleForAction?.endDate}
              value={ruleActionModal.draft.startDate}
              onChange={(e) => setRuleActionModal((c) => ({ ...c, draft: { ...c.draft, startDate: e.target.value } }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin période</div>
            <input type="date"
              min={selectedRuleForAction?.startDate}
              max={selectedRuleForAction?.endDate}
              value={ruleActionModal.draft.endDate}
              onChange={(e) => setRuleActionModal((c) => ({ ...c, draft: { ...c.draft, endDate: e.target.value } }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>Jours concernés</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {ADMIN_WEEKDAYS.map((d) => {
              const active = ruleActionModal.draft.weekdays.includes(d.key);
              const allowed = !selectedRuleForAction || selectedRuleForAction.weekdays.includes(d.key);
              return <button key={d.key} onClick={() => allowed && toggleRuleActionWeekday(d.key)} disabled={!allowed} style={{ border: `1px solid ${!allowed ? "#e2e8f0" : active ? "#0f766e" : "#d0d5dd"}`, background: !allowed ? "#f1f5f9" : active ? "#ecfdf5" : "#fff", color: !allowed ? "#cbd5e1" : active ? "#0f766e" : "#475467", borderRadius: 999, padding: "8px 11px", fontSize: 12, fontWeight: 700, cursor: allowed ? "pointer" : "not-allowed" }}>{d.label}</button>;
            })}
          </div>
        </div>
      </AdminModal>

      {/* Single session modal */}
      <AdminModal open={singleModalOpen} title="Ajouter un shift ponctuel" subtitle={`Ce shift sera ajouté uniquement pour le ${formatAdminDate(singleDraft.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`} onClose={closeSingleModal}
        footer={<>
          <button onClick={closeSingleModal} style={{ border: "1px solid #d0d5dd", borderRadius: 12, padding: "10px 14px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Annuler</button>
          <button onClick={addSingleSession} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}><Plus size={15} />Ajouter au calendrier</button>
        </>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Nom généré</div>
            <div style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13, background: "#f8fafc", color: "#0f172a", fontWeight: 700, display: "flex", alignItems: "center" }}>
              {getNextShiftNameForDate(singleDraft.date, recurringRules, oneOffSessions)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début</div>
            <input type="time" value={singleDraft.start} onChange={(e) => setSingleDraft({ ...singleDraft, start: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin</div>
            <input type="time" value={singleDraft.end} onChange={(e) => setSingleDraft({ ...singleDraft, end: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
        </div>
      </AdminModal>

      {/* One-off session edit modal (times only) */}
      <AdminModal
        open={!!editingOneOffId}
        title="Modifier les horaires"
        subtitle="Modifiez les heures de début et de fin de ce shift ponctuel."
        onClose={() => setEditingOneOffId(null)}
        footer={<>
          <button onClick={() => setEditingOneOffId(null)} style={{ border: "1px solid #d0d5dd", borderRadius: 12, padding: "10px 14px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Annuler</button>
          <button onClick={saveOneOffEdit} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Enregistrer</button>
        </>}>
        {oneOffEditDraft.date && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, color: "#15803d", marginBottom: 16 }}>
            <Calendar size={13} />
            {formatAdminDate(oneOffEditDraft.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début</div>
            <input type="time" value={oneOffEditDraft.start} onChange={(e) => setOneOffEditDraft((d) => ({ ...d, start: e.target.value }))} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin</div>
            <input type="time" value={oneOffEditDraft.end} onChange={(e) => setOneOffEditDraft((d) => ({ ...d, end: e.target.value }))} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
        </div>
      </AdminModal>

      {/* Recurring shift – modify for a single day (simple modal, no period/weekday fields) */}
      <AdminModal
        open={!!editingRuleForDate}
        title="Modifier les horaires"
        subtitle={editingRuleForDate?.variantId ? "Modifiez les horaires pour cette journée uniquement." : "Appliquez un horaire différent pour cette journée uniquement."}
        onClose={() => setEditingRuleForDate(null)}
        footer={<>
          <button onClick={() => setEditingRuleForDate(null)} style={{ border: "1px solid #d0d5dd", borderRadius: 12, padding: "10px 14px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Annuler</button>
          <button onClick={saveRuleTimingForDate} style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Enregistrer</button>
        </>}>
        {editingRuleForDate && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, color: "#15803d", marginBottom: 16 }}>
            <Calendar size={13} />
            {formatAdminDate(editingRuleForDate.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Début</div>
            <input type="time" value={editingRuleForDate?.start ?? ""} onChange={(e) => setEditingRuleForDate((d) => d ? { ...d, start: e.target.value } : d)} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>Fin</div>
            <input type="time" value={editingRuleForDate?.end ?? ""} onChange={(e) => setEditingRuleForDate((d) => d ? { ...d, end: e.target.value } : d)} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13 }} />
          </div>
        </div>
      </AdminModal>

      <AlertDialog open={!!shiftToDelete} onOpenChange={(open) => !open && setShiftToDelete(null)}>
        <AlertDialogContent className="bg-slate-900 border-slate-700 text-white rounded-xl max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl">Confirmation de suppression</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              Êtes-vous sûr de vouloir supprimer {shiftToDeleteLabel || "ce shift"} ? Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4 gap-2 sm:gap-0">
            <AlertDialogCancel className="bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white rounded-lg">
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeletion} className="bg-red-600 text-white hover:bg-red-700 rounded-lg">
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {historyDay && (
        <HistDayModal
          daySummary={historyDay}
          defectLabel={(t) => t === "nobarcode" ? "Absence CB" : t === "nodate" ? "Date non visible" : "Anomalie"}
          dayModalOrigin="admin"
          canDelete={true}
          onClose={() => setHistoryDay(null)}
          onBackToCalendar={() => setHistoryDay(null)}
          onSessionClick={() => { setHistoryDay(null); navigate("/clients/gmcb/historique"); }}
          openFeedbackModal={openFeedbackModal}
        />
      )}

      {/* Confirm session start dialog */}
      {confirmSessionOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 420, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}>Démarrer une session</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Choisissez les contrôles actifs pour cette session :</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
              {([
                { key: "barcode" as const, label: "Contrôle code-barres", desc: "Les paquets sans code-barres sont comptés NOK" },
                { key: "date" as const, label: "Contrôle date", desc: "Les paquets sans date lisible sont comptés NOK" },
                { key: "anomaly" as const, label: "Détection anomalie", desc: "Analyse visuelle des défauts de surface" },
              ]).map(({ key, label, desc }) => {
                const active = enabledChecks[key];
                return (
                  <label key={key} onClick={() => setEnabledChecks(prev => ({ ...prev, [key]: !prev[key] }))} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px", borderRadius: 10, border: `1px solid ${active ? "#99f6e4" : "#e2e8f0"}`, background: active ? "#f0fdf9" : "#f8fafc", cursor: "pointer", transition: "all 0.15s" }}>
                    <div style={{ marginTop: 2, width: 18, height: 18, borderRadius: 4, border: `2px solid ${active ? "#0f766e" : "#cbd5e1"}`, background: active ? "#0f766e" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}>
                      {active && <svg width="10" height="8" viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: active ? "#0f766e" : "#64748b" }}>{label}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmSessionOpen(false)} style={{ border: "1px solid #d0d5dd", borderRadius: 10, padding: "9px 16px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Annuler
              </button>
              <button
                disabled={sessionLoading || (!enabledChecks.barcode && !enabledChecks.date && !enabledChecks.anomaly)}
                onClick={() => { setConfirmSessionOpen(false); startSession(); }}
                style={{ border: "none", borderRadius: 10, padding: "9px 16px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sessionLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: (sessionLoading || (!enabledChecks.barcode && !enabledChecks.date && !enabledChecks.anomaly)) ? 0.5 : 1 }}
              >
                {sessionLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={15} />} Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GMCBAdmin;
