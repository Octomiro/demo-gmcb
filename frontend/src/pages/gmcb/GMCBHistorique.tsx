import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  History, Calendar, TrendingUp, Download, ChevronLeft, ChevronRight,
  Eye, BarChart2, ArrowLeft, CheckCircle2, AlertCircle, Camera, Timer,
  Filter, MessageSquare, Flag, Loader2, TriangleAlert, Trash2,
} from "lucide-react";
import {
  FILTER_TABS, formatHistoryDate, getHistoryPeriodLabel, getSessionsForDate,
  formatTunisiaTime, parseBackendTimestamp, buildTunisiaDateRange, galleryCategoryFromDefectType, proofFallbackForDefectType,
  formatAdminDate, type AnomalyItem,
} from "./gmcbData";
import {
  StatCard, MiniStat, Metric, Pager, CalendarPickerModal,
  ExportModal, AnomalyModal,
} from "./gmcbComponents";
import { X, Clock } from "lucide-react";
import { useGMCBFeedback } from "@/contexts/GMCBFeedbackContext";
import { useGMCBAuth } from "@/contexts/GMCBAuthContext";
import { useSessionHistory, type DaySummary, type Session } from "@/hooks/useSessionHistory";
import { backendApi } from "@/core/backendApi";
import { useShifts } from "@/hooks/useShifts";
import { useOneOffSessions } from "@/hooks/useOneOffSessions";
import { toast } from "sonner";

function formatShortTime(date: Date | null): string {
  return formatTunisiaTime(date);
}

function formatDurationMinutes(minutes: number): string {
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes} min`;
}

function buildPlannedDateRange(dateIso: string, start: string, end: string): { start: Date; end: Date } {
  return buildTunisiaDateRange(dateIso, start, end);
}

const GMCBHistorique = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { openFeedbackModal } = useGMCBFeedback();
  const { user } = useGMCBAuth();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const { days, loading: histLoading, error: histError, refetch } = useSessionHistory();
  const [histView, setHistView] = useState("week");
  const [customRange, setCustomRange] = useState<{ start: string; end: string } | null>(null);
  const [dataView, setDataView] = useState("conformite");
  const [chartType, setChartType] = useState("bars");
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [calendarModalOpen, setCalendarModalOpen] = useState(false);
  const [rangeModalOpen, setRangeModalOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<DaySummary | null>(null);
  const [dayModalOrigin, setDayModalOrigin] = useState<string>("list");
  const [sessionDetailView, setSessionDetailView] = useState<{ session: Session; daySummary: DaySummary } | null>(null);
  const [exportModal, setExportModal] = useState<AnomalyItem[] | null>(null);
  const [modalAnomaly, setModalAnomaly] = useState<AnomalyItem | null>(null);
  const [downloadingDayReport, setDownloadingDayReport] = useState<string | null>(null);

  // Defect type → French label
  const defectLabel = (t: string) =>
    t === "nobarcode" ? "Absence code à barre"
    : t === "nodate" ? "Date non visible"
    : t === "anomaly" ? "Anomalie détectée"
    : t ?? "—";

  // Build filtered days list based on period selector
  const filteredDays = histView === "custom" && customRange?.start && customRange?.end
    ? days.filter((d) => d.date >= customRange.start! && d.date <= customRange.end!)
    : days.slice(0, histView === "week" ? 7 : histView === "two-week" ? 14 : 30);
  const itemsPerPage = 7;
  const totalPages = Math.max(1, Math.ceil(filteredDays.length / itemsPerPage));
  const activePage = Math.min(currentPage, totalPages);
  const startIdx = (activePage - 1) * itemsPerPage;
  const paginatedDays = filteredDays.slice(startIdx, startIdx + itemsPerPage);

  useEffect(() => { setCurrentPage(1); }, [histView, customRange?.start, customRange?.end]);

  useEffect(() => {
    if (!location.state?.openLatestSession || sessionDetailView || selectedDay || days.length === 0) return;

    const latestDay = [...days]
      .sort((a, b) => b.date.localeCompare(a.date))
      .find((day) => day.sessions.length > 0);

    if (!latestDay) {
      navigate(location.pathname, { replace: true, state: {} });
      return;
    }

    const latestSession = [...latestDay.sessions].sort((a, b) => {
      const aTime = a.ended_at ?? a.started_at ?? "";
      const bTime = b.ended_at ?? b.started_at ?? "";
      return bTime.localeCompare(aTime);
    })[0];

    if (latestSession) {
      setSessionDetailView({ session: latestSession, daySummary: latestDay });
    }

    navigate(location.pathname, { replace: true, state: {} });
  }, [days, location.pathname, location.state, navigate, selectedDay, sessionDetailView]);

  const handleDownloadDayReport = async (dayDate: string) => {
    setDownloadingDayReport(dayDate);
    try {
      const { filename } = await backendApi.downloadReportPdf(dayDate, dayDate);
      toast.success("Rapport journalier généré", {
        description: filename,
      });
    } catch (err) {
      toast.error("Impossible de générer le PDF du jour", {
        description: err instanceof Error ? err.message : "Réessayez dans quelques instants.",
      });
    } finally {
      setDownloadingDayReport(null);
    }
  };

  // ── Session Detail View ──

  if (sessionDetailView) {
    return (
      <HistSessionDetailView
        session={sessionDetailView.session}
        daySummary={sessionDetailView.daySummary}
        defectLabel={defectLabel}
        onBack={() => setSessionDetailView(null)}
        setModalAnomaly={setModalAnomaly}
        setExportModal={setExportModal}
        modalAnomaly={modalAnomaly}
        exportModal={exportModal}
        openFeedbackModal={openFeedbackModal}
      />
    );
  }

  // ── Loading / Error states ──

  if (histLoading) {
    return (
      <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif", display: "flex", alignItems: "center", gap: 8, color: "#0369a1" }}>
        <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> Chargement de l'historique…
      </div>
    );
  }

  if (histError) {
    return (
      <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 13, color: "#dc2626", marginBottom: 12 }}>
          <AlertCircle size={15} /> Impossible de charger l'historique
        </div>
        <button onClick={refetch} style={{ border: "1px solid #d0d5dd", borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Réessayer</button>
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#1a1a1a" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#f59e0b,#d97706)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <History size={24} color="white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Historique</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#777" }}>Historique des contrôles — GMCB • {getHistoryPeriodLabel(histView, customRange)}</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <div style={{ display: "flex", gap: 6, background: "#f1f3f4", borderRadius: 10, padding: 4 }}>
            {(["week", "two-week", "month"] as const).map((v) => (
              <button key={v} onClick={() => { setHistView(v); setCustomRange(null); }} style={{ padding: "7px 18px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, background: histView === v ? "#fff" : "transparent", color: histView === v ? "#111" : "#666", boxShadow: histView === v ? "0 1px 4px rgba(0,0,0,0.1)" : "none", transition: "all .15s" }}>
                {v === "week" ? "7 jours" : v === "two-week" ? "14 jours" : "30 jours"}
              </button>
            ))}
          </div>
          <button onClick={() => setRangeModalOpen(true)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10, border: histView === "custom" ? "1px solid #4f46e5" : "1px solid #dbe3ff", background: histView === "custom" ? "#eef2ff" : "#fff", color: histView === "custom" ? "#4338ca" : "#4f46e5", fontSize: 12, fontWeight: 800, cursor: "pointer", boxShadow: histView === "custom" ? "0 1px 4px rgba(79,70,229,0.12)" : "none" }}>
            <Calendar size={14} />
            {histView === "custom" && customRange?.start && customRange?.end ? `${formatHistoryDate(customRange.start)} - ${formatHistoryDate(customRange.end)}` : "Du / au"}
          </button>
        </div>
      </div>

      {/* Chart */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20, marginBottom: 20 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 999, border: `1px solid ${dataView === "conformite" ? "#99f6e4" : "#fecaca"}`, background: dataView === "conformite" ? "#f0fdfa" : "#fff1f2", color: dataView === "conformite" ? "#0f766e" : "#b91c1c", fontSize: 12, fontWeight: 700, marginBottom: 12 }}>
          Mode actif: {dataView === "conformite" ? "Conformité (%)" : "Anomalies (nombre)"}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TrendingUp size={18} color={dataView === "conformite" ? "#0d9488" : "#dc2626"} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>{dataView === "conformite" ? "Suivi de la conformité" : "Suivi des anomalies"}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ display: "flex", background: "#f3f4f6", borderRadius: 20, padding: 3, gap: 2, marginRight: 8 }}>
              <button onClick={() => setDataView("conformite")} style={{ padding: "5px 14px", borderRadius: 16, border: "none", fontSize: 12, cursor: "pointer", fontWeight: 600, background: dataView === "conformite" ? "#0d9488" : "transparent", color: dataView === "conformite" ? "#fff" : "#666", transition: "all .15s" }}>Conformité</button>
              <button onClick={() => setDataView("anomalies")} style={{ padding: "5px 14px", borderRadius: 16, border: "none", fontSize: 12, cursor: "pointer", fontWeight: 600, background: dataView === "anomalies" ? "#dc2626" : "transparent", color: dataView === "anomalies" ? "#fff" : "#666", transition: "all .15s" }}>Anomalies</button>
            </div>
            {(["bars", "line"] as const).map((v) => (
              <button key={v} onClick={() => setChartType(v)} style={{ padding: "6px 16px", borderRadius: 20, border: "1px solid #e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500, background: chartType === v ? "#111" : "#fff", color: chartType === v ? "#fff" : "#444", transition: "all .15s" }}>
                {v === "bars" ? "Barres" : "Courbe"}
              </button>
            ))}
          </div>
        </div>

        {chartType === "bars" ? (
          <div>
            {filteredDays.map((d, i) => {
              const isAnomalies = dataView === "anomalies";
              const maxAnomalies = Math.max(...filteredDays.map((x) => x.totalAnomalies), 1);
              const barWidth = isAnomalies ? (d.totalAnomalies / maxAnomalies) * 100 : d.conformityPct;
              const barColor = isAnomalies ? "#ef4444" : "#22c55e";
              const bgColor = isAnomalies ? "#fef2f2" : "#f0fdf4";
              const textColor = isAnomalies ? "#dc2626" : "#16a34a";
              const value = isAnomalies ? d.totalAnomalies : d.conformityPct.toFixed(1) + "%";
              const dayLabel = formatAdminDate(d.date, { weekday: "short", day: "2-digit", month: "2-digit" });
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <div style={{ minWidth: 150, fontSize: 13, color: "#555", whiteSpace: "nowrap", flexShrink: 0 }}>{dayLabel}</div>
                  <div style={{ flex: 1, background: bgColor, borderRadius: 4, height: 10, overflow: "visible", position: "relative" }}>
                    <div style={{ width: barWidth + "%", background: barColor, height: "100%", borderRadius: 4, transition: "width .3s ease" }} />
                  </div>
                  <div style={{ minWidth: 52, fontSize: 13, fontWeight: 600, textAlign: "right", color: textColor, flexShrink: 0 }}>{value}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ position: "relative", width: "100%", height: 240 }} onMouseLeave={() => setHoveredPoint(null)}>
            <svg width="100%" height="100%" viewBox="0 0 700 200" preserveAspectRatio="none" style={{ position: "absolute", inset: 0 }}>
              {(() => {
                const isAnomalies = dataView === "anomalies";
                const data = filteredDays;
                const maxVal = isAnomalies ? Math.max(...data.map((d) => d.totalAnomalies), 1) : 100;
                const lineColor = isAnomalies ? "#ef4444" : "#22c55e";
                const areaColor = isAnomalies ? "#fecaca" : "#c7f0d8";
                const points = data.map((d, i) => ({
                  x: data.length === 1 ? 350 : (i / (data.length - 1)) * 600 + 50,
                  y: 200 - ((isAnomalies ? d.totalAnomalies : d.conformityPct) / maxVal) * 160 - 20,
                }));
                return (
                  <>
                    {[100, 75, 50, 25, 0].map((pct, i) => {
                      const val = isAnomalies ? Math.round((pct / 100) * maxVal) : pct;
                      const label = isAnomalies ? String(val) : pct + "%";
                      return <text key={`label-${i}`} x="40" y={(200 - (pct / 100) * 160 - 20) + 4} fontSize="11" fill="#999" textAnchor="end">{label}</text>;
                    })}
                    {[0, 40, 80, 120, 160].map((y, i) => (
                      <line key={`grid-${i}`} x1="50" y1={y + 20} x2="650" y2={y + 20} stroke="#f0f0f0" strokeWidth="1" />
                    ))}
                    <line x1="50" y1="20" x2="50" y2="180" stroke="#e0e0e0" strokeWidth="1" />
                    <polygon points={[`50,180`, ...points.map((p) => `${p.x},${p.y}`), `650,180`].join(" ")} fill={areaColor} opacity="0.3" />
                    <polyline points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={lineColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    {points.map((p, i) => (
                      <g key={`group-${i}`} onMouseEnter={() => setHoveredPoint(i)} style={{ cursor: "pointer" }}>
                        <circle cx={p.x} cy={p.y} r="10" fill="transparent" style={{ pointerEvents: "all" }} />
                        <circle cx={p.x} cy={p.y} r="3" fill={lineColor} stroke="#fff" strokeWidth="2" />
                      </g>
                    ))}
                  </>
                );
              })()}
            </svg>
            {hoveredPoint !== null && (() => {
              const isAnomalies = dataView === "anomalies";
              const data = filteredDays;
              if (hoveredPoint >= data.length) return null;
              const d = data[hoveredPoint];
              const displayVal = isAnomalies ? d.totalAnomalies : d.conformityPct.toFixed(1) + "%";
              const dayLabel = formatAdminDate(d.date, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
              const valColor = isAnomalies ? "#dc2626" : "#22c55e";
              return (
                <div style={{ position: "absolute", top: 60, left: `${data.length === 1 ? 50 : (hoveredPoint / (data.length - 1)) * 80 + 10}%`, transform: "translateX(-50%)", background: "#fff", borderRadius: 8, padding: "8px 12px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", zIndex: 10, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", border: "1px solid #e0e0e0", pointerEvents: "none" }}>
                  <div style={{ color: "#555" }}>{dayLabel}</div>
                  <div style={{ color: valColor, fontWeight: 700 }}>{displayVal}</div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Days list */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Calendar size={18} color="#6366f1" />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Journées — Cliquer pour voir les sessions</span>
          </div>
          <button onClick={() => setCalendarModalOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: "1px solid #dbe3ff", background: "#f5f7ff", color: "#4f46e5", fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all .15s" }}>
            <Calendar size={14} /> Choisir une date
          </button>
        </div>
        {paginatedDays.map((day, i) => {
          const dayLabel = formatAdminDate(day.date, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
          return (
          <div key={i} onClick={() => { setDayModalOrigin("list"); setSelectedDay(day); }}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderRadius: 12, border: "1px solid #f0f0f0", marginBottom: 10, cursor: "pointer", transition: "all .15s", background: "#fff" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#f8f9fa"; e.currentTarget.style.borderColor = "#e0e0e0"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#f0f0f0"; }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 42, height: 42, background: "#f0f4ff", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Calendar size={20} color="#6366f1" />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{dayLabel}</div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{day.sessionCount} sessions • {day.totalPackets.toLocaleString()} paquets</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <Metric label="Conformité" value={day.conformityPct.toFixed(1) + "%"} color="#16a34a" />
              <Metric label="Anomalies" value={day.totalAnomalies} color="#dc2626" />
              <Metric label="Sessions" value={day.sessionCount} color="#6366f1" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDownloadDayReport(day.date);
                }}
                title="Télécharger le rapport PDF du jour"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8", fontSize: 12, cursor: "pointer", fontWeight: 700 }}
              >
                {downloadingDayReport === day.date ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={13} />}
              </button>
              <button onClick={(e) => { e.stopPropagation(); openFeedbackModal({ scope: "day", date: day.date }); }} title="Signaler un problème"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e", fontSize: 12, cursor: "pointer", fontWeight: 700 }}>
                <Flag size={13} />
              </button>
              <ChevronRight size={18} color="#ccc" />
            </div>
          </div>
          );
        })}

        {filteredDays.length > itemsPerPage && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, paddingTop: 12, borderTop: "1px solid #f0f0f0" }}>
            <div style={{ fontSize: 12, color: "#888" }}>Affichage {startIdx + 1}–{Math.min(startIdx + itemsPerPage, filteredDays.length)} sur {filteredDays.length}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={activePage === 1} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e0e0e0", background: activePage === 1 ? "#f5f5f5" : "#fff", color: activePage === 1 ? "#bbb" : "#555", cursor: activePage === 1 ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ChevronLeft size={14} />
              </button>
              {Array.from({ length: totalPages }, (_, idx) => {
                const pageNum = idx + 1;
                const isActive = pageNum === activePage;
                return (
                  <button key={pageNum} onClick={() => setCurrentPage(pageNum)} style={{ minWidth: 30, height: 30, padding: "0 8px", borderRadius: 8, border: isActive ? "1px solid #4f46e5" : "1px solid #e0e0e0", background: isActive ? "#4f46e5" : "#fff", color: isActive ? "#fff" : "#555", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    {pageNum}
                  </button>
                );
              })}
              <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={activePage === totalPages} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e0e0e0", background: activePage === totalPages ? "#f5f5f5" : "#fff", color: activePage === totalPages ? "#bbb" : "#555", cursor: activePage === totalPages ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {calendarModalOpen && (
        <CalendarPickerModal mode="single" availableDates={days.map((d) => d.date)} onClose={() => setCalendarModalOpen(false)} onSelectDay={(day) => {
          setCalendarModalOpen(false);
          const found = days.find((d) => d.date === day.date);
          if (found) { setDayModalOrigin("calendar"); setSelectedDay(found); }
        }} />
      )}
      {rangeModalOpen && (
        <CalendarPickerModal mode="range" availableDates={days.map((d) => d.date)} selectedRange={customRange} onClose={() => setRangeModalOpen(false)} onApplyRange={(range) => { setCustomRange(range); setHistView("custom"); setRangeModalOpen(false); }} />
      )}
      {selectedDay && (
        <HistDayModal
          daySummary={selectedDay}
          defectLabel={defectLabel}
          dayModalOrigin={dayModalOrigin}
          canDelete={isAdmin}
          onClose={() => setSelectedDay(null)}
          onBackToCalendar={() => { setSelectedDay(null); setCalendarModalOpen(true); }}
          onSessionClick={(session) => { setSelectedDay(null); setSessionDetailView({ session, daySummary: selectedDay }); }}
          openFeedbackModal={openFeedbackModal}
        />
      )}
      {exportModal && <ExportModal data={exportModal} onClose={() => setExportModal(null)} />}
      {modalAnomaly && <AnomalyModal anomaly={modalAnomaly} onClose={() => setModalAnomaly(null)} />}
    </div>
  );
};

// ─── Day Detail Modal (inline, uses DaySummary) ──────────────────────────────

export function HistDayModal({ daySummary, defectLabel, dayModalOrigin, onClose, onBackToCalendar, onSessionClick, openFeedbackModal, canDelete }: {
  daySummary: DaySummary;
  defectLabel: (t: string) => string;
  dayModalOrigin: string;
  onClose: () => void;
  onBackToCalendar: () => void;
  onSessionClick: (session: Session) => void;
  openFeedbackModal: (preset?: Record<string, string>) => void;
  canDelete?: boolean;
}) {
  const [viewMode, setViewMode] = useState("all");
  const [statsMetric, setStatsMetric] = useState<"conformite" | "paquets" | "anomalies">("conformite");
  const [statsHoveredIdx, setStatsHoveredIdx] = useState<number | null>(null);
  const [interruptionTooltipSessionId, setInterruptionTooltipSessionId] = useState<string | null>(null);
  const [interruptionTooltipPlacement, setInterruptionTooltipPlacement] = useState<"top" | "bottom">("bottom");
  const [localSessions, setLocalSessions] = useState(() => daySummary.sessions);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string; startH: string; endH: string } | null>(null);

  const handleDeleteSession = async () => {
    if (!deleteTarget) return;
    const { id, label, startH, endH } = deleteTarget;
    setDeleteTarget(null);
    setDeletingId(id);
    try {
      await backendApi.deleteSession(id);
      setLocalSessions((prev) => prev.filter((s) => s.id !== id));
      const { toast } = await import("sonner");
      toast.success(`${label} supprimée (${startH} – ${endH}). Les statistiques ont été retirées.`, { duration: 6000 });
    } catch {
      const { toast } = await import("sonner");
      toast.error(`Impossible de supprimer ${label}. Réessayez.`);
    } finally {
      setDeletingId(null);
    }
  };
  const { shifts } = useShifts();
  const { oneOffSessions } = useOneOffSessions();
  const dayLabel = formatAdminDate(daySummary.date, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const backAction = dayModalOrigin === "calendar" ? onBackToCalendar : null;
  const plannedSessions = getSessionsForDate(daySummary.date, shifts, oneOffSessions);

  const openInterruptionTooltip = (sessionId: string, anchorEl: HTMLElement | null) => {
    setInterruptionTooltipSessionId(sessionId);
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const tooltipApproxHeight = 220;
    const gap = 12;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const shouldFlipTop = spaceBelow < tooltipApproxHeight + gap && spaceAbove > spaceBelow;
    setInterruptionTooltipPlacement(shouldFlipTop ? "top" : "bottom");
  };

  const anomByType = [
    { label: "Paquet sans code à barre", color: "#84CC16", count: daySummary.sessions.reduce((s, se) => s + (se.nok_no_barcode ?? 0), 0) },
    { label: "Date non visible", color: "#06B6D4", count: daySummary.sessions.reduce((s, se) => s + (se.nok_no_date ?? 0), 0) },
    { label: "Anomalie détectée", color: "#16A34A", count: daySummary.sessions.reduce((s, se) => s + (se.nok_anomaly ?? 0), 0) },
  ].filter((a) => a.count > 0);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 920, maxWidth: "97vw", height: "min(92vh, 900px)", minHeight: "min(620px, 92vh)", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 32px 80px rgba(0,0,0,0.3)" }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {backAction && (
              <button onClick={backAction} title="Retour au calendrier" style={{ width: 34, height: 34, borderRadius: "50%", background: "#eef2ff", border: "1px solid #c7d2fe", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#4f46e5", flexShrink: 0 }}>
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{dayLabel}</h2>
              <p style={{ margin: 0, fontSize: 13, color: "#777", marginTop: 2 }}>{daySummary.sessionCount} sessions • {daySummary.totalPackets.toLocaleString()} paquets analysés</p>
            </div>
          </div>
          <button onClick={onClose} style={{ width: 34, height: 34, borderRadius: "50%", background: "#f5f5f5", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={16} />
          </button>
        </div>
        {/* Stats row */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #f0f0f0", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, flexShrink: 0 }}>
          <MiniStat icon={<CheckCircle2 size={18} color="#16a34a" />} bg="#dcfce7" value={daySummary.totalConformes.toLocaleString()} label="Conformes" />
          <MiniStat icon={<AlertCircle size={18} color="#dc2626" />} bg="#fee2e2" value={daySummary.totalAnomalies} label="Anomalies" />
          <MiniStat icon={<Camera size={18} color="#2563eb" />} bg="#dbeafe" value={daySummary.conformityPct.toFixed(2) + "%"} label="Conformité" />
          <MiniStat icon={<Clock size={18} color="#9333ea" />} bg="#f3e8ff" value={daySummary.sessionCount} label="Sessions" />
        </div>
        {/* View toggle */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid #f0f0f0", display: "flex", gap: 6, flexShrink: 0 }}>
          {(["all", "sessions", "stats"] as const).map((v) => (
            <button key={v} onClick={() => setViewMode(v)} style={{ padding: "6px 16px", borderRadius: 20, border: "1px solid #e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500, background: viewMode === v ? "#111" : "#fff", color: viewMode === v ? "#fff" : "#444", transition: "all .15s" }}>
              {v === "all" ? "Vue globale" : v === "sessions" ? "Par session" : "Stats"}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="modal-scroll-shell">
          <div className="modal-scroll-area" style={{ padding: "16px 24px 24px" }}>
          {viewMode === "all" && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  <TrendingUp size={16} color="#0d9488" /> Conformité par session
                </div>
                {daySummary.sessions.map((s, i) => {
                  const total = s.total ?? 0;
                  const nok = (s.nok_no_barcode ?? 0) + (s.nok_no_date ?? 0) + (s.nok_anomaly ?? 0);
                  const pct = total > 0 ? +((s.ok_count / total) * 100).toFixed(2) : 0;
                  const startH = formatTunisiaTime(s.started_at);
                  const endH = formatTunisiaTime(s.ended_at);
                  return (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "96px minmax(260px, 1fr) 70px 88px", alignItems: "center", columnGap: 14, rowGap: 4, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #f1f5f9" }}>
                      <div style={{ fontSize: 12, color: "#666", whiteSpace: "nowrap" }}>{startH}–{endH}</div>
                      <div style={{ flex: 1, background: "#f0fdf4", borderRadius: 4, height: 8, overflow: "hidden" }}>
                        <div style={{ width: pct + "%", background: "#22c55e", height: "100%", borderRadius: 4 }} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600, textAlign: "right", color: "#16a34a", whiteSpace: "nowrap" }}>{pct}%</div>
                      <div style={{ fontSize: 11, color: "#999", textAlign: "right", whiteSpace: "nowrap" }}>{nok} défauts</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {/* ── Left: Donut — Conformes vs Anomalies ── */}
                {(() => {
                  const total = daySummary.totalConformes + daySummary.totalAnomalies;
                  const okPct = total > 0 ? daySummary.totalConformes / total : 1;
                  const R = 36, CX = 50, CY = 50, CIRC = 2 * Math.PI * R;
                  const okDash = okPct * CIRC;
                  return (
                    <div style={{ background: "#f8f9fa", borderRadius: 10, padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 10, color: "#555", alignSelf: "flex-start" }}>Conformes vs Anomalies</div>
                      <svg width="110" height="110" viewBox="0 0 100 100">
                        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#ef4444" strokeWidth="14" />
                        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#22c55e" strokeWidth="14"
                          strokeDasharray={`${okDash} ${CIRC}`} strokeDashoffset="0"
                          transform={`rotate(-90 ${CX} ${CY})`} />
                        <circle cx={CX} cy={CY} r={22} fill="#fff" />
                        <text x={CX} y={CY - 3} textAnchor="middle" fontSize="13" fontWeight="bold" fill="#111">{(okPct * 100).toFixed(1)}%</text>
                        <text x={CX} y={CY + 11} textAnchor="middle" fontSize="8" fill="#888">conformité</text>
                      </svg>
                      <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
                        <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: "#22c55e", display: "inline-block" }} />
                          Conformes ({daySummary.totalConformes.toLocaleString()})
                        </div>
                        <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: "#ef4444", display: "inline-block" }} />
                          Anomalies ({daySummary.totalAnomalies})
                        </div>
                      </div>
                    </div>
                  );
                })()}
                {/* ── Right: Pie — anomaly type breakdown ── */}
                {(() => {
                  const anomTotal = anomByType.reduce((s, a) => s + a.count, 0);
                  const CX = 50, CY = 50, R = 38;
                  let startAngle = -Math.PI / 2;
                  const slices = anomByType.map(({ label, color, count }) => {
                    const angle = anomTotal > 0 ? (count / anomTotal) * 2 * Math.PI : 0;
                    const x1 = CX + R * Math.cos(startAngle);
                    const y1 = CY + R * Math.sin(startAngle);
                    startAngle += angle;
                    const x2 = CX + R * Math.cos(startAngle);
                    const y2 = CY + R * Math.sin(startAngle);
                    const largeArc = angle > Math.PI ? 1 : 0;
                    return { label, color, count, path: `M ${CX} ${CY} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z` };
                  });
                  return (
                    <div style={{ background: "#f8f9fa", borderRadius: 10, padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 10, color: "#555", alignSelf: "flex-start" }}>Anomalies par type</div>
                      {anomTotal === 0 ? (
                        <div style={{ fontSize: 12, color: "#aaa", margin: "24px 0", textAlign: "center" }}>Aucune anomalie</div>
                      ) : (
                        <svg width="110" height="110" viewBox="0 0 100 100">
                          {slices.map((s, i) => (
                            <path key={i} d={s.path} fill={s.color} stroke="#fff" strokeWidth="1.5" />
                          ))}
                        </svg>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8, width: "100%" }}>
                        {anomByType.map(({ label, color, count }, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: "inline-block" }} />
                              <span>{label}</span>
                            </div>
                            <span style={{ fontWeight: 700 }}>
                              {anomTotal > 0 ? ((count / anomTotal) * 100).toFixed(1) + "%" : "0%"} ({count})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
          {viewMode === "sessions" && (
            <div>
              {localSessions.map((s, i) => {
                const sessionNum = localSessions.length - i;
                const total = s.total ?? 0;
                const nok = (s.nok_no_barcode ?? 0) + (s.nok_no_date ?? 0) + (s.nok_anomaly ?? 0);
                const pct = total > 0 ? +((s.ok_count / total) * 100).toFixed(2) : 0;
                const startDate = parseBackendTimestamp(s.started_at);
                const endDate = parseBackendTimestamp(s.ended_at);
                const startH = formatShortTime(startDate);
                const endH = formatShortTime(endDate);
                const directPlannedSession = s.shift_id
                  ? plannedSessions.find((session) => session.id === s.shift_id || session.sourceId === s.shift_id)
                  : undefined;
                const fallbackPlannedSession = !directPlannedSession && s.shift_id && startDate
                  ? [...plannedSessions]
                      .map((session) => ({
                        session,
                        diff: Math.abs(buildPlannedDateRange(daySummary.date, session.start, session.end).start.getTime() - startDate.getTime()),
                      }))
                      .sort((a, b) => a.diff - b.diff)[0]?.session
                  : null;
                const matchedPlannedSession = directPlannedSession ?? fallbackPlannedSession ?? null;
                const plannedShiftStart = matchedPlannedSession?.start ?? null;
                const plannedShiftEnd = matchedPlannedSession?.end ?? null;
                const plannedRange = plannedShiftStart && plannedShiftEnd
                  ? buildPlannedDateRange(daySummary.date, plannedShiftStart, plannedShiftEnd)
                  : null;
                const plannedEndDate = plannedRange?.end ?? null;
                const durMin = (startDate && endDate)
                  ? Math.round((endDate.getTime() - startDate.getTime()) / 60000)
                  : null;
                const durLabel = durMin != null
                  ? (durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`)
                  : "—";
                const endedEarly = Boolean(plannedEndDate && endDate && endDate.getTime() < plannedEndDate.getTime());
                const markedInterrupted = Boolean(s.ended_at?.startsWith("interrupted:"));
                const isInterrupted = endedEarly || markedInterrupted;
                const interruptedMinutes = endedEarly && endDate && plannedEndDate
                  ? Math.max(0, Math.round((plannedEndDate.getTime() - endDate.getTime()) / 60000))
                  : 0;
                const interruptionCause = markedInterrupted
                  ? "arrêt système"
                  : "arrêt volontaire";
                const interruptionTooltipOpen = interruptionTooltipSessionId === s.id;
                return (
                  <div key={i} style={{ background: isInterrupted ? "#fffaf0" : "#f8f9fa", borderRadius: 12, padding: 16, marginBottom: 12, border: `1px solid ${isInterrupted ? "#fed7aa" : "#f0f0f0"}` }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span>Session {sessionNum}</span>
                          {isInterrupted && (
                            <span
                              style={{ padding: "4px 8px", borderRadius: 999, background: "#fff7ed", color: "#c2410c", fontSize: 11, fontWeight: 700, border: "1px solid #fdba74" }}
                            >
                              Interrompue
                            </span>
                          )}

                        </div>
                        <div style={{ fontSize: 12, color: "#888", marginTop: 2, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                          <span>{startH} – {endH}</span>
                          {(() => {
                            const ec = s.enabled_checks ?? {
                              barcode: (s.checkpoint_ids ?? [s.checkpoint_id]).some(c => c?.includes("barcode")),
                              date:    (s.checkpoint_ids ?? [s.checkpoint_id]).some(c => c?.includes("barcode")),
                              anomaly: (s.checkpoint_ids ?? [s.checkpoint_id]).some(c => c?.includes("anomaly")),
                            };
                            return ([{ key: "barcode", label: "Barcode" }, { key: "date", label: "Date" }, { key: "anomaly", label: "Anomalie" }] as const).map(({ key, label }) => {
                              const on = ec[key];
                              return (
                                <span key={key} style={{ padding: "1px 7px", borderRadius: 999, background: on ? "#dcfce7" : "#fee2e2", color: on ? "#15803d" : "#dc2626", fontSize: 10, fontWeight: 700, border: `1px solid ${on ? "#bbf7d0" : "#fecaca"}` }}>
                                  {label}{on ? " ✓" : " OFF"}
                                </span>
                              );
                            });
                          })()}
                        </div>
                        {isInterrupted && (
                          <div style={{ fontSize: 11, color: "#c2410c", marginTop: 6 }}>
                            Arrêt avant la fin prévue, survolez l’icône d’alerte pour le détail.
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {isInterrupted && (
                          <div
                            style={{ position: "relative" }}
                            onMouseLeave={() => setInterruptionTooltipSessionId((current) => current === s.id ? null : current)}
                          >
                            <button
                              type="button"
                              aria-label="Voir le détail de l'interruption"
                              onMouseEnter={(e) => openInterruptionTooltip(s.id, e.currentTarget)}
                              onFocus={(e) => openInterruptionTooltip(s.id, e.currentTarget)}
                              onBlur={() => setInterruptionTooltipSessionId((current) => current === s.id ? null : current)}
                              onClick={(e) => {
                                setInterruptionTooltipSessionId((current) => {
                                  if (current === s.id) return null;
                                  openInterruptionTooltip(s.id, e.currentTarget);
                                  return s.id;
                                });
                              }}
                              style={{ width: 36, height: 36, borderRadius: 10, border: "1px solid #fdba74", background: "#fff7ed", color: "#c2410c", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: interruptionTooltipOpen ? "0 8px 24px rgba(249,115,22,0.18)" : "none" }}
                            >
                              <TriangleAlert size={16} />
                            </button>
                            {interruptionTooltipOpen && (
                              <div style={{ position: "absolute", ...(interruptionTooltipPlacement === "top" ? { bottom: "calc(100% + 12px)" } : { top: "calc(100% + 12px)" }), right: 0, width: 300, maxWidth: "min(300px, 72vw)", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: "14px 16px", boxShadow: "0 20px 48px rgba(15,23,42,0.18)", zIndex: 30 }}>
                                <div style={{ position: "absolute", ...(interruptionTooltipPlacement === "top" ? { bottom: -7, borderRight: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" } : { top: -7, borderLeft: "1px solid #e5e7eb", borderTop: "1px solid #e5e7eb" }), right: 12, width: 14, height: 14, background: "#fff", transform: "rotate(45deg)" }} />
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                                  <div style={{ width: 30, height: 30, borderRadius: 10, background: "#fff7ed", border: "1px solid #fdba74", color: "#c2410c", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                    <TriangleAlert size={15} />
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", lineHeight: 1.2 }}>Session interrompue</div>
                                    <div style={{ fontSize: 11, color: "#f97316", marginTop: 2 }}>Fin avant l’horaire prévu</div>
                                  </div>
                                </div>
                                <div style={{ display: "grid", gap: 8 }}>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                                    <span style={{ color: "#6b7280" }}>Créneau prévu</span>
                                    <span style={{ color: "#111827", fontWeight: 700, textAlign: "right" }}>{plannedShiftStart ?? "—"} - {plannedShiftEnd ?? "—"}</span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                                    <span style={{ color: "#6b7280" }}>Arrêt réel</span>
                                    <span style={{ color: "#111827", fontWeight: 700, textAlign: "right" }}>{formatShortTime(endDate)}</span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                                    <span style={{ color: "#6b7280" }}>Temps coupé</span>
                                    <span style={{ color: "#c2410c", fontWeight: 700, textAlign: "right" }}>{formatDurationMinutes(interruptedMinutes)}</span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12, paddingTop: 8, marginTop: 2, borderTop: "1px solid #f3f4f6" }}>
                                    <span style={{ color: "#6b7280" }}>Cause</span>
                                    <span style={{ color: "#111827", fontWeight: 700, textAlign: "right", textTransform: "capitalize" }}>{interruptionCause}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        <button onClick={() => onSessionClick(s)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", background: "#0d9488", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                          <Eye size={14} /> Voir session
                        </button>
                        <button onClick={() => openFeedbackModal({ scope: "session", sessionId: s.id, date: daySummary.date })} title="Signaler un problème" style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e", fontSize: 13, cursor: "pointer" }}>
                          <Flag size={14} />
                        </button>
                        {canDelete && (
                          <button
                            onClick={() => setDeleteTarget({ id: s.id, label: `Session ${sessionNum}`, startH, endH })}
                            disabled={deletingId === s.id}
                            title="Supprimer cette session"
                            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff5f5", color: "#dc2626", fontSize: 13, cursor: deletingId === s.id ? "wait" : "pointer", opacity: deletingId === s.id ? 0.6 : 1 }}
                          >
                            {deletingId === s.id ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={14} />}
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                      <MiniStat icon={<CheckCircle2 size={16} color="#16a34a" />} bg="#dcfce7" value={(s.ok_count ?? 0).toLocaleString()} label="Conformes" />
                      <MiniStat icon={<AlertCircle size={16} color="#dc2626" />} bg="#fee2e2" value={nok} label="Anomalies" />
                      <MiniStat icon={<Camera size={16} color="#2563eb" />} bg="#dbeafe" value={pct + "%"} label="Conformité" />
                      <MiniStat icon={<Timer size={16} color="#9333ea" />} bg="#f3e8ff" value={durLabel} label="Durée" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Stats view ── */}
          {viewMode === "stats" && (() => {
            const sorted = [...daySummary.sessions].sort((a, b) => {
              const aT = parseBackendTimestamp(a.started_at)?.getTime() ?? 0;
              const bT = parseBackendTimestamp(b.started_at)?.getTime() ?? 0;
              return aT - bT;
            });
            const chartData = sorted.map((s) => {
              const total = s.total ?? 0;
              const nok = (s.nok_no_barcode ?? 0) + (s.nok_no_date ?? 0) + (s.nok_anomaly ?? 0);
              const pct = total > 0 ? (s.ok_count / total) * 100 : 0;
              const startMs = parseBackendTimestamp(s.started_at)?.getTime() ?? 0;
              const endMs   = parseBackendTimestamp(s.ended_at)?.getTime()   ?? 0;
              const durMin  = startMs && endMs && endMs > startMs ? (endMs - startMs) / 60000 : 1;
              const paquetsPerMin   = total / durMin;
              const anomaliesPerMin = nok   / durMin;
              return {
                label: formatTunisiaTime(s.started_at),
                conformite: pct,
                paquets: paquetsPerMin,
                anomalies: anomaliesPerMin,
                totalAbs: total,
                nokAbs: nok,
                durMin,
              };
            });
            const metricCfg = statsMetric === "conformite"
              ? { label: "Conformité %",  color: "#22c55e", area: "#c7f0d8", fmt: (v: number) => v.toFixed(1) + "%",   unit: "" }
              : statsMetric === "paquets"
              ? { label: "Paquets / min", color: "#2563eb", area: "#bfdbfe", fmt: (v: number) => v.toFixed(1) + "/min", unit: "/min" }
              : { label: "Anomalies / min", color: "#ef4444", area: "#fecaca", fmt: (v: number) => v.toFixed(2) + "/min", unit: "/min" };
            const rawVals = chartData.map((d) => d[statsMetric]);
            const maxVal = statsMetric === "conformite" ? 100 : Math.max(...rawVals, 1);
            const n = chartData.length;
            const VW = 700; const VH = 230;
            const XMIN = 52; const YMIN = 16; const YMAX = 190;
            const xOf = (i: number) => n <= 1 ? VW / 2 : XMIN + (i / (n - 1)) * (VW - XMIN - 8);
            const yOf = (v: number) => YMAX - ((v / maxVal) * (YMAX - YMIN));
            const pts = chartData.map((d, i) => ({ x: xOf(i), y: yOf(d[statsMetric]) }));
            const gridLevels = [0, 0.25, 0.5, 0.75, 1];
            const hov = statsHoveredIdx !== null && statsHoveredIdx < n ? chartData[statsHoveredIdx] : null;
            return (
              <div>
                {/* Metric picker */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    <TrendingUp size={16} color="#0d9488" /> Évolution par session
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["conformite", "paquets", "anomalies"] as const).map((m) => {
                      const c = m === "conformite" ? { label: "Conformité %", col: "#22c55e" } : m === "paquets" ? { label: "Paquets/min", col: "#2563eb" } : { label: "Anomalies/min", col: "#ef4444" };
                      const active = statsMetric === m;
                      return (
                        <button key={m} onClick={() => { setStatsMetric(m); setStatsHoveredIdx(null); }}
                          style={{ padding: "5px 13px", borderRadius: 20, border: `1px solid ${active ? c.col : "#e0e0e0"}`, fontSize: 12, cursor: "pointer", fontWeight: active ? 700 : 500, background: active ? c.col : "#fff", color: active ? "#fff" : "#555", transition: "all .12s" }}>
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {n < 2 ? (
                  <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8", fontSize: 13 }}>Pas assez de sessions pour afficher une courbe.</div>
                ) : (
                  <div style={{ position: "relative", width: "100%", height: 260 }} onMouseLeave={() => setStatsHoveredIdx(null)}>
                    <svg
                      viewBox={`0 0 ${VW} ${VH + 26}`}
                      preserveAspectRatio="none"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
                    >
                      {/* Grid + Y labels */}
                      {gridLevels.map((pct, gi) => {
                        const yg = yOf(pct * maxVal);
                        const lbl = statsMetric === "conformite" ? (pct * 100).toFixed(0) + "%" : Math.round(pct * maxVal).toLocaleString();
                        return (
                          <g key={gi}>
                            <line x1={XMIN} y1={yg} x2={VW - 4} y2={yg} stroke="#f0f0f0" strokeWidth="1" />
                            <text x={XMIN - 5} y={yg + 4} fontSize="10" fill="#aaa" textAnchor="end">{lbl}</text>
                          </g>
                        );
                      })}
                      {/* Y axis */}
                      <line x1={XMIN} y1={YMIN} x2={XMIN} y2={YMAX + 2} stroke="#e2e8f0" strokeWidth="1" />
                      {/* Area fill */}
                      <polygon
                        points={[`${pts[0].x},${YMAX}`, ...pts.map((p) => `${p.x},${p.y}`), `${pts[n - 1].x},${YMAX}`].join(" ")}
                        fill={metricCfg.area} opacity="0.4"
                      />
                      {/* Line */}
                      <polyline
                        points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
                        fill="none" stroke={metricCfg.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      />
                      {/* X labels */}
                      {pts.map((p, i) => (
                        <text key={i} x={p.x} y={VH + 20} fontSize="10" fill="#94a3b8" textAnchor="middle">{chartData[i].label}</text>
                      ))}
                      {/* Hover vertical guide + dots */}
                      {pts.map((p, i) => (
                        <g key={i} style={{ cursor: "pointer" }} onMouseEnter={() => setStatsHoveredIdx(i)}>
                          <rect x={p.x - 16} y={YMIN} width={32} height={YMAX - YMIN} fill="transparent" />
                          {statsHoveredIdx === i && (
                            <line x1={p.x} y1={YMIN} x2={p.x} y2={YMAX} stroke={metricCfg.color} strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
                          )}
                          <circle cx={p.x} cy={p.y} r={statsHoveredIdx === i ? 5 : 3} fill={metricCfg.color} stroke="#fff" strokeWidth="2" />
                        </g>
                      ))}
                    </svg>

                    {/* Hover tooltip — flips left when near right edge */}
                    {hov !== null && statsHoveredIdx !== null && (() => {
                      const p = pts[statsHoveredIdx];
                      const leftPct = n <= 1 ? 50 : ((p.x - XMIN) / (VW - XMIN - 8)) * 100;
                      const near = leftPct > 65;
                      return (
                        <div style={{
                          position: "absolute",
                          top: Math.max(4, (p.y / VH) * 230 - 60),
                          ...(near ? { right: `calc(${100 - leftPct}% + 14px)` } : { left: `calc(${leftPct}% + 14px)` }),
                          background: "#fff",
                          borderRadius: 10,
                          padding: "10px 14px",
                          boxShadow: "0 4px 20px rgba(0,0,0,0.13)",
                          border: `1px solid ${metricCfg.color}40`,
                          zIndex: 20,
                          fontSize: 12,
                          whiteSpace: "nowrap",
                          pointerEvents: "none",
                          minWidth: 140,
                        }}>
                          <div style={{ color: "#94a3b8", fontSize: 11, marginBottom: 4 }}>Session #{statsHoveredIdx + 1} — {hov.label}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: metricCfg.color, display: "inline-block" }} />
                            <span style={{ fontWeight: 800, color: metricCfg.color, fontSize: 15 }}>{metricCfg.fmt(hov[statsMetric])}</span>
                          </div>
                          <div style={{ display: "grid", gap: 2 }}>
                            {statsMetric !== "conformite" && <div style={{ fontSize: 11, color: "#64748b" }}>Conformité : <b>{hov.conformite.toFixed(1)}%</b></div>}
                            {statsMetric !== "paquets"    && <div style={{ fontSize: 11, color: "#64748b" }}>Paquets/min : <b>{hov.paquets.toFixed(1)}</b></div>}
                            {statsMetric !== "anomalies"  && <div style={{ fontSize: 11, color: "#64748b" }}>Anomalies/min : <b style={{ color: "#ef4444" }}>{hov.anomalies.toFixed(2)}</b></div>}
                            <div style={{ fontSize: 11, color: "#64748b", borderTop: "1px solid #f1f5f9", paddingTop: 4, marginTop: 2 }}>Durée : <b>{hov.durMin >= 60 ? `${Math.floor(hov.durMin / 60)}h ${Math.round(hov.durMin % 60)}m` : `${Math.round(hov.durMin)}m`}</b></div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>Total paquets : <b>{hov.totalAbs.toLocaleString()}</b></div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Summary table */}
                <div style={{ marginTop: 28, borderRadius: 12, overflow: "hidden", border: "1px solid #f1f5f9" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "36px 100px 64px 1fr 72px 80px 80px", padding: "8px 16px", background: "#f8fafc", fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", gap: 8 }}>
                    <span>#</span>
                    <span>Heure</span>
                    <span style={{ textAlign: "right" }}>Durée</span>
                    <span />
                    <span style={{ textAlign: "right" }}>Total</span>
                    <span style={{ textAlign: "right" }}>Conforme</span>
                    <span style={{ textAlign: "right", color: "#ef4444" }}>Anom/min</span>
                  </div>
                  {sorted.map((s, i) => {
                    const d = chartData[i];
                    const pct = d.totalAbs > 0 ? ((s.ok_count ?? 0) / d.totalAbs * 100).toFixed(1) : "—";
                    const startH = formatTunisiaTime(s.started_at);
                    const endH   = formatTunisiaTime(s.ended_at);
                    const durLabel = d.durMin >= 60 ? `${Math.floor(d.durMin / 60)}h${Math.round(d.durMin % 60)}m` : `${Math.round(d.durMin)}m`;
                    const isHov  = statsHoveredIdx === i;
                    return (
                      <div key={i}
                        onMouseEnter={() => setStatsHoveredIdx(i)}
                        onMouseLeave={() => setStatsHoveredIdx(null)}
                        style={{ display: "grid", gridTemplateColumns: "36px 100px 64px 1fr 72px 80px 80px", alignItems: "center", padding: "9px 16px", fontSize: 12, borderTop: "1px solid #f1f5f9", background: isHov ? "#f0fdf4" : "#fff", cursor: "default", transition: "background .1s", gap: 8 }}>
                        <span style={{ fontWeight: 700, color: isHov ? metricCfg.color : "#94a3b8", fontSize: 13 }}>#{i + 1}</span>
                        <span style={{ color: "#64748b", whiteSpace: "nowrap", fontSize: 12 }}>{startH}–{endH}</span>
                        <span style={{ textAlign: "right", color: "#94a3b8", fontWeight: 500 }}>{durLabel}</span>
                        <span />
                        <span style={{ textAlign: "right", fontWeight: 600, color: "#0f172a" }}>{d.totalAbs.toLocaleString()}</span>
                        <span style={{ textAlign: "right", fontWeight: 600, color: "#16a34a" }}>{pct}%</span>
                        <span style={{ textAlign: "right", fontWeight: 700, color: d.nokAbs > 0 ? "#ef4444" : "#94a3b8" }}>{d.anomalies.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          </div>
        </div>
      </div>

      {/* ── Delete confirmation modal ── */}
      {deleteTarget && (
        <div onClick={() => setDeleteTarget(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 420, maxWidth: "94vw", padding: "28px 28px 24px", boxShadow: "0 24px 60px rgba(0,0,0,0.22)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, background: "#fef2f2", border: "1px solid #fecaca", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Trash2 size={20} color="#dc2626" />
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "#0f172a" }}>Supprimer {deleteTarget.label} ?</div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>{deleteTarget.startH} – {deleteTarget.endH}</div>
              </div>
            </div>
            <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 24px", lineHeight: 1.6 }}>
              Cette action est <strong style={{ color: "#dc2626" }}>irréversible</strong>. Toutes les statistiques et données de détection associées à cette session seront définitivement supprimées.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setDeleteTarget(null)} style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#f8fafc", color: "#475569", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Annuler
              </button>
              <button onClick={handleDeleteSession} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
                <Trash2 size={14} /> Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Session Detail View (uses real API data) ────────────────────────────────

function HistSessionDetailView({ session, daySummary, defectLabel, onBack, setModalAnomaly, setExportModal, modalAnomaly, exportModal, openFeedbackModal }: {
  session: Session; daySummary: DaySummary; defectLabel: (t: string) => string; onBack: () => void;
  setModalAnomaly: (a: AnomalyItem | null) => void; setExportModal: (d: AnomalyItem[] | null) => void;
  modalAnomaly: AnomalyItem | null; exportModal: AnomalyItem[] | null;
  openFeedbackModal: (preset?: Record<string, string>) => void;
}) {
  const [crossings, setCrossings] = useState<any[]>([]);
  const [crossLoading, setCrossLoading] = useState(true);
  const [anomPage, setAnomalPage] = useState(0);
  const [activeFilter, setActiveFilter] = useState("Tous");
  const [galleryExpanded, setGalleryExpanded] = useState(false);
  const PER_PAGE = 8;

  const total = session.total ?? 0;
  const nok = (session.nok_no_barcode ?? 0) + (session.nok_no_date ?? 0) + (session.nok_anomaly ?? 0);
  const pct = total > 0 ? +((session.ok_count / total) * 100).toFixed(2) : 0;
  const startH = formatTunisiaTime(session.started_at);
  const endH = formatTunisiaTime(session.ended_at);
  const dayLabel = formatAdminDate(daySummary.date, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

  useEffect(() => {
    let cancelled = false;
    backendApi.getCrossings(session.id, 5000).then((r: any) => {
      if (!cancelled) setCrossings(r?.crossings ?? []);
    }).catch(() => {}).finally(() => { if (!cancelled) setCrossLoading(false); });
    return () => { cancelled = true; };
  }, [session.id]);

  const anomalyItems: AnomalyItem[] = [...crossings].reverse().map((c: any, i: number) => ({
    id: c.packet_num ?? i + 1,
    type: defectLabel(c.defect_type),
    time: formatTunisiaTime(c.crossed_at, true),
    lot: `#${c.packet_num ?? "?"}`,
    score: 0,
    category: galleryCategoryFromDefectType(c.defect_type),
    img: backendApi.proofImageUrl(c.session_id ?? session.id, c.defect_type, c.packet_num ?? 0),
    fallbackImg: proofFallbackForDefectType(c.defect_type),
  }));

  const filtered = activeFilter === "Tous" ? anomalyItems
    : anomalyItems.filter((a) => a.category === activeFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const pageAnom = filtered.slice(anomPage * PER_PAGE, (anomPage + 1) * PER_PAGE);

  const resultats = [
    { label: "Paquets conformes", count: session.ok_count ?? 0, color: "#22c55e" },
    { label: "Paquet sans code à barre", count: session.nok_no_barcode ?? 0, color: "#84CC16" },
    { label: "Date non visible", count: session.nok_no_date ?? 0, color: "#06B6D4" },
    { label: "Anomalie détectée", count: session.nok_anomaly ?? 0, color: "#16A34A" },
  ].filter((r) => r.count > 0);

  return (
    <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#1a1a1a" }}>
      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, fontSize: 13, color: "#888" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#555", fontWeight: 500, padding: 0, fontSize: 13 }}>
          <ArrowLeft size={15} /> Historique
        </button>
        <ChevronRight size={14} color="#ccc" />
        <span style={{ color: "#888" }}>{dayLabel}</span>
        <ChevronRight size={14} color="#ccc" />
        <span style={{ color: "#111", fontWeight: 600 }}>Session</span>
      </div>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#6366f1,#4f46e5)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <BarChart2 size={24} color="white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Session — {dayLabel}</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#777", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
              <span>{startH} – {endH}</span>
              {(() => {
                const ec = session.enabled_checks ?? {
                  barcode: (session.checkpoint_ids ?? [session.checkpoint_id]).some(c => c?.includes("barcode")),
                  date:    (session.checkpoint_ids ?? [session.checkpoint_id]).some(c => c?.includes("barcode")),
                  anomaly: (session.checkpoint_ids ?? [session.checkpoint_id]).some(c => c?.includes("anomaly")),
                };
                return ([{ key: "barcode", label: "Barcode" }, { key: "date", label: "Date" }, { key: "anomaly", label: "Anomalie" }] as const).map(({ key, label }) => {
                  const on = ec[key];
                  return (
                    <span key={key} style={{ padding: "2px 8px", borderRadius: 999, background: on ? "#dcfce7" : "#fee2e2", color: on ? "#15803d" : "#dc2626", fontSize: 11, fontWeight: 700, border: `1px solid ${on ? "#bbf7d0" : "#fecaca"}` }}>
                      {label}{on ? " ✓" : " OFF"}
                    </span>
                  );
                });
              })()}
            </p>
          </div>
        </div>
        <button onClick={() => openFeedbackModal({ scope: "session", sessionId: session.id, date: daySummary.date })} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "1px solid #fde68a", background: "#fffbeb", fontSize: 13, cursor: "pointer", fontWeight: 500, color: "#92400e" }}>
          <Flag size={14} />Signaler
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard icon={<CheckCircle2 size={24} color="#16a34a" />} iconBg="#dcfce7" value={(session.ok_count ?? 0).toLocaleString()} label="Paquets conformes" />
        <StatCard icon={<AlertCircle size={24} color="#dc2626" />} iconBg="#fee2e2" value={nok} label="Anomalies détectées" />
        <StatCard icon={<Camera size={24} color="#2563eb" />} iconBg="#dbeafe" value={pct + "%"} label="Taux de conformité" />
        <StatCard icon={<Timer size={24} color="#9333ea" />} iconBg="#f3e8ff" value="75/min" label="Cadence analyse" />
      </div>

      {/* Anomalies */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={18} color="#dc2626" />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Anomalies détectées</span>
            <span style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{anomalyItems.length}</span>
          </div>
          <Pager page={anomPage} total={totalPages} onChange={setAnomalPage} />
        </div>
        {crossLoading && <div style={{ fontSize: 13, color: "#0369a1", padding: 8 }}>Chargement des anomalies…</div>}
        {pageAnom.map((a, i) => (
          <div key={i} onClick={() => setModalAnomaly(a)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderRadius: 10, background: "#fef2f2", marginBottom: 8, cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertCircle size={16} color="#ef4444" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#dc2626" }}>{a.type}</div>
                <div style={{ fontSize: 11, color: "#999" }}>{a.time} • Paquet {a.lot}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ChevronRight size={14} color="#ccc" />
            </div>
          </div>
        ))}
      </div>

      {/* Résultats + Critères */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Résultats du contrôle</div>
          {resultats.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: i < resultats.length - 1 ? "1px solid #f5f5f5" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.color, display: "inline-block" }} />
                <span style={{ fontSize: 13 }}>{r.label}</span>
              </div>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{r.count}</span>
            </div>
          ))}
        </div>
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Critères de contrôle</div>
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 14 }}>
            {[["Ouverture", "Paquet scellé, pas de déchirure"], ["Code à barre", "Visible et lisible, non masqué"], ["Date péremption", "Visible, format JJ/MM/AAAA"]].map(([k, v], i) => (
              <div key={i} style={{ marginBottom: 10, fontSize: 12 }}>● <strong>{k} :</strong> <span style={{ color: "#666" }}>{v}</span></div>
            ))}
          </div>
        </div>
      </div>

      {/* Gallery Anomalies */}
      {crossings.length > 0 && (() => {
        const GALLERY_DEFAULT = 10;
        const galleryFiltered = activeFilter === "Tous" ? anomalyItems
          : anomalyItems.filter((a) => a.category === activeFilter);
        const galleryItems = galleryExpanded ? galleryFiltered : galleryFiltered.slice(0, GALLERY_DEFAULT);
        return (
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Camera size={18} color="#0ea5e9" />
                <span style={{ fontWeight: 700, fontSize: 15 }}>Galerie Anomalies</span>
                <span style={{ background: "#f0f4ff", color: "#2563eb", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{galleryFiltered.length} captures</span>
              </div>
              {galleryFiltered.length > GALLERY_DEFAULT && (
                <button onClick={() => setGalleryExpanded(!galleryExpanded)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: "1px solid #e0e0e0", background: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 500, color: "#333" }}>
                  <Eye size={14} />{galleryExpanded ? "Réduire" : "Voir tout (" + galleryFiltered.length + ")"}
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {FILTER_TABS.map((t, i) => (
                <button key={i} onClick={() => { setActiveFilter(t); setGalleryExpanded(false); }} style={{ padding: "5px 14px", borderRadius: 20, border: "1px solid #e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500, background: activeFilter === t ? "#111" : "#fff", color: activeFilter === t ? "#fff" : "#444", transition: "all .15s" }}>{t}</button>
              ))}
            </div>
            {crossLoading && <div style={{ fontSize: 13, color: "#0369a1", padding: 8 }}>Chargement…</div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
              {galleryItems.map((a) => (
                <div key={a.id} onClick={() => setModalAnomaly(a)}
                  style={{ borderRadius: 10, overflow: "hidden", cursor: "pointer", position: "relative", height: 160, transition: "transform .15s", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.02)")}
                  onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}>
                  <img
                    src={a.img}
                    alt={a.type}
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#f8fafc", padding: 8, boxSizing: "border-box" }}
                    onError={(e) => {
                      const img = e.currentTarget;
                      if (a.fallbackImg && img.src !== a.fallbackImg) {
                        img.src = a.fallbackImg;
                        return;
                      }
                      img.onerror = null;
                    }}
                  />
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(transparent,rgba(0,0,0,0.78))", padding: "20px 10px 10px" }}>
                    <div style={{ color: "#fff", fontWeight: 600, fontSize: 12 }}>{a.type}</div>
                    <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 10 }}>{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
            {!galleryExpanded && galleryFiltered.length > GALLERY_DEFAULT && (
              <div style={{ textAlign: "center", marginTop: 14 }}>
                <button onClick={() => setGalleryExpanded(true)} style={{ background: "none", border: "1px solid #e0e0e0", borderRadius: 8, padding: "8px 20px", fontSize: 13, cursor: "pointer", color: "#555", fontWeight: 500 }}>
                  + {galleryFiltered.length - GALLERY_DEFAULT} autres captures — Voir tout
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {modalAnomaly && <AnomalyModal anomaly={modalAnomaly} onClose={() => setModalAnomaly(null)} />}
      {exportModal && <ExportModal data={exportModal} onClose={() => setExportModal(null)} />}
    </div>
  );
}

export default GMCBHistorique;
