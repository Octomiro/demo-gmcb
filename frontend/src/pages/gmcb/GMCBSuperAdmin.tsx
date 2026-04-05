import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGMCBAuth } from "@/contexts/GMCBAuthContext";
import { backendApi } from "@/core/backendApi";
import { toast } from "sonner";
import {
  X, MessageSquare, AlertTriangle, Lightbulb, MessageCircle,
  ImageIcon, Send, RefreshCw, Filter,
} from "lucide-react";

interface FeedbackRow {
  id: number;
  title: string;
  comment: string;
  type: string;
  scope: string;
  urgency: string;
  session_id: string | null;
  user_email: string | null;
  screenshot_path: string | null;
  admin_response: string | null;
  responded_at: string | null;
  created_at: string;
}

const typeConfig: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ReactNode }> = {
  bug:     { label: "Bug",          color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: <AlertTriangle  size={13} /> },
  feature: { label: "Amélioration", color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe", icon: <Lightbulb      size={13} /> },
  comment: { label: "Commentaire",  color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe", icon: <MessageCircle  size={13} /> },
};

const urgencyConfig: Record<string, { label: string; color: string; bg: string; border: string; dot: string }> = {
  low:    { label: "Faible",  color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", dot: "#16a34a" },
  medium: { label: "Moyenne", color: "#d97706", bg: "#fffbeb", border: "#fde68a", dot: "#d97706" },
  high:   { label: "Élevée",  color: "#dc2626", bg: "#fef2f2", border: "#fecaca", dot: "#dc2626" },
};

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const GMCBSuperAdmin = () => {
  const { user } = useGMCBAuth();
  const navigate = useNavigate();
  const [feedbacks, setFeedbacks] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<FeedbackRow | null>(null);
  const [filterType, setFilterType] = useState("all");
  const [filterUrgency, setFilterUrgency] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);

  useEffect(() => {
    if (user && user.role !== "super_admin") navigate("/clients/gmcb");
  }, [user, navigate]);

  async function load(silent = false) {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const res = await backendApi.listFeedbacks();
      setFeedbacks(res.feedbacks ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 20000);
    return () => clearInterval(id);
  }, []);

  // Sync selected row when feedbacks refresh — use functional updater to avoid stale closure
  useEffect(() => {
    setSelected((prev) => {
      if (!prev) return null;
      const updated = feedbacks.find((f) => f.id === prev.id);
      return updated ?? null;
    });
  }, [feedbacks]);

  async function sendReply() {
    if (!selected || !replyText.trim()) return;
    setReplySending(true);
    try {
      await backendApi.respondToFeedback(selected.id, replyText.trim());
      toast.success("Réponse envoyée");
      const now = new Date().toISOString();
      setFeedbacks((prev) => prev.map((f) =>
        f.id === selected.id ? { ...f, admin_response: replyText.trim(), responded_at: now } : f
      ));
      setSelected(null);
    } catch {
      toast.error("Erreur lors de l'envoi de la réponse");
    } finally {
      setReplySending(false);
    }
  }

  const filtered = feedbacks.filter((f) => {
    if (filterType !== "all" && f.type !== filterType) return false;
    if (filterUrgency !== "all" && f.urgency !== filterUrgency) return false;
    if (filterStatus === "replied" && !f.admin_response) return false;
    if (filterStatus === "pending" && f.admin_response) return false;
    return true;
  });

  const counts = {
    total: feedbacks.length,
    pending: feedbacks.filter((f) => !f.admin_response).length,
    high: feedbacks.filter((f) => f.urgency === "high").length,
  };

  if (user?.role !== "super_admin") return null;

  return (
    <div style={{ padding: "28px 24px", maxWidth: 1060, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <MessageSquare size={20} color="#0f172a" />
            <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.3px" }}>Feedbacks Clients</h1>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Retours et signalements envoyés par les utilisateurs</p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", fontSize: 12, fontWeight: 600, color: "#475569", cursor: "pointer" }}
        >
          <RefreshCw size={13} style={{ animation: refreshing ? "spin 0.8s linear infinite" : "none" }} />
          Actualiser
        </button>
      </div>

      {/* KPI pills */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Total", value: counts.total, color: "#0f172a", bg: "#f8fafc", border: "#e2e8f0" },
          { label: "En attente", value: counts.pending, color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
          { label: "Urgence élevée", value: counts.high, color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
        ].map((k) => (
          <div key={k.label} style={{ padding: "14px 18px", borderRadius: 14, background: k.bg, border: `1px solid ${k.border}` }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: k.color, lineHeight: 1 }}>{k.value}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4, fontWeight: 500 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background: "#f8fafc", borderRadius: 14, border: "1px solid #e2e8f0", padding: "14px 16px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, color: "#64748b" }}>
          <Filter size={13} />
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Filtres</span>
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" as const }}>

          <div>
            <div style={filterLabelStyle}>Type</div>
            <div style={{ display: "flex", gap: 5 }}>
              {([
                { value: "all", label: "Tous" },
                { value: "bug", label: "Bug" },
                { value: "feature", label: "Amélioration" },
                { value: "comment", label: "Commentaire" },
              ] as const).map((t) => {
                const active = filterType === t.value;
                const tc = t.value !== "all" ? typeConfig[t.value] : null;
                return (
                  <button key={t.value} onClick={() => setFilterType(t.value)} style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "5px 11px", borderRadius: 8,
                    border: `1px solid ${active && tc ? tc.border : active ? "#0f172a" : "#e2e8f0"}`,
                    fontSize: 12, cursor: "pointer", fontWeight: 600,
                    background: active ? (tc ? tc.bg : "#0f172a") : "#fff",
                    color: active ? (tc ? tc.color : "#fff") : "#64748b",
                    transition: "all .12s",
                  }}>
                    {tc && tc.icon}
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={filterLabelStyle}>Urgence</div>
            <div style={{ display: "flex", gap: 5 }}>
              {([
                { value: "all", label: "Toutes" },
                { value: "high", label: "Élevée" },
                { value: "medium", label: "Moyenne" },
                { value: "low", label: "Faible" },
              ] as const).map((u) => {
                const active = filterUrgency === u.value;
                const uc = u.value !== "all" ? urgencyConfig[u.value] : null;
                return (
                  <button key={u.value} onClick={() => setFilterUrgency(u.value)} style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "5px 11px", borderRadius: 8,
                    border: `1px solid ${active && uc ? uc.border : active ? "#0f172a" : "#e2e8f0"}`,
                    fontSize: 12, cursor: "pointer", fontWeight: 600,
                    background: active ? (uc ? uc.bg : "#0f172a") : "#fff",
                    color: active ? (uc ? uc.color : "#fff") : "#64748b",
                    transition: "all .12s",
                  }}>
                    {uc && <span style={{ width: 7, height: 7, borderRadius: "50%", background: uc.dot, display: "inline-block" }} />}
                    {u.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={filterLabelStyle}>Statut</div>
            <div style={{ display: "flex", gap: 5 }}>
              {([
                { value: "all", label: "Tous" },
                { value: "pending", label: "En attente" },
                { value: "replied", label: "Répondu" },
              ] as const).map((s) => {
                const active = filterStatus === s.value;
                return (
                  <button key={s.value} onClick={() => setFilterStatus(s.value)} style={{
                    padding: "5px 11px", borderRadius: 8,
                    border: `1px solid ${active ? "#0f172a" : "#e2e8f0"}`,
                    fontSize: 12, cursor: "pointer", fontWeight: 600,
                    background: active ? "#0f172a" : "#fff",
                    color: active ? "#fff" : "#64748b",
                    transition: "all .12s",
                  }}>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #e2e8f0", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>Chargement…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>Aucun feedback correspondant aux filtres</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #f1f5f9" }}>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Titre</th>
                <th style={thStyle}>Urgence</th>
                <th style={thStyle}>Statut</th>
                <th style={thStyle}>Utilisateur</th>
                <th style={thStyle}>Date</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((fb) => {
                const tc = typeConfig[fb.type] ?? typeConfig.comment;
                const uc = urgencyConfig[fb.urgency] ?? urgencyConfig.medium;
                return (
                  <tr
                    key={fb.id}
                    onClick={() => { setSelected(fb); setReplyText(fb.admin_response ?? ""); }}
                    style={{ borderBottom: "1px solid #f8fafc", cursor: "pointer", transition: "background .1s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 7, background: tc.bg, color: tc.color, border: `1px solid ${tc.border}`, fontSize: 11, fontWeight: 700 }}>
                        {tc.icon} {tc.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: "#0f172a", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {fb.screenshot_path && <ImageIcon size={12} style={{ marginRight: 5, verticalAlign: "middle", color: "#94a3b8", display: "inline" }} />}
                      {fb.title}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 7, background: uc.bg, color: uc.color, border: `1px solid ${uc.border}`, fontSize: 11, fontWeight: 700 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: uc.dot, display: "inline-block" }} />
                        {uc.label}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {fb.admin_response ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 7, background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", fontSize: 11, fontWeight: 700 }}>✓ Répondu</span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 7, background: "#fffbeb", color: "#d97706", border: "1px solid #fde68a", fontSize: 11, fontWeight: 700 }}>En attente</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: "#64748b", fontSize: 12 }}>{fb.user_email ?? "—"}</td>
                    <td style={{ ...tdStyle, color: "#64748b", fontSize: 12, whiteSpace: "nowrap" }}>{fmtDate(fb.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>
        {filtered.length} feedback{filtered.length !== 1 ? "s" : ""} · actualisé automatiquement
      </div>

      {/* Detail + Reply modal */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 560, maxWidth: "95vw", maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column" }}>

            <div style={{ padding: "16px 22px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.2px" }}>Détail du feedback</div>
              <button onClick={() => setSelected(null)} style={{ width: 30, height: 30, borderRadius: "50%", background: "#f1f5f9", border: "1px solid #e2e8f0", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
                <X size={14} />
              </button>
            </div>

            <div className="modal-scroll-area" style={{ overflowY: "auto", padding: "18px 22px", display: "grid", gap: 14 }}>
              <div>
                <div style={labelStyle}>Titre</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{selected.title}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={labelStyle}>Type</div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 8, background: (typeConfig[selected.type] ?? typeConfig.comment).bg, color: (typeConfig[selected.type] ?? typeConfig.comment).color, border: `1px solid ${(typeConfig[selected.type] ?? typeConfig.comment).border}`, fontSize: 12, fontWeight: 700 }}>
                    {(typeConfig[selected.type] ?? typeConfig.comment).icon} {(typeConfig[selected.type] ?? typeConfig.comment).label}
                  </span>
                </div>
                <div>
                  <div style={labelStyle}>Urgence</div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 8, background: (urgencyConfig[selected.urgency] ?? urgencyConfig.medium).bg, color: (urgencyConfig[selected.urgency] ?? urgencyConfig.medium).color, border: `1px solid ${(urgencyConfig[selected.urgency] ?? urgencyConfig.medium).border}`, fontSize: 12, fontWeight: 700 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: urgencyConfig[selected.urgency]?.dot ?? "#ccc" }} />
                    {(urgencyConfig[selected.urgency] ?? urgencyConfig.medium).label}
                  </span>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={labelStyle}>Utilisateur</div>
                  <div style={{ fontSize: 13, color: "#0f172a" }}>{selected.user_email ?? "—"}</div>
                </div>
                <div>
                  <div style={labelStyle}>Date envoi</div>
                  <div style={{ fontSize: 13, color: "#0f172a" }}>{fmtDate(selected.created_at)}</div>
                </div>
              </div>

              {selected.session_id && (
                <div>
                  <div style={labelStyle}>Session</div>
                  <div style={{ fontSize: 12, color: "#64748b", fontFamily: "monospace" }}>{selected.session_id}</div>
                </div>
              )}

              <div>
                <div style={labelStyle}>Commentaire</div>
                <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.75, background: "#f8fafc", borderRadius: 10, padding: "12px 14px", border: "1px solid #e2e8f0", whiteSpace: "pre-wrap", minHeight: 56 }}>
                  {selected.comment || <span style={{ color: "#94a3b8", fontStyle: "italic" }}>Aucun commentaire</span>}
                </div>
              </div>

              {selected.screenshot_path && (
                <div>
                  <div style={labelStyle}>Capture d'écran</div>
                  <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0" }}>
                    <img
                      src={backendApi.feedbackScreenshotUrl(selected.id)}
                      alt="screenshot"
                      style={{ width: "100%", maxHeight: 260, objectFit: "contain", background: "#f1f5f9", display: "block" }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  </div>
                </div>
              )}

              {selected.admin_response && (
                <div style={{ padding: "12px 14px", borderRadius: 12, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#16a34a", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
                    Votre réponse · {fmtDate(selected.responded_at ?? "")}
                  </div>
                  <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{selected.admin_response}</div>
                </div>
              )}

              <div>
                <div style={labelStyle}>{selected.admin_response ? "Modifier la réponse" : "Répondre"}</div>
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Écrivez votre réponse à l'utilisateur…"
                  rows={3}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d0d5dd", fontSize: 13, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button
                    onClick={sendReply}
                    disabled={replySending || !replyText.trim()}
                    style={{ display: "flex", alignItems: "center", gap: 7, border: "none", borderRadius: 10, padding: "9px 18px", background: replyText.trim() ? "#0f172a" : "#e2e8f0", color: replyText.trim() ? "#fff" : "#94a3b8", fontSize: 13, fontWeight: 700, cursor: replyText.trim() ? "pointer" : "not-allowed", transition: "all .15s" }}
                  >
                    <Send size={13} />
                    {replySending ? "Envoi…" : selected.admin_response ? "Mettre à jour" : "Envoyer la réponse"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

const filterLabelStyle: React.CSSProperties = {
  fontSize: 10, color: "#94a3b8", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em",
};

const thStyle: React.CSSProperties = {
  padding: "11px 14px", textAlign: "left", fontSize: 10, fontWeight: 700,
  color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em",
};

const tdStyle: React.CSSProperties = { padding: "11px 14px", fontSize: 13 };

const labelStyle: React.CSSProperties = {
  fontSize: 11, color: "#64748b", marginBottom: 5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em",
};

export default GMCBSuperAdmin;
