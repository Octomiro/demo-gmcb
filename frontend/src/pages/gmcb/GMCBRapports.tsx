import { useEffect, useState } from "react";
import {
  AlertCircle,
  Calendar,
  Download,
  FileText,
  Loader2,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { backendApi, type ReportSummary } from "@/core/backendApi";
import { useSessionHistory } from "@/hooks/useSessionHistory";
import { formatAdminDate, addDays, todayIso } from "./gmcbData";
import { CalendarPickerModal, StatCard } from "./gmcbComponents";

function formatNumber(value: number) {
  return value.toLocaleString("fr-FR");
}

const GMCBRapports = () => {
  const { days, loading: historyLoading } = useSessionHistory();
  const [rangeModalOpen, setRangeModalOpen] = useState(false);
  const [selectedRange, setSelectedRange] = useState<{ start: string; end: string } | null>(null);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadingDay, setDownloadingDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedRange) return;
    if (days.length > 0) {
      const end = days[0].date;
      const start = days[Math.min(days.length - 1, 6)]?.date ?? end;
      setSelectedRange({ start, end });
      return;
    }
    const end = todayIso();
    setSelectedRange({ start: addDays(end, -6), end });
  }, [days, selectedRange]);

  useEffect(() => {
    if (!selectedRange?.start || !selectedRange?.end) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    backendApi.getReportSummary(selectedRange.start, selectedRange.end)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setSummary(null);
          setError(err instanceof Error ? err.message : "Impossible de charger le rapport.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRange?.start, selectedRange?.end]);

  const availableDates = days.length > 0 ? days.map((day) => day.date) : [todayIso()];

  const handleDownloadPeriod = async () => {
    if (!selectedRange?.start || !selectedRange?.end) return;
    setDownloading(true);
    try {
      const { filename } = await backendApi.downloadReportPdf(selectedRange.start, selectedRange.end);
      toast.success("Rapport PDF généré", {
        description: filename,
      });
    } catch (err) {
      toast.error("Impossible de générer le PDF", {
        description: err instanceof Error ? err.message : "Réessayez dans quelques instants.",
      });
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadDay = async (dayDate: string) => {
    setDownloadingDay(dayDate);
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
      setDownloadingDay(null);
    }
  };

  return (
    <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#1a1a1a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#0f766e,#0d9488)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <FileText size={24} color="white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Rapports PDF</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
              Génération de rapports sur une période avec sessions, heures, modes actifs, conformité et anomalies.
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => setRangeModalOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10, border: "1px solid #dbeafe", background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
          >
            <Calendar size={14} />
            {selectedRange?.start && selectedRange?.end
              ? `${formatAdminDate(selectedRange.start, { day: "2-digit", month: "2-digit", year: "numeric" })} - ${formatAdminDate(selectedRange.end, { day: "2-digit", month: "2-digit", year: "numeric" })}`
              : "Choisir une période"}
          </button>
          <button
            onClick={handleDownloadPeriod}
            disabled={!selectedRange || downloading}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 10, border: "none", background: downloading ? "#99f6e4" : "#0f766e", color: "#fff", fontSize: 12, fontWeight: 800, cursor: downloading ? "wait" : "pointer" }}
          >
            {downloading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={14} />}
            {downloading ? "Génération..." : "Télécharger le PDF"}
          </button>
        </div>
      </div>

      {loading || historyLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#0f766e", padding: "18px 4px" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
          Chargement du résumé du rapport...
        </div>
      ) : error ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, color: "#dc2626", fontSize: 13, marginBottom: 18 }}>
          <AlertCircle size={15} />
          {error}
        </div>
      ) : summary ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 22 }}>
            <StatCard icon={<Calendar size={24} color="#4f46e5" />} iconBg="#eef2ff" value={formatNumber(summary.session_count)} label="Sessions activées" />
            <StatCard icon={<Timer size={24} color="#2563eb" />} iconBg="#dbeafe" value={summary.total_hours_label} label="Heures travaillées" />
            <StatCard icon={<ShieldCheck size={24} color="#16a34a" />} iconBg="#dcfce7" value={`${summary.conformity_rate_pct.toFixed(2)}%`} label="Taux de conformité" />
            <StatCard icon={<Calendar size={24} color="#0d9488" />} iconBg="#ccfbf1" value={summary.average_sessions_per_day.toFixed(2)} label="Moyenne sessions / jour" />
            <StatCard icon={<Timer size={24} color="#7c3aed" />} iconBg="#f3e8ff" value={`${summary.average_hours_per_day.toFixed(2)} h`} label="Moyenne heures / jour" />
            <StatCard icon={<TriangleAlert size={24} color="#dc2626" />} iconBg="#fee2e2" value={formatNumber(summary.total_anomalies)} label="Anomalies sur la période" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18, marginBottom: 20 }}>
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e8eaed", padding: 20 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>Modes actifs sur la période</div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
                Vue agrégée des modes de contrôle observés dans les sessions sélectionnées.
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {summary.active_modes.map((mode) => (
                  <div key={mode.key} style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid #eef2f7", background: mode.active ? "#fcfffe" : "#f8fafc", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 999, background: mode.color, display: "inline-block" }} />
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{mode.label}</span>
                        <span style={{ padding: "3px 8px", borderRadius: 999, background: mode.active ? "#dcfce7" : "#e2e8f0", color: mode.active ? "#166534" : "#475569", fontSize: 11, fontWeight: 700 }}>
                          {mode.active ? "Actif" : "Absent"}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>
                        {mode.session_count} session(s) • {mode.hours.toFixed(2)} h • {mode.session_share_pct.toFixed(1)}% des sessions
                      </div>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 82 }}>
                      <div style={{ fontWeight: 800, fontSize: 16, color: mode.color }}>{mode.hours_share_pct.toFixed(1)}%</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>du temps total</div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #f1f5f9" }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Combinaisons observées</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {summary.mode_combinations.length > 0 ? summary.mode_combinations.map((combo) => (
                    <div key={combo.label} style={{ padding: "8px 10px", borderRadius: 999, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 12, color: "#334155" }}>
                      <strong>{combo.label}</strong> • {combo.count} session(s)
                    </div>
                  )) : (
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>Aucune combinaison relevée sur cette période.</div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e8eaed", padding: 20 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>Anomalies par type</div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
                Répartition et taux de défauts sur la période choisie.
              </div>

              <div style={{ display: "grid", gap: 14 }}>
                {summary.anomalies_by_type.map((row) => {
                  const width = summary.total_anomalies > 0 ? (row.count / summary.total_anomalies) * 100 : 0;
                  return (
                    <div key={row.key}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 999, background: row.color, display: "inline-block" }} />
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{row.label}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "#475569" }}>
                          {row.count} • {row.share_pct.toFixed(1)}% des anomalies • {row.rate_pct.toFixed(2)}% du flux
                        </div>
                      </div>
                      <div style={{ height: 10, borderRadius: 999, background: "#f1f5f9", overflow: "hidden" }}>
                        <div style={{ width: `${width}%`, height: "100%", background: row.color, borderRadius: 999, transition: "width .2s ease" }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 18 }}>
                <div style={{ padding: "12px 14px", borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>Paquets analysés</div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>{formatNumber(summary.total_packets)}</div>
                </div>
                <div style={{ padding: "12px 14px", borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>Paquets conformes</div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>{formatNumber(summary.total_conformes)}</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e8eaed", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>Détail par journée</div>
                <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
                  Export PDF disponible pour chaque journée individuellement.
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                {summary.total_days} jour(s) sélectionné(s)
              </div>
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              {summary.days.map((day) => (
                <div key={day.date} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", padding: "14px 16px", borderRadius: 12, border: "1px solid #f1f5f9", background: "#fff" }}>
                  <div style={{ flex: "1 1 240px" }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{day.date_label}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                      {day.modes_active.length > 0 ? day.modes_active.join(", ") : "Aucun mode actif enregistré"}
                    </div>
                  </div>
                  <div style={{ minWidth: 90 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>Sessions</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#4f46e5" }}>{day.session_count}</div>
                  </div>
                  <div style={{ minWidth: 90 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>Heures</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#2563eb" }}>{day.worked_hours_label}</div>
                  </div>
                  <div style={{ minWidth: 90 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>Conformité</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#16a34a" }}>{day.conformity_rate_pct.toFixed(2)}%</div>
                  </div>
                  <div style={{ minWidth: 90 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>Anomalies</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#dc2626" }}>{day.total_anomalies}</div>
                  </div>
                  <button
                    onClick={() => handleDownloadDay(day.date)}
                    disabled={downloadingDay === day.date}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 10, border: "1px solid #cbd5e1", background: "#f8fafc", color: "#0f172a", fontSize: 12, fontWeight: 800, cursor: downloadingDay === day.date ? "wait" : "pointer" }}
                  >
                    {downloadingDay === day.date ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={14} />}
                    PDF
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {rangeModalOpen && (
        <CalendarPickerModal
          mode="range"
          availableDates={availableDates}
          selectedRange={selectedRange}
          onClose={() => setRangeModalOpen(false)}
          onApplyRange={(range) => {
            setSelectedRange(range);
            setRangeModalOpen(false);
          }}
        />
      )}
    </div>
  );
};

export default GMCBRapports;
