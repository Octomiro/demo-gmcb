import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ScanLine, CheckCircle2, AlertCircle, Camera, Timer, Video,
  Maximize2, Settings, Filter, ChevronRight, Eye, X,
  SlidersHorizontal, RotateCw, ArrowLeftRight, PlayCircle, LayoutDashboard, ArrowLeft,
  Loader2, Square, Clock,
} from "lucide-react";
import logoOctoNorm from "@/assets/logo-octonorm.webp";
import {
  FILTER_TABS, todayIso, formatAdminDate, formatTunisiaTime, formatStopCountdown, galleryCategoryFromDefectType, proofFallbackForDefectType,
  type AnomalyItem,
} from "./gmcbData";
import {
  StatCard, CamFeed, Pager, ExportModal, AnomalyModal,
} from "./gmcbComponents";
import { useLiveStats } from "@/hooks/useLiveStats";
import { backendApi } from "@/core/backendApi";
import { toast } from "sonner";

const GMCBQualite = () => {
  const navigate = useNavigate();
  const stats = useLiveStats();
  const [startingSession, setStartingSession] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<string | null>(null);
  const sessionStartTimeRef = useRef<string | null>(null);
  const dbWasDown = useRef(false);
  const [hourlyStats, setHourlyStats] = useState<any[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState("pipeline_barcode_date");
  const [pipelineOptions, setPipelineOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [crossings, setCrossings] = useState<any[]>([]);
  const [anomPage, setAnomalPage] = useState(0);
  const [activeFilter, setActiveFilter] = useState("Tous");
  const [galleryExpanded, setGalleryExpanded] = useState(false);
  const [modalAnomaly, setModalAnomaly] = useState<AnomalyItem | null>(null);
  const [exportModal, setExportModal] = useState<AnomalyItem[] | null>(null);
  const [paramOpen, setParamOpen] = useState(false);
  const [elPct, setElPct] = useState(85);
  const [elVertical, setElVertical] = useState(true);
  const [elInverted, setElInverted] = useState(true);
  const PER_PAGE = 8;
  const [scheduledStop, setScheduledStop] = useState<string | null>(null);
  const [stopTimeInput, setStopTimeInput] = useState("");
  const [stopPickerOpen, setStopPickerOpen] = useState(false);
  const [scheduleSessionOpen, setScheduleSessionOpen] = useState(false);
  const [scheduleSessionTime, setScheduleSessionTime] = useState("");
  const [schedulingSession, setSchedulingSession] = useState(false);
  const wasRunningRef = useRef(false);

  // Defect type → French label
  const defectLabel = (t: string) =>
    t === "nobarcode" ? "Absence code à barre"
    : t === "nodate" ? "Date non visible"
    : t === "anomaly" ? "Anomalie détectée"
    : t ?? "—";

  // Track session start time
  useEffect(() => {
    if (stats.isRunning) {
      wasRunningRef.current = true;
      if (!sessionStartTimeRef.current) {
        const timeStr = formatTunisiaTime(new Date(), true);
        sessionStartTimeRef.current = timeStr;
        setSessionStartTime(timeStr);
      }
    } else {
      if (wasRunningRef.current) {
        // Session ended while user is on this page — redirect to history (auto-stop case)
        setTimeout(() => navigate("/clients/gmcb/historique", { state: { openLatestSession: true } }), 2500);
      }
      wasRunningRef.current = false;
      sessionStartTimeRef.current = null;
      setSessionStartTime(null);
    }
  }, [stats.isRunning]);

  // Fetch scheduled stop when session starts + keep in sync every 30s
  useEffect(() => {
    if (!stats.isRunning) { setScheduledStop(null); return; }
    const sync = () => backendApi.getScheduledStop().then(r => setScheduledStop(r.scheduled_stop ?? null)).catch(() => {});
    sync();
    const interval = setInterval(sync, 30_000);
    return () => clearInterval(interval);
  }, [stats.isRunning]);

  // Notify when database disconnects during an active session
  useEffect(() => {
    if (!stats.isRunning) {
      dbWasDown.current = false;
      return;
    }
    if (!stats.dbConnected && !dbWasDown.current) {
      dbWasDown.current = true;
      toast.error("Base de données déconnectée — les statistiques ne sont plus enregistrées.", { duration: 10000 });
    } else if (stats.dbConnected && dbWasDown.current) {
      dbWasDown.current = false;
      toast.success("Base de données reconnectée.", { duration: 5000 });
    }
  }, [stats.isRunning, stats.dbConnected]);

  // Sync exit-line params from backend whenever pipeline selection changes
  useEffect(() => {
    backendApi.getPipelineStats(selectedPipeline).then((s: any) => {
      if (s.exit_line_pct != null) setElPct(s.exit_line_pct);
      if (s.exit_line_vertical != null) setElVertical(s.exit_line_vertical);
      if (s.exit_line_inverted != null) setElInverted(s.exit_line_inverted);
    }).catch(() => {});
  }, [selectedPipeline]);

  // Fetch hourly conformity stats
  useEffect(() => {
    let cancelled = false;
    async function fetchHourlyStats() {
      if (!stats.isRunning) {
        setHourlyStats([]);
        return;
      }
      try {
        const promises: Promise<any>[] = [];
        if (stats.sessionId0) promises.push(backendApi.getHourlyStats(stats.sessionId0));
        if (stats.sessionId1) promises.push(backendApi.getHourlyStats(stats.sessionId1));
        const results = await Promise.all(promises);
        const merged = results.flatMap((r: any) => r?.hourly_stats ?? []);
        if (!cancelled) setHourlyStats(merged);
      } catch {
        // silent — keep previous hourly stats
      }
    }
    fetchHourlyStats();
    return () => { cancelled = true; };
  }, [stats.isRunning, stats.sessionId0, stats.sessionId1]);

  // Fetch crossings whenever totalPackets changes (every crossing = new packet detected)
  useEffect(() => {
    let cancelled = false;
    async function fetchCrossings() {
      if (stats.sessionId0 == null && stats.sessionId1 == null) {
        setCrossings([]);
        return;
      }
      try {
        const promises: Promise<any>[] = [];
        if (stats.sessionId0) promises.push(backendApi.getCrossings(stats.sessionId0, 50));
        if (stats.sessionId1) promises.push(backendApi.getCrossings(stats.sessionId1, 50));
        const results = await Promise.all(promises);
        const merged = results.flatMap((r: any) => r?.crossings ?? []);
        merged.sort((a: any, b: any) => (b.crossed_at ?? "").localeCompare(a.crossed_at ?? ""));
        if (!cancelled) setCrossings(merged.slice(0, 50));
      } catch {
        // silent — keep previous crossings
      }
    }
    fetchCrossings();
    return () => { cancelled = true; };
  }, [stats.sessionId0, stats.sessionId1, stats.totalPackets]);

  // Map crossings to AnomalyItem shape for existing filter / gallery / modal UI
  const anomalyItems: AnomalyItem[] = crossings.map((c: any, i: number) => ({
    id: c.packet_num ?? i + 1,
    type: defectLabel(c.defect_type),
    time: formatTunisiaTime(c.crossed_at, true),
    lot: `#${c.packet_num ?? "?"}`,
    score: 0,
    category: galleryCategoryFromDefectType(c.defect_type),
    img: backendApi.proofImageUrl(
      c.session_id
      ?? (c.defect_type === "anomaly" ? stats.sessionId1 : stats.sessionId0)
      ?? stats.sessionId1
      ?? "",
      c.defect_type,
      c.packet_num ?? 0,
    ),
    fallbackImg: proofFallbackForDefectType(c.defect_type),
  }));

  const filtered = activeFilter === "Tous"
    ? anomalyItems
    : anomalyItems.filter((a) => a.category === activeFilter);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const pageAnom = filtered.slice(anomPage * PER_PAGE, (anomPage + 1) * PER_PAGE);
  const galleryItems = galleryExpanded ? filtered : filtered.slice(0, 8);

  // MJPEG stream: use ref so we can kill the connection on unmount / page switch
  const mjpegRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    return () => {
      // On unmount, blank the src to close the MJPEG HTTP connection
      if (mjpegRef.current) {
        mjpegRef.current.src = "";
        mjpegRef.current = null;
      }
    };
  }, []);

  // Load pipeline options for the live-view dropdown from backend config.
  useEffect(() => {
    let cancelled = false;
    async function loadPipelines() {
      try {
        const res = await backendApi.listPipelines();
        if (cancelled) return;
        const opts = (res.pipelines || []).map((p: any) => ({ id: p.id, label: p.label }));
        setPipelineOptions(opts);
        if (res.active_view_id) setSelectedPipeline(res.active_view_id);
      } catch {
        // Keep fallback hardcoded selection if backend is temporarily unavailable.
      }
    }
    loadPipelines();
    return () => { cancelled = true; };
  }, []);

  const sessionIso = todayIso();
  const dateLabel = formatAdminDate(sessionIso, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const showNoSessionModal = !stats.loading && !stats.isRunning;

  if (stats.loading) {
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'DM Sans','Segoe UI',sans-serif" }}>
        <div style={{ width: 420, maxWidth: "92vw", borderRadius: 28, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(148,163,184,0.18)", boxShadow: "0 32px 80px rgba(15,23,42,0.12)", padding: "34px 30px", textAlign: "center" }}>
          <div style={{ width: 62, height: 62, borderRadius: "50%", margin: "0 auto 18px", background: "linear-gradient(135deg,#e0f2fe,#ccfbf1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ScanLine size={28} color="#0f766e" />
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>Ouverture de la session live</div>
          <div style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6, marginBottom: 20 }}>
            Vérification de l'état des pipelines et de la session active…
          </div>
          <div style={{ width: "100%", height: 8, borderRadius: 999, background: "#e2e8f0", overflow: "hidden" }}>
            <div style={{ width: "38%", height: "100%", borderRadius: 999, background: "linear-gradient(90deg,#0ea5e9,#0d9488)" }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 32px", fontFamily: "'DM Sans','Segoe UI',sans-serif", color: "#1a1a1a" }}>

      {/* No-active-session overlay */}
      {showNoSessionModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.9)", backdropFilter: "blur(16px) saturate(0.7)", WebkitBackdropFilter: "blur(16px) saturate(0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "rgba(255,255,255,0.98)", borderRadius: 24, width: 420, maxWidth: "94vw", padding: 40, textAlign: "center", boxShadow: "0 36px 120px rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.18)" }}>
            {/* icon */}
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <Video size={32} color="#94a3b8" />
            </div>
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 800, color: "#0f172a" }}>Aucun live en cours</h2>
            <p style={{ margin: "0 0 32px", fontSize: 14, color: "#64748b", lineHeight: 1.6 }}>Aucune session de contrôle n'est active en ce moment. Vous pouvez démarrer une session manuellement ou planifier des créneaux depuis le tableau de bord admin.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <button
                disabled={startingSession}
                onClick={async () => {
                  setStartingSession(true);
                  try {
                    await backendApi.startAll();
                    await backendApi.toggleRecording();
                  } catch {
                    toast.error("Impossible de démarrer la session. Vérifiez que le système est en ligne.");
                  } finally { setStartingSession(false); }
                }}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 24px", borderRadius: 12, border: "none", background: "linear-gradient(135deg,#0ea5e9,#0d9488)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: startingSession ? "wait" : "pointer", opacity: startingSession ? 0.7 : 1 }}
              >
                <PlayCircle size={18} /> {startingSession ? "Démarrage…" : "Démarrer une session"}
              </button>

              {/* Schedule session: start now + set end time */}
              {!scheduleSessionOpen ? (
                <button
                  disabled={startingSession || schedulingSession}
                  onClick={() => setScheduleSessionOpen(true)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 24px", borderRadius: 12, border: "none", background: "#b45309", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
                >
                  <Clock size={16} /> Démarrer et planifier la fin
                </button>
              ) : (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "14px 16px", textAlign: "left" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 8 }}>Heure d'arrêt automatique (Tunisie) :</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <input
                      type="time"
                      value={scheduleSessionTime}
                      onChange={e => setScheduleSessionTime(e.target.value)}
                      style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "7px 10px", fontSize: 14, fontWeight: 600 }}
                    />
                    <button
                      disabled={!scheduleSessionTime || schedulingSession}
                      onClick={async () => {
                        if (!scheduleSessionTime) return;
                        setSchedulingSession(true);
                        try {
                          await backendApi.startAll();
                          await backendApi.toggleRecording();
                          const r = await backendApi.scheduleStop(scheduleSessionTime);
                          setScheduledStop(r.scheduled_stop);
                          setScheduleSessionOpen(false);
                          setScheduleSessionTime("");
                          toast.success(`Session démarrée — arrêt automatique ${formatStopCountdown(r.scheduled_stop)}.`);
                        } catch {
                          toast.error("Impossible de démarrer la session planifiée.");
                        } finally { setSchedulingSession(false); }
                      }}
                      style={{ background: "#b45309", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: scheduleSessionTime && !schedulingSession ? "pointer" : "not-allowed", opacity: scheduleSessionTime && !schedulingSession ? 1 : 0.5 }}
                    >{schedulingSession ? "…" : "Démarrer"}</button>
                    <button
                      onClick={() => { setScheduleSessionOpen(false); setScheduleSessionTime(""); }}
                      style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 13, cursor: "pointer", color: "#64748b" }}
                    ><X size={14} /></button>
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>La session s'arrêtera automatiquement à l'heure choisie.</div>
                </div>
              )}
              <button
                onClick={() => navigate("/clients/gmcb/historique", { state: { openLatestSession: true } })}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 24px", borderRadius: 12, border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                <Eye size={16} /> Voir la derniere session
              </button>
              <button
                onClick={() => navigate("/clients/gmcb/admin")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 24px", borderRadius: 12, border: "1px solid #e2e8f0", background: "#f8fafc", color: "#0f172a", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                <LayoutDashboard size={16} /> Aller au tableau de bord admin
              </button>
              <button
                onClick={() => navigate(-1)}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "11px 24px", borderRadius: 12, border: "none", background: "transparent", color: "#64748b", fontSize: 14, cursor: "pointer" }}
              >
                <ArrowLeft size={15} /> Retour
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#0ea5e9,#0d9488)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <ScanLine size={26} color="white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.3px" }}>Session Live</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#777" }}>Session en cours — {dateLabel} • {stats.isRunning ? "En cours" : "Aucune session"}</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: "50%", overflow: "hidden", border: "2px solid #0d9488", flexShrink: 0 }}>
            <img src={logoOctoNorm} alt="OctoNorm" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>OctoNorm</div>
            <div style={{ fontSize: 11, color: "#22c55e", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} /> En ligne
            </div>
          </div>
        </div>
      </div>

      {/* Session controls row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        {/* Session badge */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: stats.isRunning ? "#f0fdf4" : "#f8fafc", border: `1px solid ${stats.isRunning ? "#bbf7d0" : "#e2e8f0"}`, borderRadius: 10, padding: "6px 14px", fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: stats.isRunning ? "#22c55e" : "#94a3b8", display: "inline-block", boxShadow: stats.isRunning ? "0 0 0 3px rgba(34,197,94,0.2)" : "none" }} />
          <span style={{ fontWeight: 600, color: stats.isRunning ? "#15803d" : "#475569" }}>{stats.isRunning ? "Session active" : "Aucune session active"}</span>
          {sessionStartTime && <span style={{ color: "#666" }}>• Démarrée à {sessionStartTime}</span>}
          <span style={{ color: "#666" }}>{dateLabel}</span>
        </div>
        {/* Stop button + auto-stop */}
        {stats.isRunning && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
            {/* Scheduled stop — shown as a proper button when active */}
            {scheduledStop ? (
              <button
                onClick={async () => {
                  try {
                    await backendApi.scheduleStop(null);
                    setScheduledStop(null);
                    toast.success("Arrêt programmé annulé.");
                  } catch { toast.error("Impossible d'annuler l'arrêt programmé."); }
                }}
                style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: "#92400e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                title="Cliquer pour annuler l'arrêt programmé"
              >
                <Clock size={15} />
                Arrêt à {formatTunisiaTime(scheduledStop)}
                <X size={13} />
              </button>
            ) : (
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => setStopPickerOpen(v => !v)}
                  style={{ border: "none", borderRadius: 12, padding: "10px 14px", background: stopPickerOpen ? "#78350f" : "#b45309", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                >
                  <Clock size={15} />
                  Programmer arrêt
                </button>
                {stopPickerOpen && (
                  <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 28px rgba(0,0,0,0.15)", padding: 16, zIndex: 50, minWidth: 230 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 10 }}>Heure d'arrêt automatique :</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="time"
                        value={stopTimeInput}
                        onChange={e => setStopTimeInput(e.target.value)}
                        style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "7px 10px", fontSize: 14, fontWeight: 600 }}
                      />
                      <button
                        disabled={!stopTimeInput}
                        onClick={async () => {
                          if (!stopTimeInput) return;
                          try {
                            const r = await backendApi.scheduleStop(stopTimeInput);
                            setScheduledStop(r.scheduled_stop);
                            setStopPickerOpen(false);
                            setStopTimeInput("");
                            toast.success(`Session s'arrêtera ${formatStopCountdown(r.scheduled_stop)}.`);
                          } catch { toast.error("Erreur lors de la programmation."); }
                        }}
                        style={{ background: "#b45309", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: stopTimeInput ? "pointer" : "not-allowed", opacity: stopTimeInput ? 1 : 0.5 }}
                      >OK</button>
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>Heure locale Tunisie (Africa/Tunis)</div>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={async () => {
                setStoppingSession(true);
                try {
                  await backendApi.toggleRecording();
                  await backendApi.stopAll();
                  try { await backendApi.scheduleStop(null); } catch {}
                  navigate("/clients/gmcb/admin");
                } catch {
                  toast.error("Impossible d'arrêter le live. Réessayez dans un instant.");
                } finally {
                  setStoppingSession(false);
                }
              }}
              disabled={stoppingSession}
              style={{
                border: "none",
                borderRadius: 12,
                padding: "10px 14px",
                background: "#dc2626",
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor: stoppingSession ? "wait" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: stoppingSession ? 0.6 : 1,
              }}
            >
              {stoppingSession ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Square size={15} />}
              Arrêter le live
            </button>
          </div>
        )}
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard icon={<CheckCircle2 size={24} color="#16a34a" />} iconBg="#dcfce7" value={stats.conformes.toLocaleString()} label="Paquets conformes" />
        <StatCard icon={<AlertCircle size={24} color="#dc2626" />} iconBg="#fee2e2" value={stats.totalNok} label="Anomalies détectées" />
        <StatCard icon={<Camera size={24} color="#2563eb" />} iconBg="#dbeafe" value={stats.conformityPct.toFixed(2) + "%"} label="Taux de conformité" />
        <StatCard icon={<Timer size={24} color="#9333ea" />} iconBg="#f3e8ff" value={stats.cadence + "/min"} label="Cadence analyse" />
      </div>

      {/* Conformité par heure */}
      {stats.isRunning && hourlyStats.length > 0 && (
        <div style={{ marginBottom: 24, padding: 18, borderRadius: 16, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <h3 style={{ margin: "0 0 16px 0", fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Conformité par heure</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            {hourlyStats.map((hourData: any, idx: number) => (
              <div key={idx} style={{ padding: 14, borderRadius: 12, background: "#fff", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: 8 }}>
                  {hourData.hour}h
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 10 }}>
                  {hourData.conformity_pct?.toFixed(1) ?? "—"}%
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "#64748b" }}>
                  <span>Cadence:</span>
                  <span style={{ fontWeight: 600, color: "#0f172a" }}>{hourData.cadence ?? "—"}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "#dc2626", marginTop: 4 }}>
                  <span>Anomalies:</span>
                  <span style={{ fontWeight: 700, color: "#dc2626" }}>{hourData.anomaly_count ?? "—"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Feed */}
      <div style={{ background: "#0f1923", borderRadius: 16, overflow: "hidden", marginBottom: 24, maxWidth: 720, margin: "0 auto 24px" }}>
        <div style={{ padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Video size={16} color="#ccc" />
            <span style={{ color: "#fff", fontSize: 14, fontWeight: 500 }}>Vue Live — Ligne Conditionnement</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 6, padding: "2px 8px" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
              <span style={{ color: "#ef4444", fontSize: 11, fontWeight: 700 }}>LIVE</span>
            </span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <select
              value={selectedPipeline}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedPipeline(next);
                backendApi.switchView(next).catch(() => {});
              }}
              style={{ background: "#1a2733", color: "#fff", border: "1px solid #334155", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
            >
              {(pipelineOptions.length > 0 ? pipelineOptions : [
                { id: "pipeline_barcode_date", label: "CAM-FACE-01 — Barcode + Date" },
                { id: "pipeline_anomaly", label: "CAM-HAUT-01 — Anomalie" },
              ]).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <Settings size={16} color={paramOpen ? "#0ea5e9" : "#aaa"} style={{ cursor: "pointer" }} onClick={() => setParamOpen((v) => !v)} />
            <Maximize2 size={16} color="#aaa" style={{ cursor: "pointer" }} />
          </div>
        </div>
        {/* Exit-line param panel */}
        {paramOpen && (
          <div style={{ background: "#1a2733", padding: "12px 18px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", borderTop: "1px solid #334155" }}>
            {/* Position slider */}
            <label style={{ color: "#aaa", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <SlidersHorizontal size={14} /> Position
              <input
                type="range" min={5} max={95} value={elPct}
                onChange={(e) => setElPct(Number(e.target.value))}
                onMouseUp={() => backendApi.exitLinePosition(elPct).catch(() => {})}
                onTouchEnd={() => backendApi.exitLinePosition(elPct).catch(() => {})}
                style={{ width: 100, accentColor: "#0ea5e9" }}
              />
              <span style={{ color: "#fff", fontSize: 12, fontWeight: 600, minWidth: 32, textAlign: "right" }}>{elPct}%</span>
            </label>
            {/* Orientation toggle */}
            <button
              onClick={() => { backendApi.exitLineOrientation().then((r: any) => setElVertical(r.vertical)).catch(() => setElVertical((v) => !v)); }}
              style={{ background: elVertical ? "#0ea5e9" : "#334155", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
            >
              <RotateCw size={12} /> {elVertical ? "Vertical" : "Horizontal"}
            </button>
            {/* Invert toggle */}
            <button
              onClick={() => { backendApi.exitLineInvert().then((r: any) => setElInverted(r.inverted)).catch(() => setElInverted((v) => !v)); }}
              style={{ background: elInverted ? "#f59e0b" : "#334155", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
            >
              <ArrowLeftRight size={12} /> {elInverted ? "Inversé" : "Normal"}
            </button>
          </div>
        )}
        <div style={{ position: "relative", aspectRatio: "16/9", overflow: "hidden" }}>
          <img
            ref={mjpegRef}
            src={backendApi.videoFeedUrl()}
            alt="Live feed"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
          />
        </div>
        <div style={{ padding: "10px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#aaa", fontSize: 12 }}>{dateLabel}</span>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ color: "#aaa", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#22c55e", display: "inline-block" }} />Conforme</span>
            <span style={{ color: "#aaa", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "#ef4444", display: "inline-block" }} />Anomalie</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ background: "#22c55e", color: "#fff", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}><CheckCircle2 size={12} />{stats.conformes.toLocaleString()}</span>
            <span style={{ background: "#ef4444", color: "#fff", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}><AlertCircle size={12} />{stats.totalNok}</span>
          </div>
        </div>
      </div>

      {/* Live packet stream (FIFO) */}
      {stats.isRunning && stats.fifoQueue.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: "14px 20px", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 0 3px rgba(34,197,94,0.3)", animation: "pulse 1.5s infinite" }} />
            <span style={{ fontWeight: 700, fontSize: 13, color: "#333" }}>Flux en direct</span>
            <span style={{ fontSize: 12, color: "#999" }}>{stats.totalPackets} paquets analysés</span>
          </div>
          <div style={{ display: "flex", gap: 5, overflowX: "auto", paddingBottom: 4 }}>
            {[...stats.fifoQueue].reverse().map((decision, i) => {
              const isOk = decision === "OK";
              const pktNum = stats.totalPackets - i;
              return (
                <div key={i} style={{
                  flexShrink: 0,
                  padding: "4px 10px",
                  borderRadius: 6,
                  background: isOk ? "#dcfce7" : "#fee2e2",
                  color: isOk ? "#166534" : "#991b1b",
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  border: `1px solid ${isOk ? "#bbf7d0" : "#fecaca"}`,
                }}>
                  #{pktNum > 0 ? pktNum : "?"} {decision}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Anomalies list */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={18} color="#dc2626" />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Dernières anomalies</span>
            <span style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{anomalyItems.length} aujourd'hui</span>
          </div>
          <Pager page={anomPage} total={totalPages} onChange={setAnomalPage} />
        </div>
        {pageAnom.map((a, i) => (
          <div key={i} onClick={() => setModalAnomaly(a)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderRadius: 10, background: "#fef2f2", marginBottom: 8, cursor: "pointer", transition: "background .15s" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#fee2e2")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#fef2f2")}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertCircle size={16} color="#ef4444" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#dc2626" }}>{a.type}</div>
                <div style={{ fontSize: 11, color: "#999" }}>{a.time} • {a.lot}</div>
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Résultats du contrôle</span>
            <button style={{ background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, color: "#555" }}><Filter size={12} />Filtrer</button>
          </div>
          {[
            { label: "Paquets conformes", count: stats.conformes, color: "#22c55e" },
            { label: "Paquet sans code à barre", count: stats.nokBarcode, color: "#84CC16" },
            { label: "Date non visible", count: stats.nokDate, color: "#06B6D4" },
            { label: "Anomalie détectée", count: stats.nokAnomaly, color: "#16A34A" },
          ].map((r, i, arr) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: i < arr.length - 1 ? "1px solid #f5f5f5" : "none" }}>
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

      {/* Galerie */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8eaed", padding: 20, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Camera size={18} color="#0ea5e9" />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Galerie Anomalies</span>
            <span style={{ background: "#f0f4ff", color: "#2563eb", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{filtered.length} captures</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {filtered.length > 8 && (
              <button onClick={() => setGalleryExpanded(!galleryExpanded)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: "1px solid #e0e0e0", background: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 500, color: "#333" }}>
                <Eye size={14} />{galleryExpanded ? "Réduire" : "Voir tout (" + filtered.length + ")"}
              </button>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {FILTER_TABS.map((t, i) => (
            <button key={i} onClick={() => setActiveFilter(t)} style={{ padding: "5px 14px", borderRadius: 20, border: "1px solid #e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500, background: activeFilter === t ? "#111" : "#fff", color: activeFilter === t ? "#fff" : "#444", transition: "all .15s" }}>{t}</button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          {galleryItems.map((a) => (
            <div key={a.id} onClick={() => setModalAnomaly(a)}
              style={{ borderRadius: 10, overflow: "hidden", cursor: "pointer", position: "relative", height: 160, transition: "transform .15s", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
              onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.02)")}
              onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}>
              <img
                src={a.img}
                alt={a.type}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
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
                <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 10 }}>{a.time} • {a.lot}</div>
              </div>
            </div>
          ))}
        </div>
        {!galleryExpanded && filtered.length > 8 && (
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button onClick={() => setGalleryExpanded(true)} style={{ background: "none", border: "1px solid #e0e0e0", borderRadius: 8, padding: "8px 20px", fontSize: 13, cursor: "pointer", color: "#555", fontWeight: 500 }}>
              + {filtered.length - 8} autres captures — Voir tout
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      {modalAnomaly && <AnomalyModal anomaly={modalAnomaly} onClose={() => setModalAnomaly(null)} />}
      {exportModal && <ExportModal data={exportModal} onClose={() => setExportModal(null)} />}
    </div>
  );
};

export default GMCBQualite;
