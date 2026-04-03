// ─── GMCB Mock Data & Utilities ───────────────────────────────────────────────

// images removed — return empty strings so UI falls back gracefully
const ncab1 = "";
const ncab2 = "";
const dateNonVisible1 = "";
const paquetOuvert1 = "";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnomalyItem {
  id: number;
  type: string;
  time: string;
  lot: string;
  score: number;
  category: string;
  img: string;
  fallbackImg?: string;
}

export interface SessionResult {
  label: string;
  count: number;
  color: string;
}

export interface SessionData {
  id: string | number;
  lot: string;
  startH: string;
  endH: string;
  label: string;
  paquets: number;
  anomalies: number;
  conformite: number;
  cadence: number;
  anomalyList: AnomalyItem[];
  resultats: SessionResult[];
  isoDate?: string;
  startTime?: string;
  date?: string;
}

export interface DayData {
  date: string;
  label: string;
  paquets: number;
  anomalies: number;
  conformite: number;
  defauts: number;
  sessions: SessionData[];
}

export interface FeedbackItem {
  id: string;
  title: string;
  comment: string;
  type: string;
  scope: string;
  date: string;
  sessionId: string | null;
  urgency: string;
  createdAt: string;
}

export interface FeedbackDraft {
  title: string;
  comment: string;
  type: string;
  scope: string;
  date: string;
  sessionId: string;
  urgency: string;
}

// ─── Utility Functions ────────────────────────────────────────────────────────

export const ADMIN_WEEKDAYS = [
  { key: "mon", short: "L", label: "Lundi" },
  { key: "tue", short: "M", label: "Mardi" },
  { key: "wed", short: "M", label: "Mercredi" },
  { key: "thu", short: "J", label: "Jeudi" },
  { key: "fri", short: "V", label: "Vendredi" },
  { key: "sat", short: "S", label: "Samedi" },
  { key: "sun", short: "D", label: "Dimanche" },
];

export const ADMIN_SHIFT_OPTIONS = ["Shift 1", "Shift 2", "Shift 3", "Shift 4"];
export const TUNISIA_TIMEZONE = "Africa/Tunis";

function getTunisiaParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TUNISIA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return { year, month, day };
}

export function parseBackendTimestamp(raw?: string | null): Date | null {
  if (!raw) return null;
  const normalized = raw.startsWith("interrupted:") ? raw.slice("interrupted:".length) : raw;
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized);
  // Backend stores local Tunisia time (UTC+1) without timezone suffix
  const parsed = new Date(hasTimezone ? normalized : `${normalized}+01:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatTunisiaTime(value?: string | Date | null, includeSeconds = false): string {
  const date = value instanceof Date ? value : parseBackendTimestamp(value);
  if (!date) return "—";
  return date.toLocaleTimeString("fr-FR", {
    timeZone: TUNISIA_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  });
}

/** Returns a human-readable countdown string like "dans 1h 23min" or "dans 45min". */
export function formatStopCountdown(isoStopTime: string | null | undefined): string {
  if (!isoStopTime) return "";
  const stop = parseBackendTimestamp(isoStopTime);
  if (!stop) return "";
  const diffMs = stop.getTime() - Date.now();
  if (diffMs <= 0) return "dans moins d'une minute";
  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `dans ${hours}h ${minutes}min`;
  if (hours > 0) return `dans ${hours}h`;
  return `dans ${minutes}min`;
}

export function buildTunisiaDateTime(dateIso: string, time: string): Date {
  return parseBackendTimestamp(`${dateIso}T${time}:00+01:00`) ?? new Date(`${dateIso}T${time}:00Z`);
}

export function buildTunisiaDateRange(dateIso: string, start: string, end: string): { start: Date; end: Date } {
  const startDate = buildTunisiaDateTime(dateIso, start);
  const endDate = buildTunisiaDateTime(dateIso, end);
  if (hhmmToMinutes(end) <= hhmmToMinutes(start)) {
    endDate.setUTCDate(endDate.getUTCDate() + 1);
  }
  return { start: startDate, end: endDate };
}

export function galleryCategoryFromDefectType(defectType?: string | null): string {
  if (defectType === "nobarcode") return "Code à barre";
  if (defectType === "nodate") return "Date";
  if (defectType === "anomaly") return "Anomalie";
  return "Tous";
}

export function proofFallbackForDefectType(defectType?: string | null): string {
  if (defectType === "nobarcode") return ncab1;
  if (defectType === "nodate") return dateNonVisible1;
  if (defectType === "anomaly") return paquetOuvert1;
  return paquetOuvert1;
}

export function getTunisiaCurrentMinutes(date: Date = new Date()): number {
  const time = formatTunisiaTime(date);
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function hhmmToMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function getTunisiaIsoDateFromTimestamp(value?: string | null): string {
  const date = parseBackendTimestamp(value);
  if (!date) return "";
  const { year, month, day } = getTunisiaParts(date);
  return `${year}-${month}-${day}`;
}

export function toIsoDate(date: Date): string {
  const { year, month, day } = getTunisiaParts(date);
  return `${year}-${month}-${day}`;
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

export function addDays(isoDate: string, days: number): string {
  const date = dateFromIso(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

export function weekdayKeyFromIso(isoDate: string): string {
  const day = dateFromIso(isoDate).getUTCDay();
  return ADMIN_WEEKDAYS[(day + 6) % 7].key;
}

export function formatAdminDate(isoDate: string, options: Intl.DateTimeFormatOptions): string {
  return dateFromIso(isoDate).toLocaleDateString("fr-FR", { ...options, timeZone: TUNISIA_TIMEZONE });
}

export function formatAdminMonth(monthIso: string): string {
  return new Date(`${monthIso}-01T00:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: TUNISIA_TIMEZONE });
}

export function isWithinDateRange(dateIso: string, startDate: string, endDate: string): boolean {
  if (startDate && dateIso < startDate) return false;
  if (endDate && dateIso > endDate) return false;
  return true;
}

export function getMonthDays(monthIso: string): (string | null)[] {
  const monthDate = new Date(`${monthIso}-01T00:00:00Z`);
  const firstWeekday = (monthDate.getUTCDay() + 6) % 7;
  const totalDays = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
  const days: (string | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) days.push(null);
  for (let day = 1; day <= totalDays; day++) {
    days.push(toIsoDate(new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), day))));
  }
  while (days.length % 7 !== 0) days.push(null);
  return days;
}

export function isPastIsoDate(dateIso: string, today: string): boolean {
  return dateIso < today;
}

export function sortWeekdays(weekdays: string[]): string[] {
  const order = ADMIN_WEEKDAYS.map((day) => day.key);
  return [...weekdays].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function formatHistoryDate(isoDate: string): string {
  if (!isoDate) return "";
  const [, month, day] = isoDate.split("-");
  const monthNames = ["janv", "fevr", "mars", "avr", "mai", "juin", "juil", "aout", "sept", "oct", "nov", "dec"];
  return `${Number(day)} ${monthNames[Number(month) - 1]}`;
}

export function getHistoryPeriodLabel(histView: string, customRange: { start: string; end: string } | null): string {
  if (histView === "custom" && customRange?.start && customRange?.end) {
    return `${formatHistoryDate(customRange.start)} - ${formatHistoryDate(customRange.end)}`;
  }
  if (histView === "week") return "7 derniers jours";
  if (histView === "two-week") return "14 derniers jours";
  return "30 derniers jours";
}

// ─── Admin Rule Utilities ─────────────────────────────────────────────────────

export interface RuleVariant {
  id: string;
  kind: "timing" | "availability";
  active?: boolean;
  start?: string;
  end?: string;
  startDate: string;
  endDate: string;
  weekdays: string[];
}

export interface RecurringRule {
  id: string;
  name: string;
  start: string;
  end: string;
  startDate: string;
  endDate: string;
  weekdays: string[];
  autoStart: boolean;
  active: boolean;
  variants: RuleVariant[];
}

export interface OneOffSession {
  id: string;
  date: string;
  name: string;
  start: string;
  end: string;
  autoStart: boolean;
  createdAt?: string;
}

export interface PlannedSession {
  id: string;
  source: string;
  sourceId: string;
  date: string;
  name: string;
  start: string;
  end: string;
  autoStart: boolean;
  disabled: boolean;
  color?: string;
}

// TODO: backend feature needed — no endpoint exists yet
// Shift scheduling: needs new backend endpoints for CRUD on recurring rules
// For now keep static placeholder data
// STATIC DATA START
export const ADMIN_INITIAL_RULES: RecurringRule[] = [
  {
    id: "rule-shift-1",
    name: "Shift 1",
    start: "08:00",
    end: "12:00",
    startDate: "2026-03-01",
    endDate: "2026-12-31",
    weekdays: ["mon", "tue", "wed", "thu", "fri"],
    autoStart: true,
    active: true,
    variants: [],
  },
  {
    id: "rule-shift-2",
    name: "Shift 2",
    start: "13:30",
    end: "17:30",
    startDate: "2026-03-01",
    endDate: "2026-12-31",
    weekdays: ["mon", "tue", "wed", "thu", "fri"],
    autoStart: true,
    active: true,
    variants: [],
  },
];
// STATIC DATA END

// TODO: backend feature needed — no endpoint exists yet
// One-off session scheduling: needs new backend endpoints for CRUD
// For now keep static placeholder data
// STATIC DATA START
export const ADMIN_INITIAL_ONE_OFF_SESSIONS: OneOffSession[] = [
  {
    id: "single-shift-3",
    date: "2026-03-22",
    name: "Shift 3",
    start: "18:00",
    end: "20:00",
    autoStart: true,
  },
];
// STATIC DATA END

export function ruleVariantApplies(variant: RuleVariant, dateIso: string, weekdayKey: string): boolean {
  return isWithinDateRange(dateIso, variant.startDate, variant.endDate) && variant.weekdays.includes(weekdayKey);
}

export function buildRuleSession(rule: RecurringRule, dateIso: string): PlannedSession {
  const weekdayKey = weekdayKeyFromIso(dateIso);
  let start = rule.start;
  let end = rule.end;
  let disabled = false;

  const applicable = (rule.variants || []).filter((v) => ruleVariantApplies(v, dateIso, weekdayKey));

  // Pass 1: timing variants update the schedule times
  applicable
    .filter((v) => v.kind === "timing")
    .forEach((v) => { start = v.start!; end = v.end!; });

  // Pass 2: availability variants set the enabled/disabled state
  // Processed AFTER timing so that an explicit disable always takes effect
  // even when a timing customisation also covers the same date.
  applicable
    .filter((v) => v.kind === "availability")
    .forEach((v) => { disabled = !v.active; });

  return {
    id: `${rule.id}-${dateIso}`,
    source: "rule",
    sourceId: rule.id,
    date: dateIso,
    name: rule.name,
    start,
    end,
    autoStart: rule.autoStart,
    disabled,
  };
}

export function isSingleDateAvailabilityVariant(variant: RuleVariant, dateIso: string, weekdayKey: string): boolean {
  return variant.kind === "availability"
    && variant.startDate === dateIso
    && variant.endDate === dateIso
    && variant.weekdays.length === 1
    && variant.weekdays[0] === weekdayKey;
}

export function isSingleDateTimingVariant(variant: RuleVariant, dateIso: string, weekdayKey: string): boolean {
  return variant.kind === "timing"
    && variant.startDate === dateIso
    && variant.endDate === dateIso
    && variant.weekdays.length === 1
    && variant.weekdays[0] === weekdayKey;
}

export function isLateCreatedOneOffSession(session: OneOffSession): boolean {
  if (!session.createdAt) return false;
  const createdDateIso = getTunisiaIsoDateFromTimestamp(session.createdAt);
  if (!createdDateIso) return false;
  if (createdDateIso > session.date) return true;
  if (createdDateIso < session.date) return false;
  return hhmmToMinutes(formatTunisiaTime(session.createdAt)) >= hhmmToMinutes(session.start);
}

export function getSessionsForDate(dateIso: string, recurringRules: RecurringRule[], oneOffSessions: OneOffSession[]): PlannedSession[] {
  const recurring = recurringRules
    .filter((rule) => rule.active !== false && isWithinDateRange(dateIso, rule.startDate, rule.endDate) && rule.weekdays.includes(weekdayKeyFromIso(dateIso)))
    .map((rule) => buildRuleSession(rule, dateIso));
  const singles = oneOffSessions
    .filter((session) => session.date === dateIso)
    .map((session) => ({
      ...session,
      source: "single",
      sourceId: session.id,
      disabled: false,
    }));

  return [...recurring, ...singles].sort((a, b) => a.start.localeCompare(b.start));
}

export function getActiveSessions(sessions: PlannedSession[]): PlannedSession[] {
  return sessions.filter((session) => !session.disabled);
}

export function getShiftBadgeColor(session: PlannedSession): string {
  if (session.disabled) return "#dc2626";
  if (session.autoStart) return "#16a34a";
  return "#0f766e";
}

export function getRuleScheduleSummaries(rule: RecurringRule) {
  const formatWeekdays = (weekdays: string[]) => weekdays.map((key) => ADMIN_WEEKDAYS.find((item) => item.key === key)?.label).filter(Boolean).join(", ");
  const formatPeriod = (startDate: string, endDate: string) => startDate === endDate
    ? formatAdminDate(startDate, { day: "2-digit", month: "2-digit", year: "numeric" })
    : `${formatAdminDate(startDate, { day: "2-digit", month: "2-digit", year: "numeric" })} au ${formatAdminDate(endDate, { day: "2-digit", month: "2-digit", year: "numeric" })}`;

  const repeatingVariants = (rule.variants || []).filter((variant) => variant.startDate !== variant.endDate);

  const summaries: any[] = [];

  if (rule.weekdays.length > 0) {
    summaries.push({
      id: `${rule.id}-base`,
      category: "base",
      tone: "default",
      text: `${rule.start} - ${rule.end} • ${formatWeekdays(rule.weekdays)}`,
      editable: false,
      variant: null,
    });
  }

  return [
    ...summaries,
    ...repeatingVariants.map((variant) => ({
      id: variant.id,
      category: "variant",
      tone: variant.kind === "availability" ? "danger" : "muted",
      editable: true,
      variant,
      text: variant.kind === "timing"
        ? `${variant.start} - ${variant.end} • ${formatWeekdays(variant.weekdays)} • ${formatPeriod(variant.startDate, variant.endDate)}`
        : `Désactivé • ${formatWeekdays(variant.weekdays)} • ${formatPeriod(variant.startDate, variant.endDate)}`,
    })),
  ];
}

export function getNextShiftNameForDate(dateIso: string, recurringRules: RecurringRule[], oneOffSessions: OneOffSession[]): string {
  const sessions = getSessionsForDate(dateIso, recurringRules, oneOffSessions);
  const maxShiftNumber = sessions.reduce((max, session) => {
    const match = /^Shift\s+(\d+)$/.exec(session.name || "");
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
  return `Shift ${maxShiftNumber + 1}`;
}

export function getDefaultRuleDraft(today: string) {
  return {
    name: "Shift 3",
    start: "20:00",
    end: "23:00",
    startDate: today,
    endDate: addDays(today, 60),
    weekdays: ["mon", "tue", "wed", "thu", "fri"],
  };
}

export function getDefaultSingleDraft(dateIso: string) {
  return {
    date: dateIso,
    start: "09:00",
    end: "10:30",
    autoStart: true,
  };
}

export function getDefaultRuleActionDraft(today: string) {
  return {
    start: "08:00",
    end: "12:00",
    startDate: today,
    endDate: addDays(today, 30),
    weekdays: ["mon"],
  };
}

// ─── Export Utilities ─────────────────────────────────────────────────────────

export function doExport(data: AnomalyItem[], format: string) {
  let blob: Blob;
  let filename: string;
  if (format === "csv") {
    const headers = ["Heure", "Lot", "Type anomalie", "Score confiance"];
    const rows = data.map((a) => [a.time, a.lot, a.type, a.score + "%"]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    filename = "anomalies.csv";
  } else if (format === "json") {
    const json = JSON.stringify(data.map((a) => ({ heure: a.time, lot: a.lot, type: a.type, score: a.score, categorie: a.category })), null, 2);
    blob = new Blob([json], { type: "application/json" });
    filename = "anomalies.json";
  } else {
    const headers = ["Heure", "Lot", "Type anomalie", "Score confiance", "Catégorie"];
    const rows = data.map((a) => [a.time, a.lot, a.type, a.score + "%", a.category]);
    const csv = "\uFEFF" + [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(";")).join("\n");
    blob = new Blob([csv], { type: "application/vnd.ms-excel;charset=utf-8;" });
    filename = "anomalies.xls";
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Mock Data Generation ─────────────────────────────────────────────────────

function makeAnomalies(lot: string, count: number, types: string[]): AnomalyItem[] {
  const t = ["Paquet ouvert", "Date non visible", "Absence code à barre", "Code à barre non visible"];
  const imgs = [paquetOuvert1, ncab1, ncab2, ncab1];
  return Array.from({ length: count }, (_, i) => {
    const ti = i % types.length;
    const type = types[ti];
    const idx = t.indexOf(type);
    const score = 65 + Math.floor(Math.random() * 33);
    const h = String(8 + Math.floor(i / 3)).padStart(2, "0");
    const m = String(Math.floor(Math.random() * 59)).padStart(2, "0");
    const s = String(Math.floor(Math.random() * 59)).padStart(2, "0");
    return {
      id: i + 1,
      type,
      time: h + ":" + m + ":" + s,
      lot,
      score,
      category: type === "Paquet ouvert" ? "Paquet ouvert" : type === "Date non visible" ? "Date non visible" : "Absence CB",
      img: idx >= 0 ? imgs[idx] : ncab1,
    };
  }).sort((a, b) => b.time.localeCompare(a.time));
}

const SESSION_TYPES = [
  ["Paquet ouvert", "Date non visible"],
  ["Absence code à barre", "Code à barre non visible", "Paquet ouvert"],
  ["Date non visible", "Absence code à barre"],
  ["Paquet ouvert", "Code à barre non visible"],
];

function makeSession(id: number, startH: string, endH: string, lot: string, paquets: number, anomCount: number, typeIdx: number): SessionData {
  const types = SESSION_TYPES[typeIdx % SESSION_TYPES.length];
  return {
    id,
    lot,
    startH,
    endH,
    label: "Session " + id,
    paquets,
    anomalies: anomCount,
    conformite: +(100 - (anomCount / paquets) * 100).toFixed(2),
    cadence: 70 + Math.floor(Math.random() * 15),
    anomalyList: makeAnomalies(lot, anomCount, types),
    resultats: [
      { label: "Paquets conformes", count: paquets - anomCount, color: "#22c55e" },
      { label: "Paquet ouvert", count: types.includes("Paquet ouvert") ? Math.ceil(anomCount * 0.4) : 0, color: "#16A34A" },
      { label: "Paquet sans code à barre", count: types.includes("Absence code à barre") ? Math.ceil(anomCount * 0.35) : 0, color: "#84CC16" },
      { label: "Date non visible", count: types.includes("Date non visible") ? Math.ceil(anomCount * 0.25) : 0, color: "#06B6D4" },
      { label: "Code à barre non visible", count: types.includes("Code à barre non visible") ? Math.ceil(anomCount * 0.2) : 0, color: "#3b82f6" },
    ].filter((r) => r.count > 0),
  };
}

// TODO: fetch from API — GET /api/stats/sessions?limit=100
// Group sessions by date(started_at) to build day entries.
// Each session's anomalyList → GET /api/stats/session/<id>/crossings
// Map defect_type: "nobarcode"→"Absence code à barre", "nodate"→"Date non visible", "anomaly"→"Paquet ouvert"
// Conformité per day: compute as (sum ok_count / sum total) * 100 across sessions of that day
// Cadence per session: compute as total / session_duration_in_minutes
// STATIC DATA START
export const DAYS_DATA: DayData[] = [
  {
    date: "2026-03-10", label: "lundi 10/03/2026", paquets: 8640, anomalies: 52, conformite: 99.4, defauts: 52, sessions: [
      makeSession(1, "08:00", "12:00", "LOT-GM-2026-0401", 2160, 14, 0),
      makeSession(2, "12:00", "16:00", "LOT-GM-2026-0402", 2160, 18, 1),
      makeSession(3, "16:00", "20:00", "LOT-GM-2026-0403", 2160, 12, 2),
      makeSession(4, "20:00", "00:00", "LOT-GM-2026-0404", 2160, 8, 3),
    ],
  },
  {
    date: "2026-03-09", label: "dimanche 09/03/2026", paquets: 6420, anomalies: 31, conformite: 99.5, defauts: 31, sessions: [
      makeSession(1, "08:00", "14:00", "LOT-GM-2026-0398", 3210, 18, 1),
      makeSession(2, "14:00", "20:00", "LOT-GM-2026-0399", 3210, 13, 2),
    ],
  },
  {
    date: "2026-03-08", label: "samedi 08/03/2026", paquets: 9100, anomalies: 28, conformite: 99.7, defauts: 28, sessions: [
      makeSession(1, "06:00", "10:00", "LOT-GM-2026-0394", 2275, 8, 3),
      makeSession(2, "10:00", "14:00", "LOT-GM-2026-0395", 2275, 7, 0),
      makeSession(3, "14:00", "18:00", "LOT-GM-2026-0396", 2275, 9, 1),
      makeSession(4, "18:00", "22:00", "LOT-GM-2026-0397", 2275, 4, 2),
    ],
  },
  {
    date: "2026-03-07", label: "vendredi 07/03/2026", paquets: 8200, anomalies: 41, conformite: 99.5, defauts: 41, sessions: [
      makeSession(1, "08:00", "12:00", "LOT-GM-2026-0390", 2050, 11, 0),
      makeSession(2, "12:00", "16:00", "LOT-GM-2026-0391", 2050, 16, 1),
      makeSession(3, "16:00", "20:00", "LOT-GM-2026-0392", 2050, 9, 2),
      makeSession(4, "20:00", "00:00", "LOT-GM-2026-0393", 2050, 5, 3),
    ],
  },
  {
    date: "2026-03-06", label: "jeudi 06/03/2026", paquets: 8900, anomalies: 18, conformite: 99.8, defauts: 18, sessions: [
      makeSession(1, "08:00", "14:00", "LOT-GM-2026-0386", 4450, 10, 3),
      makeSession(2, "14:00", "20:00", "LOT-GM-2026-0387", 4450, 8, 0),
    ],
  },
  {
    date: "2026-03-05", label: "mercredi 05/03/2026", paquets: 7600, anomalies: 53, conformite: 99.3, defauts: 53, sessions: [
      makeSession(1, "08:00", "12:00", "LOT-GM-2026-0382", 1900, 14, 1),
      makeSession(2, "12:00", "16:00", "LOT-GM-2026-0383", 1900, 19, 2),
      makeSession(3, "16:00", "20:00", "LOT-GM-2026-0384", 1900, 13, 3),
      makeSession(4, "20:00", "00:00", "LOT-GM-2026-0385", 1900, 7, 0),
    ],
  },
  {
    date: "2026-03-04", label: "mardi 04/03/2026", paquets: 8300, anomalies: 25, conformite: 99.7, defauts: 25, sessions: [
      makeSession(1, "08:00", "14:00", "LOT-GM-2026-0378", 4150, 14, 2),
      makeSession(2, "14:00", "20:00", "LOT-GM-2026-0379", 4150, 11, 1),
    ],
  },
];
// STATIC DATA END

// TODO: fetch from API — GET /api/stats (polling every 400ms)
// total_packets → paquets, packages_nok → anomalies
// Conformité: compute as (packages_ok / total_packets) * 100
// Cadence: compute from session duration + total_packets
// anomalyList → GET /api/stats/session/<session_id>/crossings
// resultats → build from: packages_ok, nok_no_barcode, nok_no_date, nok_anomaly
// session_id, stats_active from /api/stats response
// STATIC DATA START
export const CURRENT_SESSION: SessionData = {
  id: "live-current",
  lot: "LOT-GM-2025-0412",
  startTime: "14:00",
  startH: "14:00",
  endH: "",
  date: "Aujourd'hui",
  label: "Session Live",
  paquets: 2856,
  anomalies: 12,
  conformite: 99.58,
  cadence: 75,
  anomalyList: makeAnomalies("LOT-GM-2025-0412", 12, ["Paquet ouvert", "Date non visible", "Absence code à barre", "Code à barre non visible"]),
  resultats: [
    { label: "Paquets conformes", count: 2856, color: "#22c55e" },
    { label: "Paquet ouvert", count: 5, color: "#16A34A" },
    { label: "Paquet sans code à barre", count: 4, color: "#84CC16" },
    { label: "Date non visible", count: 3, color: "#06B6D4" },
    { label: "Code à barre non visible", count: 1, color: "#3b82f6" },
  ],
};
// STATIC DATA END

export const FILTER_TABS = ["Tous", "Anomalie", "Date", "Code à barre"];

export function createFeedbackDraft(): FeedbackDraft {
  return { title: "", comment: "", type: "bug", scope: "global", date: todayIso(), sessionId: "", urgency: "medium" };
}
