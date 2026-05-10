import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  addDays,
  buildRuleSession,
  buildTunisiaDateRange,
  dateFromIso,
  parseBackendTimestamp,
  todayIso,
  formatAdminDate,
  formatTunisiaTime,
  getTunisiaCurrentMinutes,
  getSessionsForDate,
  isSingleDateAvailabilityVariant,
  weekdayKeyFromIso,
  type PlannedSession,
} from "./gmcbData";
import { useShifts } from "@/hooks/useShifts";
import { useOneOffSessions } from "@/hooks/useOneOffSessions";
import { useLiveStats } from "@/hooks/useLiveStats";
import { useSessionHistory, type Session as HistorySession } from "@/hooks/useSessionHistory";
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

const StatCard: React.FC<{ title: string; value: React.ReactNode }> = ({ title, value }) => (
  <div className="bg-white/60 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 shadow-sm">
    <div className="text-sm text-slate-500 mb-1">{title}</div>
    <div className="text-2xl font-semibold">{value}</div>
  </div>
);

const Panel: React.FC<{ title: string; open: boolean; onToggle: () => void; children?: React.ReactNode }> = ({ title, open, onToggle, children }) => (
  <div className="mt-4">
    <button onClick={onToggle} className="w-full flex items-center justify-between bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md p-3">
      <div className="font-medium">{title}</div>
      <div className="opacity-80">{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</div>
    </button>
    {open && <div className="mt-3">{children}</div>}
  </div>
);

function timeToMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function formatDurationMinutes(minutes: number): string {
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60} min`;
  return `${minutes} min`;
}

function getSessionKindLabel(session: PlannedSession): string {
  return session.source === "single" ? "Ponctuelle" : "Automatique";
}

function isInterruptedHistorySession(session: HistorySession): boolean {
  return Boolean(session.ended_at?.startsWith("interrupted:"));
}

function historySessionMatchesLiveSession(
  historySession: { id: string; group_id?: string; session_ids?: string[] },
  liveSessionIds: string[],
): boolean {
  if (liveSessionIds.length === 0) return false;
  if (liveSessionIds.includes(historySession.id)) return true;
  if (historySession.group_id && liveSessionIds.includes(historySession.group_id)) return true;
  return (historySession.session_ids ?? []).some((sessionId) => liveSessionIds.includes(sessionId));
}

const GMCBOverview: React.FC = () => {
  const [expandedYesterday, setExpandedYesterday] = useState(false);
  const [expandedTomorrow, setExpandedTomorrow] = useState(false);
  const [expandedWeek, setExpandedWeek] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [shiftToDelete, setShiftToDelete] = useState<PlannedSession | null>(null);

  const isoToday = todayIso();
  const isoYesterday = addDays(isoToday, -1);
  const isoTomorrow = addDays(isoToday, 1);

  const { shifts: rules, createVariant, deleteVariantRaw, refreshAfterBatch } = useShifts();
  const { oneOffSessions: oneOffs, removeOneOff } = useOneOffSessions();
  const stats = useLiveStats();
  const { days: historyDays, refetch: refetchHistory } = useSessionHistory();

  const todaySessions = useMemo(() => getSessionsForDate(isoToday, rules, oneOffs), [isoToday, rules, oneOffs]);
  const tomorrowSessions = useMemo(
    () => getSessionsForDate(isoTomorrow, rules, oneOffs).filter((session) => !session.disabled),
    [isoTomorrow, rules, oneOffs]
  );

  useEffect(() => {
    const intervalId = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    refetchHistory();
    const intervalId = setInterval(refetchHistory, 60_000);
    return () => clearInterval(intervalId);
  }, [refetchHistory]);

  // Remaining days of the week: day after tomorrow → Sunday
  const restOfWeekDays = useMemo(() => {
    const todayDate = dateFromIso(isoToday);
    const todayDow = todayDate.getDay(); // 0=Sun … 6=Sat
    // Days remaining until Sunday (inclusive). If today is Sunday, show nothing (0 remaining).
    const daysToSunday = todayDow === 0 ? 0 : 7 - todayDow;
    const result: { date: string; label: string; sessions: ReturnType<typeof getSessionsForDate> }[] = [];
    // Start from day+2 (skip today & tomorrow which are already shown)
    for (let offset = 2; offset <= daysToSunday; offset++) {
      const d = addDays(isoToday, offset);
      const sessions = getSessionsForDate(d, rules, oneOffs).filter((session) => !session.disabled);
      const label = formatAdminDate(d, { weekday: "long", day: "numeric", month: "short" });
      result.push({ date: d, label, sessions });
    }
    return result;
  }, [isoToday, rules, oneOffs]);

  const todayHistory = historyDays.find((d) => d.date === isoToday);
  const yesterdayHistory = historyDays.find((d) => d.date === isoYesterday);
  const completedPacketsToday = todayHistory?.totalPackets ?? 0;
  const completedAnomaliesToday = todayHistory?.totalAnomalies ?? 0;
  const totalPacketsToday = completedPacketsToday + (stats.isRunning ? stats.totalPackets : 0);
  const anomaliesToday = completedAnomaliesToday + (stats.isRunning ? stats.totalNok : 0);
  const currentMinutes = getTunisiaCurrentMinutes(now);

  const todaySessionsWithStatus = useMemo(() => {
    const historySessions = todayHistory?.sessions ?? [];
    const usedHistoryIds = new Set<string>();

    return todaySessions.map((session) => {
      const plannedRange = buildTunisiaDateRange(isoToday, session.start, session.end);
      const matchingHistoryByShift = historySessions.find((hist) => !usedHistoryIds.has(hist.id) && (hist.shift_id === session.id || hist.shift_id === session.sourceId));
      const matchingHistory = matchingHistoryByShift ?? null;
      if (matchingHistory) usedHistoryIds.add(matchingHistory.id);

      const scheduledStart = timeToMinutes(session.start);
      const scheduledEnd = timeToMinutes(session.end);
      
      let calcStatus = "En attente";
      if (session.disabled) {
        calcStatus = "Désactivé";
      } else if (matchingHistory) {
        calcStatus = matchingHistory.ended_at ? "Terminé" : "En cours";
      } else if (currentMinutes >= scheduledStart) {
        calcStatus = "Non démarré";
      } else {
        calcStatus = "En attente";
      }

      const isCompleted = calcStatus === "Terminé" || calcStatus === "Non démarré";
      const isRunningNow = calcStatus === "En cours";
      
      const actualEndDate = parseBackendTimestamp(matchingHistory?.ended_at);
      const plannedDurationMinutes = Math.max(1, Math.round((plannedRange.end.getTime() - plannedRange.start.getTime()) / 60000));
      const interruptedMinutes = actualEndDate && actualEndDate.getTime() < plannedRange.end.getTime()
        ? Math.max(0, Math.round((plannedRange.end.getTime() - actualEndDate.getTime()) / 60000))
        : 0;
      const isInterrupted = Boolean(matchingHistory && actualEndDate && interruptedMinutes > 0);
      const interruptionPct = isInterrupted
        ? Math.round((interruptedMinutes / plannedDurationMinutes) * 100)
        : 0;
      const interruptionCause = matchingHistory?.ended_at?.startsWith("interrupted:")
        ? "arrêt système"
        : "arrêt volontaire";
      const interruptionTooltip = isInterrupted
        ? `Créneau prévu : ${session.start} - ${session.end}\nArrêt réel : ${formatTunisiaTime(actualEndDate)}\nTemps coupé : ${formatDurationMinutes(interruptedMinutes)}\nCause : ${interruptionCause}`
        : "";

      return {
        ...session,
        status: calcStatus,
        matchedHistoryId: matchingHistory?.id ?? null,
        isInterrupted,
        interruptionPct,
        interruptionTooltip,
        interruptedAt: formatTunisiaTime(actualEndDate),
      };
    });
  }, [currentMinutes, isoToday, stats.isRunning, todayHistory?.sessions, todaySessions]);
  const matchedHistoryIds = new Set(todaySessionsWithStatus.map((session) => session.matchedHistoryId).filter((id): id is string => Boolean(id)));
  const plannedShiftIds = new Set(todaySessions.flatMap((session) => [session.id, session.sourceId]));
  const spontaneousTodaySessions = (todayHistory?.sessions ?? [])
    .filter((session) => {
      const linkedToPlannedShift = Boolean(session.shift_id && plannedShiftIds.has(session.shift_id));
      return !linkedToPlannedShift && !matchedHistoryIds.has(session.id);
    })
    .sort((a, b) => {
      const aTime = parseBackendTimestamp(a.started_at)?.getTime() ?? 0;
      const bTime = parseBackendTimestamp(b.started_at)?.getTime() ?? 0;
      return aTime - bTime;
    });
  const activeTodaySessions = todaySessionsWithStatus.filter((session) => !session.disabled);
  const completedTodaySessions = activeTodaySessions.filter((session) => session.status === "Terminé").length;
  const liveSessionIds = [stats.sessionId0, stats.sessionId1].filter((sessionId): sessionId is string => Boolean(sessionId));
  const hasLiveSessionInHistory = (todayHistory?.sessions ?? []).some((session) => historySessionMatchesLiveSession(session, liveSessionIds));
  const actualSessionsToday = (todayHistory?.sessionCount ?? 0) + (stats.isRunning && !hasLiveSessionInHistory ? 1 : 0);

  async function confirmDeletion() {
    if (!shiftToDelete) return;

    setDeletingSessionId(shiftToDelete.id);
    try {
      if (shiftToDelete.source === "single") {
        await removeOneOff(shiftToDelete.sourceId);
        toast.success(`${shiftToDelete.name} supprimé avec succès`);
      } else {
        const weekdayKey = weekdayKeyFromIso(shiftToDelete.date);
        const rule = rules.find((item) => item.id === shiftToDelete.sourceId);
        if (!rule) throw new Error("Shift automatique introuvable");

        const exactAvailabilityVariants = (rule.variants || []).filter((variant) =>
          isSingleDateAvailabilityVariant(variant, shiftToDelete.date, weekdayKey)
        );

        for (const variant of exactAvailabilityVariants) {
          await deleteVariantRaw(rule.id, variant.id);
        }

        const variantsWithoutExactDate = (rule.variants || []).filter(
          (variant) => !isSingleDateAvailabilityVariant(variant, shiftToDelete.date, weekdayKey)
        );
        const baseSession = buildRuleSession({ ...rule, variants: variantsWithoutExactDate }, shiftToDelete.date);

        if (baseSession.disabled) {
          await refreshAfterBatch();
        } else {
          await createVariant(rule.id, {
            kind: "availability",
            active: false,
            startDate: shiftToDelete.date,
            endDate: shiftToDelete.date,
            weekdays: [weekdayKey],
          });
        }

        toast.success(`${shiftToDelete.name} supprimé pour le ${formatAdminDate(shiftToDelete.date, { day: "numeric", month: "short" })}`);
      }
      setShiftToDelete(null);
    } catch (error) {
      if (shiftToDelete.source === "rule") {
        try {
          await refreshAfterBatch();
        } catch {
          // Keep the original deletion error visible to the user.
        }
      }
      toast.error((error as Error).message || "Erreur lors de la suppression");
    } finally {
      setDeletingSessionId(null);
    }
  }

  function renderUpcomingSession(session: PlannedSession) {
    const isDeleting = deletingSessionId === session.id;
    const badgeStyle = session.source === "single"
      ? { background: "#faf5ff", color: "#7e22ce" }
      : { background: "#dcfce7", color: "#15803d" };

    return (
      <div key={session.id} className="p-3 rounded-xl border border-slate-200 bg-white/70 dark:bg-slate-800 shadow-sm flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{session.name}</div>
          <div className="mt-1 text-xs text-slate-500">
            {session.start} - {session.end}
          </div>
        </div>
        <div className="flex items-center gap-2 pl-2">
          <div
            className="px-2 py-1 rounded-full text-[11px] font-bold whitespace-nowrap"
            style={badgeStyle}
          >
            {getSessionKindLabel(session)}
          </div>
          <button
            type="button"
            onClick={() => setShiftToDelete(session)}
            disabled={isDeleting}
            className="shrink-0 p-1 text-slate-900 transition-colors hover:text-red-600 disabled:opacity-60 disabled:cursor-wait"
            aria-label={`Supprimer ${session.name}`}
            title={session.source === "rule" ? "Supprimer uniquement ce jour" : "Supprimer le shift ponctuel"}
          >
            {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} strokeWidth={1.8} />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Vue d'ensemble — GMCB</h1>
          <p className="text-sm text-slate-500 mt-1">Résumé rapide des sessions et du plan à venir</p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Sessions aujourd'hui" value={actualSessionsToday} />
        <StatCard title="Paquets analysés" value={totalPacketsToday} />
        <StatCard title="Anomalies" value={anomaliesToday} />
      </section>

      <main className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <h2 className="text-xl font-semibold">Aujourd'hui — {formatAdminDate(isoToday, { weekday: "long", day: "numeric", month: "short" })}</h2>
          <div className="mt-4 space-y-3">
            {todaySessionsWithStatus.length === 0 && spontaneousTodaySessions.length === 0 && <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded">Aucune session aujourd'hui.</div>}
            {todaySessionsWithStatus.map((s) => (
              <div key={s.id} className="p-4 bg-white/60 dark:bg-slate-800 border rounded-md flex items-center justify-between">
                <div>
                  <div className="font-medium flex items-center gap-2 flex-wrap">
                    <span>{s.name}</span>
                    {s.isInterrupted && (
                      <span
                        title={s.interruptionTooltip}
                        className="text-xs font-semibold px-2 py-1 rounded-full"
                        style={{ background: "#fff7ed", color: "#c2410c", border: "1px solid #fdba74", cursor: "help" }}
                      >
                        Interrompu
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-slate-500">
                    {s.start} - {s.end}
                    {s.isInterrupted && (
                      <span title={s.interruptionTooltip} style={{ color: "#c2410c", fontWeight: 600 }}>
                        {" "}• {s.interruptionPct}% du temps prévu coupé
                      </span>
                    )}
                  </div>
                  {s.isInterrupted && (
                    <div title={s.interruptionTooltip} className="text-xs mt-1" style={{ color: "#c2410c" }}>
                      Arrêt réel à {s.interruptedAt}
                    </div>
                  )}
                </div>
                <div
                  className="text-sm font-medium px-3 py-1 rounded-full"
                  style={{
                    background:
                      s.status === "Terminé" ? "#dcfce7"
                      : s.status === "En cours" ? "#dbeafe"
                      : s.status === "Désactivé" ? "#fee2e2"
                      : s.status === "Non démarré" ? "#fff7ed"
                      : "#f8fafc",
                    color:
                      s.status === "Terminé" ? "#166534"
                      : s.status === "En cours" ? "#1d4ed8"
                      : s.status === "Désactivé" ? "#b91c1c"
                      : s.status === "Non démarré" ? "#c2410c"
                      : "#475569",
                    border: `1px solid ${
                      s.status === "Terminé" ? "#bbf7d0"
                      : s.status === "En cours" ? "#bfdbfe"
                      : s.status === "Désactivé" ? "#fecaca"
                      : s.status === "Non démarré" ? "#ffedd5"
                      : "#e2e8f0"
                    }`,
                    boxShadow: s.status === "Terminé" ? "0 8px 24px rgba(34,197,94,0.10)" : "none",
                  }}
                >
                  {s.status}
                </div>
              </div>
            ))}

            {spontaneousTodaySessions.length > 0 && (
              <>
                <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide pt-2">Sessions instantanées</h3>
                {spontaneousTodaySessions.map((session) => {
                  const interrupted = isInterruptedHistorySession(session);
                  const status = !session.ended_at ? "En cours" : interrupted ? "Interrompue" : "Terminée";

                  return (
                    <div key={session.id} className="p-4 bg-white/60 dark:bg-slate-800 border rounded-md flex items-center justify-between">
                      <div>
                        <div className="font-medium flex items-center gap-2 flex-wrap">
                          <span>Session instantanée</span>
                          <span className="text-xs font-semibold px-2 py-1 rounded-full" style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}>
                            Instantanée
                          </span>
                          {interrupted && (
                            <span className="text-xs font-semibold px-2 py-1 rounded-full" style={{ background: "#fff7ed", color: "#c2410c", border: "1px solid #fdba74" }}>
                              Interrompue
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-slate-500">Début réel: {formatTunisiaTime(session.started_at)} • Fin réelle: {formatTunisiaTime(session.ended_at)}</div>
                        {interrupted && (
                          <div className="text-xs mt-1" style={{ color: "#c2410c" }}>
                            Session arrêtée de façon interrompue
                          </div>
                        )}
                      </div>
                      <div
                        className="text-sm font-medium px-3 py-1 rounded-full"
                        style={{
                          background: status === "Terminée" ? "#dcfce7" : status === "Interrompue" ? "#fff7ed" : "#dbeafe",
                          color: status === "Terminée" ? "#166534" : status === "Interrompue" ? "#c2410c" : "#1d4ed8",
                          border: `1px solid ${status === "Terminée" ? "#bbf7d0" : status === "Interrompue" ? "#fdba74" : "#bfdbfe"}`,
                        }}
                      >
                        {status}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <aside className="lg:col-span-1">
          <Panel title={`Hier — ${formatAdminDate(isoYesterday, { day: "numeric", month: "short" })}`} open={expandedYesterday} onToggle={() => setExpandedYesterday((v) => !v)}>
            <div className="space-y-2">
              {!yesterdayHistory || yesterdayHistory.sessions.length === 0 ? (
                <div className="p-2 text-sm text-slate-500">Aucun shift terminé hier.</div>
              ) : (
                <>
                  <div className="p-2 rounded border bg-emerald-50/80 border-emerald-200 text-emerald-800 text-xs font-medium">
                    {yesterdayHistory.sessionCount} shift{yesterdayHistory.sessionCount > 1 ? "s" : ""} • {yesterdayHistory.totalPackets.toLocaleString()} paquets • {yesterdayHistory.totalAnomalies} anomalies
                  </div>
                  {yesterdayHistory.sessions.map((session) => (
                    <div key={session.id} className="p-2 rounded border bg-white/70 dark:bg-slate-800 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">{session.checkpoint_ids?.length ? "Session groupée" : "Session"}</div>
                        <div className="text-xs text-slate-400">{formatTunisiaTime(session.started_at)}–{formatTunisiaTime(session.ended_at)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-semibold text-emerald-700">Terminé</div>
                        <div className="text-xs text-slate-500">{session.total ?? 0} paquets</div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </Panel>

          <Panel title={`Demain — ${formatAdminDate(isoTomorrow, { day: "numeric", month: "short" })}`} open={expandedTomorrow} onToggle={() => setExpandedTomorrow((v) => !v)}>
            <div className="space-y-2">
              {tomorrowSessions.length === 0 && <div className="p-2 text-sm text-slate-500">Aucune session prévue.</div>}
              {tomorrowSessions.map(renderUpcomingSession)}
            </div>
          </Panel>

          <Panel title="Reste de la semaine" open={expandedWeek} onToggle={() => setExpandedWeek((v) => !v)}>
            <div className="space-y-3">
              {restOfWeekDays.length === 0 && <div className="p-2 text-sm text-slate-500">Aucun jour restant cette semaine.</div>}
              {restOfWeekDays.map((day) => (
                <div key={day.date}>
                  <div className="flex items-center justify-between px-2 py-1">
                    <span className="text-sm font-medium capitalize">{day.label}</span>
                    <span className="text-xs text-slate-500">{day.sessions.length} shift{day.sessions.length !== 1 ? "s" : ""}</span>
                  </div>
                  {day.sessions.length > 0 && (
                    <div className="space-y-1 ml-2">
                      {day.sessions.map(renderUpcomingSession)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </aside>
      </main>

      <AlertDialog open={!!shiftToDelete} onOpenChange={(open) => !open && !deletingSessionId && setShiftToDelete(null)}>
        <AlertDialogContent className="bg-slate-900 border-slate-700 text-white rounded-xl max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl">Confirmation de suppression</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              {shiftToDelete?.source === "rule"
                ? `Êtes-vous sûr de vouloir supprimer ${shiftToDelete.name} le ${formatAdminDate(shiftToDelete.date, { weekday: "long", day: "numeric", month: "long" })} ? Cette action ne retirera que cette journée du planning.`
                : `Êtes-vous sûr de vouloir supprimer ${shiftToDelete?.name || "ce shift"} ? Cette action est irréversible.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4 gap-2 sm:gap-0">
            <AlertDialogCancel
              disabled={!!deletingSessionId}
              className="bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white rounded-lg"
            >
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeletion}
              disabled={!!deletingSessionId}
              className="bg-red-600 text-white hover:bg-red-700 rounded-lg"
            >
              {deletingSessionId ? "Suppression..." : "Supprimer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default GMCBOverview;
