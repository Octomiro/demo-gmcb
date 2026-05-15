import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ScanLine, CheckCircle2, AlertCircle, Camera, Timer, Video,
  RefreshCw, Settings, Filter, ChevronRight, Eye, X,
  SlidersHorizontal, RotateCw, ArrowLeftRight, PlayCircle, LayoutDashboard, ArrowLeft,
  Loader2, Square, Clock, CalendarDays,
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
import { backendApi, type CameraPreviewPipeline, type CameraPreviewResponse } from "@/core/backendApi";
import { toast } from "sonner";

type QualityCheckKey = "barcode" | "date" | "anomaly";
type QualityChecks = Record<QualityCheckKey, boolean>;

const QUALITY_MODE_OPTIONS = [
  {
    key: "barcode" as const,
    label: "Code-barres",
    desc: "Paquets sans code-barres comptés NOK",
    Icon: ScanLine,
    softBg: "#eff6ff",
    iconBg: "#dbeafe",
    text: "#0369a1",
    border: "#7dd3fc",
    shadow: "rgba(14,165,233,0.18)",
  },
  {
    key: "date" as const,
    label: "Date",
    desc: "Paquets sans date lisible comptés NOK",
    Icon: CalendarDays,
    softBg: "#ecfdf5",
    iconBg: "#d1fae5",
    text: "#047857",
    border: "#6ee7b7",
    shadow: "rgba(16,185,129,0.18)",
  },
  {
    key: "anomaly" as const,
    label: "Anomalie",
    desc: "Analyse visuelle des défauts de surface",
    Icon: AlertCircle,
    softBg: "#fff7ed",
    iconBg: "#ffedd5",
    text: "#c2410c",
    border: "#fdba74",
    shadow: "rgba(249,115,22,0.18)",
  },
] as const;

const GMCBQualite = () => {
  const navigate = useNavigate();
  const stats = useLiveStats();
  const [startingSession, setStartingSession] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<string | null>(null);
  const sessionStartTimeRef = useRef<string | null>(null);
  const dbWasDown = useRef(false);
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
  const [startMode, setStartMode] = useState<null | "direct" | "scheduled">(null);
  const [stopTimeForStart, setStopTimeForStart] = useState("");
  const [schedulingSession, setSchedulingSession] = useState(false);
  const [streamRefreshToken, setStreamRefreshToken] = useState(0);
  const wasRunningRef = useRef(false);
  const [qualiteChecks, setQualiteChecks] = useState<QualityChecks>({ barcode: true, date: true, anomaly: true });
  const [liveChecksOverride, setLiveChecksOverride] = useState<QualityChecks | null>(null);
  const [sessionChecksModalOpen, setSessionChecksModalOpen] = useState(false);
  const [sessionChecksDraft, setSessionChecksDraft] = useState<QualityChecks>({ barcode: true, date: true, anomaly: true });
  const [savingSessionChecks, setSavingSessionChecks] = useState(false);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const [cameraPreviewLoading, setCameraPreviewLoading] = useState(false);
  const [cameraSwapLoading, setCameraSwapLoading] = useState(false);
  const [cameraPreview, setCameraPreview] = useState<CameraPreviewResponse | null>(null);

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

  useEffect(() => {
    if (!stats.isRunning) {
      setLiveChecksOverride(null);
      setSessionChecksModalOpen(false);
      setSavingSessionChecks(false);
      return;
    }
    if (
      liveChecksOverride &&
      QUALITY_MODE_OPTIONS.every(({ key }) => liveChecksOverride[key] === stats.activeChecks[key])
    ) {
      setLiveChecksOverride(null);
    }
  }, [
    liveChecksOverride,
    stats.activeChecks.anomaly,
    stats.activeChecks.barcode,
    stats.activeChecks.date,
    stats.isRunning,
  ]);

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

  // Fetch crossings on mount, whenever sessionIds/totalPackets change, and on a short poll interval
  const fetchCrossingsRef = useRef<() => void>(() => {});
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
    fetchCrossingsRef.current = fetchCrossings;
    fetchCrossings();
    return () => { cancelled = true; };
  }, [stats.sessionId0, stats.sessionId1, stats.totalPackets]);

  // Poll crossings every 3s independently so new anomalies appear without waiting for totalPackets change
  useEffect(() => {
    if (!stats.isRunning) return;
    const id = setInterval(() => fetchCrossingsRef.current(), 3000);
    return () => clearInterval(id);
  }, [stats.isRunning]);

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
  const hasSelectedQualityCheck = QUALITY_MODE_OPTIONS.some(({ key }) => qualiteChecks[key]);
  const liveChecks = liveChecksOverride ?? stats.activeChecks;
  const hasSelectedSessionChecks = QUALITY_MODE_OPTIONS.some(({ key }) => sessionChecksDraft[key]);
  const visibleLiveModes = QUALITY_MODE_OPTIONS.filter(({ key }) => liveChecks[key]);
  const sessionStartOptions = [
    {
      key: "barcode" as const,
      label: "Contrôle code-barres",
      desc: "Les paquets sans code-barres sont comptés NOK",
      camOk: stats.p0?.camera_available !== false,
    },
    {
      key: "date" as const,
      label: "Contrôle date",
      desc: "Les paquets sans date lisible sont comptés NOK",
      camOk: stats.p0?.camera_available !== false,
    },
    {
      key: "anomaly" as const,
      label: "Détection anomalie",
      desc: stats.p1?.camera_available === false ? "Caméra non détectée — mode indisponible" : "Analyse visuelle des défauts de surface",
      camOk: stats.p1?.camera_available !== false,
    },
  ];

  const selectedPipelineIdsForStart = () => {
    const ids: string[] = [];
    if (qualiteChecks.barcode || qualiteChecks.date) ids.push("pipeline_barcode_date");
    if (qualiteChecks.anomaly) ids.push("pipeline_anomaly");
    return ids;
  };

  const isStartPipelineActive = (pipelineId: string) => {
    if (pipelineId === "pipeline_barcode_date") return qualiteChecks.barcode || qualiteChecks.date;
    if (pipelineId === "pipeline_anomaly") return qualiteChecks.anomaly;
    return true;
  };

  const getPreviewModeLabel = (pipeline: CameraPreviewPipeline) => {
    if (pipeline.id === "pipeline_barcode_date") {
      if (qualiteChecks.barcode && qualiteChecks.date) return "Code-barres + Date";
      if (qualiteChecks.barcode) return "Code-barres";
      if (qualiteChecks.date) return "Date";
      return "Code-barres + Date";
    }
    if (pipeline.id === "pipeline_anomaly") return "Anomalie";
    return pipeline.checkpoint_label || pipeline.label;
  };

  const getPreviewErrorLabel = (error?: string | null) => {
    if (error === "camera_unavailable") return "Caméra inaccessible";
    if (error === "no_frame") return "Aucune image reçue";
    if (error === "stream_warming_up") return "Flux en préparation";
    if (error === "encode_failed") return "Image non encodable";
    return "Snapshot indisponible";
  };

  const activePreviewHasMissingCamera = () => {
    if (!cameraPreview) return true;
    return cameraPreview.pipelines.some((pipeline) => isStartPipelineActive(pipeline.id) && !pipeline.available);
  };

  const openCameraPreviewStep = async () => {
    if (!hasSelectedQualityCheck) {
      toast.error("Activez au moins un contrôle avant de démarrer.");
      return;
    }
    setCameraPreviewLoading(true);
    try {
      const preview = await backendApi.getCameraPreview();
      setCameraPreview(preview);
      setCameraPreviewOpen(true);
    } catch {
      toast.error("Impossible de récupérer les snapshots caméra. Vérifiez la connexion au système.");
    } finally {
      setCameraPreviewLoading(false);
    }
  };

  const swapPreviewCameras = async () => {
    if (!cameraPreview) return;
    const barcodePipeline = cameraPreview.pipelines.find((pipeline) => pipeline.id === "pipeline_barcode_date");
    const anomalyPipeline = cameraPreview.pipelines.find((pipeline) => pipeline.id === "pipeline_anomaly");
    if (!barcodePipeline || !anomalyPipeline) {
      toast.error("Configuration caméra incomplète — impossible d'inverser.");
      return;
    }

    setCameraSwapLoading(true);
    try {
      await backendApi.setCameraAssignments({
        [barcodePipeline.id]: anomalyPipeline.camera_source,
        [anomalyPipeline.id]: barcodePipeline.camera_source,
      }, { restart: false });
      const refreshedPreview = await backendApi.getCameraPreview();
      setCameraPreview(refreshedPreview);
      toast.success("Caméras inversées. Vérifiez à nouveau les images.");
    } catch {
      toast.error("Impossible d'inverser les caméras. Réessayez avant de démarrer.");
    } finally {
      setCameraSwapLoading(false);
    }
  };

  const startSessionAfterPreview = async () => {
    if (!hasSelectedQualityCheck) {
      toast.error("Activez au moins un contrôle avant de démarrer.");
      return;
    }

    const scheduled = startMode === "scheduled";
    if (scheduled && !stopTimeForStart) {
      toast.error("Choisissez une heure d'arrêt automatique.");
      return;
    }

    setStartingSession(true);
    if (scheduled) setSchedulingSession(true);
    try {
      await backendApi.sessionStart(qualiteChecks);
      if (scheduled && stopTimeForStart) {
        const r = await backendApi.scheduleStop(stopTimeForStart);
        setScheduledStop(r.scheduled_stop);
        toast.success(`Session démarrée — arrêt automatique ${formatStopCountdown(r.scheduled_stop)}.`);
      }
      setCameraPreviewOpen(false);
      setCameraPreview(null);
      setStartMode(null);
      setStopTimeForStart("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("camera_unavailable")) {
        toast.error("Caméra inaccessible — vérifiez qu'elle est bien branchée et réessayez.", { duration: 8000 });
      } else {
        toast.error("Impossible de démarrer la session. Vérifiez que le système est en ligne.");
      }
    } finally {
      setStartingSession(false);
      setSchedulingSession(false);
    }
  };

  const openSessionChecksModal = () => {
    setStopPickerOpen(false);
    setSessionChecksDraft({ ...liveChecks });
    setSessionChecksModalOpen(true);
  };

  const closeSessionChecksModal = () => {
    if (savingSessionChecks) return;
    setSessionChecksModalOpen(false);
  };

  const applySessionChecks = async () => {
    if (!hasSelectedSessionChecks) {
      toast.error("Au moins un contrôle doit rester actif.");
      return;
    }
    setSavingSessionChecks(true);
    try {
      await backendApi.updateSessionChecks(sessionChecksDraft);
      setLiveChecksOverride({ ...sessionChecksDraft });
      setSessionChecksModalOpen(false);
      toast.success("Modes actifs mis à jour.");
    } catch {
      toast.error("Impossible de modifier les modes actifs.");
    } finally {
      setSavingSessionChecks(false);
    }
  };

  // MJPEG stream: use ref so we can kill the connection on unmount / page switch
  const mjpegRef = useRef<HTMLImageElement | null>(null);
  const refreshLiveFeed = (showToast = true) => {
    if (mjpegRef.current) {
      mjpegRef.current.style.visibility = "hidden";
      mjpegRef.current.src = "";
    }
    setStreamRefreshToken((token) => token + 1);
    if (showToast) toast.success("Flux live actualise.");
  };

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
          <div style={{ background: "#fff", borderRadius: 24, width: 440, maxWidth: "94vw", boxShadow: "0 36px 120px rgba(0,0,0,0.55)", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* ── Step 1: choose action ── */}
            {startMode === null && (
              <>
                <div style={{ padding: "28px 28px 20px", textAlign: "center", borderBottom: "1px solid #f1f5f9" }}>
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                    <Video size={28} color="#94a3b8" />
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", marginBottom: 6 }}>Aucun live en cours</div>
                  <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>Aucune session de contrôle n'est active en ce moment.</div>
                </div>
                <div style={{ padding: "20px 28px 28px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <button
                    disabled={startingSession}
                    onClick={() => {
                      setQualiteChecks({ barcode: true, date: true, anomaly: stats.p1?.camera_available !== false });
                      setStartMode("direct");
                    }}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 20px", borderRadius: 12, border: "none", background: "linear-gradient(135deg,#0ea5e9,#0d9488)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
                  >
                    <PlayCircle size={18} /> Démarrer une session
                  </button>
                  <button
                    disabled={startingSession || schedulingSession}
                    onClick={() => {
                      setQualiteChecks({ barcode: true, date: true, anomaly: stats.p1?.camera_available !== false });
                      setStartMode("scheduled");
                    }}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 20px", borderRadius: 12, border: "none", background: "#b45309", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
                  >
                    <Clock size={16} /> Démarrer et planifier la fin
                  </button>
                  <button
                    onClick={() => navigate("/clients/gmcb/historique", { state: { openLatestSession: true } })}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", borderRadius: 12, border: "1px solid #e2e8f0", background: "#fff", color: "#0f172a", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                  >
                    <Eye size={16} /> Voir la dernière session
                  </button>
                  <button
                    onClick={() => navigate("/clients/gmcb/admin")}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", borderRadius: 12, border: "1px solid #e2e8f0", background: "#f8fafc", color: "#0f172a", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                  >
                    <LayoutDashboard size={16} /> Aller au tableau de bord admin
                  </button>
                  <button
                    onClick={() => navigate(-1)}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", background: "transparent", color: "#94a3b8", fontSize: 14, cursor: "pointer" }}
                  >
                    <ArrowLeft size={15} /> Retour
                  </button>
                </div>
              </>
            )}

            {/* ── Step 2: configure checks (+ stop time) then confirm ── */}
            {startMode === "direct" && (
              <>
                <div style={{ padding: 28, maxWidth: 420, width: "100%", margin: "0 auto" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}>Démarrer une session</div>
                  <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Choisissez les contrôles actifs pour cette session :</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
                    {sessionStartOptions.map(({ key, label, desc, camOk }) => {
                      const active = qualiteChecks[key] && camOk;
                      return (
                        <label key={key} onClick={() => { if (camOk) setQualiteChecks((prev) => ({ ...prev, [key]: !prev[key] })); }} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px", borderRadius: 10, border: `1px solid ${!camOk ? "#fecaca" : active ? "#99f6e4" : "#e2e8f0"}`, background: !camOk ? "#fef2f2" : active ? "#f0fdf9" : "#f8fafc", cursor: camOk ? "pointer" : "not-allowed", transition: "all 0.15s", opacity: camOk ? 1 : 0.65 }}>
                          <div style={{ marginTop: 2, width: 18, height: 18, borderRadius: 4, border: `2px solid ${!camOk ? "#fca5a5" : active ? "#0f766e" : "#cbd5e1"}`, background: active ? "#0f766e" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}>
                            {active && <svg width="10" height="8" viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: !camOk ? "#dc2626" : active ? "#0f766e" : "#64748b" }}>{label}{!camOk && " — indisponible"}</div>
                            <div style={{ fontSize: 12, color: !camOk ? "#f87171" : "#94a3b8", marginTop: 2 }}>{desc}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <button onClick={() => setStartMode(null)} style={{ border: "1px solid #d0d5dd", borderRadius: 10, padding: "9px 16px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      Annuler
                    </button>
                    <button
                      disabled={startingSession || cameraPreviewLoading || !hasSelectedQualityCheck}
                      onClick={openCameraPreviewStep}
                      style={{ border: "none", borderRadius: 10, padding: "9px 16px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: (startingSession || cameraPreviewLoading) ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: (startingSession || cameraPreviewLoading || !hasSelectedQualityCheck) ? 0.5 : 1 }}
                    >
                      {startingSession || cameraPreviewLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <PlayCircle size={15} />} Confirmer
                    </button>
                  </div>
                </div>
              </>
            )}
            {startMode === "scheduled" && (
              <>
                <div style={{ padding: 28, maxWidth: 420, width: "100%", margin: "0 auto" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}>Démarrer et planifier la fin</div>
                  <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Choisissez les contrôles actifs et l'heure d'arrêt automatique pour cette session :</div>
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "12px 14px", marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 8 }}>Heure d'arrêt automatique :</div>
                    <input
                      type="time"
                      value={stopTimeForStart}
                      onChange={e => setStopTimeForStart(e.target.value)}
                      style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, fontWeight: 600, boxSizing: "border-box" }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
                    {sessionStartOptions.map(({ key, label, desc, camOk }) => {
                      const active = qualiteChecks[key] && camOk;
                      return (
                        <label key={key} onClick={() => { if (camOk) setQualiteChecks((prev) => ({ ...prev, [key]: !prev[key] })); }} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px", borderRadius: 10, border: `1px solid ${!camOk ? "#fecaca" : active ? "#99f6e4" : "#e2e8f0"}`, background: !camOk ? "#fef2f2" : active ? "#f0fdf9" : "#f8fafc", cursor: camOk ? "pointer" : "not-allowed", transition: "all 0.15s", opacity: camOk ? 1 : 0.65 }}>
                          <div style={{ marginTop: 2, width: 18, height: 18, borderRadius: 4, border: `2px solid ${!camOk ? "#fca5a5" : active ? "#0f766e" : "#cbd5e1"}`, background: active ? "#0f766e" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}>
                            {active && <svg width="10" height="8" viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: !camOk ? "#dc2626" : active ? "#0f766e" : "#64748b" }}>{label}{!camOk && " — indisponible"}</div>
                            <div style={{ fontSize: 12, color: !camOk ? "#f87171" : "#94a3b8", marginTop: 2 }}>{desc}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <button onClick={() => { setStartMode(null); setStopTimeForStart(""); }} style={{ border: "1px solid #d0d5dd", borderRadius: 10, padding: "9px 16px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      Annuler
                    </button>
                    <button
                      disabled={startingSession || schedulingSession || cameraPreviewLoading || !hasSelectedQualityCheck || !stopTimeForStart}
                      onClick={openCameraPreviewStep}
                      style={{ border: "none", borderRadius: 10, padding: "9px 16px", background: "#b45309", color: "#fff", fontSize: 13, fontWeight: 700, cursor: (schedulingSession || cameraPreviewLoading) ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: (schedulingSession || cameraPreviewLoading || !hasSelectedQualityCheck || !stopTimeForStart) ? 0.5 : 1 }}
                    >
                      {schedulingSession || cameraPreviewLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <PlayCircle size={15} />} Confirmer et lancer
                    </button>
                  </div>
                </div>
              </>
            )}

          </div>
        </div>
      )}
      {cameraPreviewOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.88)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", zIndex: 230, display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
          <div style={{ background: "#fff", borderRadius: 24, padding: 24, width: "min(920px, 94vw)", maxHeight: "92vh", overflow: "auto", boxShadow: "0 36px 120px rgba(0,0,0,0.55)", border: "1px solid #e5e7eb" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}>Confirmation des caméras</div>
                <div style={{ fontSize: 13, color: "#64748b" }}>Vérifiez que chaque caméra correspond au mode affiché avant de lancer la session.</div>
              </div>
              <button
                type="button"
                onClick={() => { if (!startingSession && !cameraSwapLoading) { setCameraPreviewOpen(false); setCameraPreview(null); } }}
                disabled={startingSession || cameraSwapLoading}
                style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", cursor: startingSession || cameraSwapLoading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexShrink: 0, opacity: startingSession || cameraSwapLoading ? 0.55 : 1 }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginBottom: 18 }}>
              {(cameraPreview?.pipelines ?? []).map((pipeline) => {
                const active = isStartPipelineActive(pipeline.id);
                return (
                  <div key={pipeline.id} style={{ border: `1px solid ${!pipeline.available && active ? "#fecaca" : active ? "#99f6e4" : "#e2e8f0"}`, borderRadius: 12, padding: 12, background: active ? "#fff" : "#f8fafc", opacity: active ? 1 : 0.72 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: active ? "#0f172a" : "#64748b" }}>{getPreviewModeLabel(pipeline)}</div>
                      <span style={{ flexShrink: 0, borderRadius: 999, padding: "3px 8px", background: active ? "#d1fae5" : "#e2e8f0", color: active ? "#047857" : "#64748b", fontSize: 11, fontWeight: 800 }}>
                        {active ? "Actif" : "Désactivé"}
                      </span>
                    </div>
                    <div style={{ aspectRatio: "4 / 3", borderRadius: 10, overflow: "hidden", background: "#0f172a", border: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {pipeline.snapshot ? (
                        <img src={pipeline.snapshot} alt={`Preview ${getPreviewModeLabel(pipeline)}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      ) : (
                        <div style={{ color: "#cbd5e1", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700 }}>
                          <Camera size={26} />
                          <span>{getPreviewErrorLabel(pipeline.error)}</span>
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 }}>
                      <span style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>Caméra {String(pipeline.camera_source)}</span>
                      <span style={{ fontSize: 12, color: pipeline.available ? "#047857" : "#dc2626", fontWeight: 800 }}>
                        {pipeline.available ? "Image reçue" : getPreviewErrorLabel(pipeline.error)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {activePreviewHasMissingCamera() && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, padding: "10px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13, fontWeight: 700 }}>
                <AlertCircle size={15} /> Une caméra active n'a pas fourni d'image. Corrigez la connexion ou utilisez Swap si les caméras sont inversées.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => { setCameraPreviewOpen(false); setCameraPreview(null); }}
                disabled={startingSession || schedulingSession || cameraSwapLoading}
                style={{ border: "1px solid #d0d5dd", borderRadius: 10, padding: "9px 16px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: startingSession || schedulingSession || cameraSwapLoading ? "not-allowed" : "pointer", opacity: startingSession || schedulingSession || cameraSwapLoading ? 0.55 : 1 }}
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={swapPreviewCameras}
                disabled={startingSession || schedulingSession || cameraSwapLoading}
                style={{ border: "1px solid #c7d2fe", borderRadius: 10, padding: "9px 16px", background: "#eef2ff", color: "#4338ca", fontSize: 13, fontWeight: 800, cursor: cameraSwapLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: startingSession || schedulingSession || cameraSwapLoading ? 0.6 : 1 }}
              >
                {cameraSwapLoading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <ArrowLeftRight size={15} />} Swap
              </button>
              <button
                type="button"
                disabled={startingSession || schedulingSession || cameraSwapLoading}
                onClick={startSessionAfterPreview}
                style={{ border: "none", borderRadius: 10, padding: "9px 16px", background: "#0f766e", color: "#fff", fontSize: 13, fontWeight: 800, cursor: startingSession || schedulingSession ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 8, opacity: (startingSession || schedulingSession || cameraSwapLoading) ? 0.5 : 1 }}
              >
                {startingSession || schedulingSession ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <PlayCircle size={15} />} Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
      {stats.isRunning && sessionChecksModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeSessionChecksModal(); }}
          style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.9)", backdropFilter: "blur(16px) saturate(0.7)", WebkitBackdropFilter: "blur(16px) saturate(0.7)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <div style={{ background: "#fff", borderRadius: 24, width: 440, maxWidth: "94vw", boxShadow: "0 36px 120px rgba(0,0,0,0.55)", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "20px 28px 16px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                onClick={closeSessionChecksModal}
                disabled={savingSessionChecks}
                style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", cursor: savingSessionChecks ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexShrink: 0 }}
              >
                <ArrowLeft size={16} />
              </button>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>Contrôles qualité</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  Choisissez les vérifications actives pour cette session.
                </div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#e2e8f0" }} />
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#0d9488" }} />
              </div>
            </div>
            <div style={{ padding: "20px 28px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>Choisissez les contrôles actifs pour cette session :</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {sessionStartOptions.map(({ key, label, desc, camOk }) => {
                    const active = sessionChecksDraft[key] && camOk;
                    return (
                      <label
                        key={key}
                        onClick={() => { if (camOk) setSessionChecksDraft((prev) => ({ ...prev, [key]: !prev[key] })); }}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px", borderRadius: 10,
                          border: `1px solid ${!camOk ? "#fecaca" : active ? "#99f6e4" : "#e2e8f0"}`,
                          background: !camOk ? "#fef2f2" : active ? "#f0fdf9" : "#f8fafc",
                          cursor: camOk ? "pointer" : "not-allowed", transition: "all 0.15s", opacity: camOk ? 1 : 0.65,
                        }}
                      >
                        <div style={{ marginTop: 2, width: 18, height: 18, borderRadius: 4, border: `2px solid ${!camOk ? "#fca5a5" : active ? "#0f766e" : "#cbd5e1"}`, background: active ? "#0f766e" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}>
                          {active && <svg width="10" height="8" viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </div>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: !camOk ? "#dc2626" : active ? "#0f766e" : "#64748b" }}>{label}{!camOk && " — indisponible"}</div>
                          <div style={{ fontSize: 12, color: !camOk ? "#f87171" : "#94a3b8", marginTop: 2 }}>{desc}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={applySessionChecks}
                disabled={savingSessionChecks || !hasSelectedSessionChecks}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                  padding: "13px 20px", borderRadius: 12, border: "none",
                  background: "linear-gradient(135deg,#0ea5e9,#0d9488)",
                  color: "#fff", fontSize: 15, fontWeight: 700,
                  cursor: savingSessionChecks ? "wait" : "pointer",
                  opacity: (savingSessionChecks || !hasSelectedSessionChecks) ? 0.5 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                {savingSessionChecks
                  ? <><Loader2 size={17} style={{ animation: "spin 1s linear infinite" }} /> Enregistrement…</>
                  : <><PlayCircle size={17} /> Confirmer</>}
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
        {/* Session badge + active modes */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flex: "1 1 720px" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: stats.isRunning ? "#f0fdf4" : "#f8fafc", border: `1px solid ${stats.isRunning ? "#bbf7d0" : "#e2e8f0"}`, borderRadius: 10, padding: "6px 14px", fontSize: 13 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: stats.isRunning ? "#22c55e" : "#94a3b8", display: "inline-block", boxShadow: stats.isRunning ? "0 0 0 3px rgba(34,197,94,0.2)" : "none" }} />
            <span style={{ fontWeight: 600, color: stats.isRunning ? "#15803d" : "#475569" }}>{stats.isRunning ? "Session active" : "Aucune session active"}</span>
            {sessionStartTime && <span style={{ color: "#666" }}>• Démarrée à {sessionStartTime}</span>}
            <span style={{ color: "#666" }}>{dateLabel}</span>
          </div>
          {stats.isRunning && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {visibleLiveModes.map(({ key, label, iconBg, text }) => (
                  <span
                    key={key}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, padding: "6px 11px", fontSize: 12, fontWeight: 700, background: iconBg, color: text, border: "1px solid rgba(148,163,184,0.18)" }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: text, display: "inline-block" }} />
                    {label}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={openSessionChecksModal}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, border: "1px solid #dbe3ec", background: "#fff", color: "#334155", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                <Settings size={15} />
                Gérer les modes
              </button>
            </div>
          )}
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
              onChange={async (e) => {
                const next = e.target.value;
                const previous = selectedPipeline;
                setSelectedPipeline(next);
                try {
                  await backendApi.switchView(next);
                  refreshLiveFeed(false);
                } catch {
                  setSelectedPipeline(previous);
                  toast.error("Impossible de changer la vue live.");
                }
              }}
              style={{ background: "#1a2733", color: "#fff", border: "1px solid #334155", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
            >
              {(pipelineOptions.length > 0 ? pipelineOptions : [
                { id: "pipeline_barcode_date", label: "CAM-FACE-01 — Barcode & Date" },
                { id: "pipeline_anomaly", label: "CAM-HAUT-01 — Anomalie" },
              ]).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <Settings size={16} color={paramOpen ? "#0ea5e9" : "#aaa"} style={{ cursor: "pointer" }} onClick={() => setParamOpen((v) => !v)} />
            <button
              type="button"
              onClick={() => refreshLiveFeed()}
              title="Actualiser le live"
              aria-label="Actualiser le live"
              style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid #334155", background: "#1a2733", color: "#aaa", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}
            >
              <RefreshCw size={14} />
            </button>
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
        <div style={{ position: "relative", aspectRatio: "16/9", overflow: "hidden", background: "#000" }}>
          {(() => {
            const activePipeline = selectedPipeline === "pipeline_anomaly" ? stats.p1 : stats.p0;
            const isNotActivated = !stats.loading && (
              !(activePipeline?.is_running ?? false) ||
              (stats.isRunning && !(activePipeline?.stats_active ?? false))
            );
            const label = selectedPipeline === "pipeline_anomaly"
              ? "Détection d'anomalies (CAM-HAUT-01)"
              : "Contrôle code à barre & date (CAM-FACE-01)";
            if (isNotActivated) {
              return (
                <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, boxSizing: "border-box" }}>
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Video size={26} color="rgba(255,255,255,0.4)" />
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "rgba(255,255,255,0.85)", fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Mode non activé</div>
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, lineHeight: 1.5 }}>
                      Activez ce mode depuis le tableau de bord admin.
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <img
                key={streamRefreshToken}
                ref={mjpegRef}
                src={backendApi.videoFeedUrl(streamRefreshToken)}
                alt="Live feed"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                onLoad={(e) => { (e.target as HTMLImageElement).style.visibility = "visible"; }}
                onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
              />
            );
          })()}
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
