import { useEffect, useState } from "react";
import { backendApi } from "@/core/backendApi";
import { useGMCBAuth } from "@/contexts/GMCBAuthContext";
import { X, MessageSquare, AlertTriangle, Lightbulb, MessageCircle, ImageIcon, CheckCircle2, Clock } from "lucide-react";

interface FeedbackRow {
  id: number;
  title: string;
  comment: string;
  type: string;
  urgency: string;
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

const urgencyConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
  low:    { label: "Faible",  color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  medium: { label: "Moyenne", color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  high:   { label: "Élevée",  color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
};

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const GMCBMyFeedbacks = () => {
  const [feedbacks, setFeedbacks] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FeedbackRow | null>(null);
  const { user } = useGMCBAuth();

  // Mark responded feedbacks as seen whenever the list updates (covers load + 30-s refresh)
  useEffect(() => {
    if (!user || feedbacks.length === 0) return;
    const seenKey = `gmcb_seen_fb_ids_${user.email}`;
    const existing: number[] = JSON.parse(localStorage.getItem(seenKey) ?? "[]");
    const respondedIds = feedbacks.filter((f) => f.admin_response).map((f) => f.id);
    if (respondedIds.length === 0) return;
    const merged = [...new Set([...existing, ...respondedIds])];
    localStorage.setItem(seenKey, JSON.stringify(merged));
  }, [feedbacks, user]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await backendApi.listMyFeedbacks();
        if (!cancelled) setFeedbacks(res.feedbacks ?? []);
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const replied = feedbacks.filter((f) => f.admin_response).length;

  return (
    <div style={{ padding: "28px 24px", maxWidth: 840, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <MessageSquare size={20} color="#0f172a" />
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.3px" }}>Mes Feedbacks</h1>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Vos retours envoyés et les réponses de l'équipe</p>
      </div>

      {/* Summary pills */}
      {feedbacks.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 10, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 }}>
            <MessageSquare size={14} /> {feedbacks.length} feedback{feedbacks.length !== 1 ? "s" : ""}
          </div>
          {replied > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 10, background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: 13, color: "#16a34a", fontWeight: 600 }}>
              <CheckCircle2 size={14} /> {replied} répon{replied !== 1 ? "ses" : "se"} reçue{replied !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ padding: 48, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>Chargement…</div>
      ) : feedbacks.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#94a3b8" }}>
          <MessageSquare size={32} color="#cbd5e1" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Aucun feedback envoyé</div>
          <div style={{ fontSize: 13 }}>Utilisez le bouton Feedback dans la barre latérale pour nous envoyer un retour.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {feedbacks.map((fb) => {
            const tc = typeConfig[fb.type] ?? typeConfig.comment;
            const uc = urgencyConfig[fb.urgency] ?? urgencyConfig.medium;
            const hasReply = !!fb.admin_response;
            return (
              <div
                key={fb.id}
                onClick={() => setSelected(fb)}
                style={{ background: "#fff", borderRadius: 14, border: `1px solid ${hasReply ? "#bbf7d0" : "#e2e8f0"}`, padding: "16px 18px", cursor: "pointer", transition: "box-shadow .15s, border-color .15s", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.03)"; }}
              >
                {/* Top row */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 7, background: tc.bg, color: tc.color, border: `1px solid ${tc.border}`, fontSize: 11, fontWeight: 700 }}>
                        {tc.icon} {tc.label}
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 7, background: uc.bg, color: uc.color, border: `1px solid ${uc.border}`, fontSize: 11, fontWeight: 700 }}>
                        {uc.label}
                      </span>
                      {fb.screenshot_path && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 7, background: "#f8fafc", color: "#64748b", border: "1px solid #e2e8f0", fontSize: 11 }}>
                          <ImageIcon size={11} /> Capture
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>{fb.title}</div>
                    {fb.comment && (
                      <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {fb.comment}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>{fmtDate(fb.created_at)}</div>
                    {hasReply ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 7, background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", fontSize: 11, fontWeight: 700 }}>
                        <CheckCircle2 size={11} /> Réponse reçue
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 7, background: "#f8fafc", color: "#94a3b8", border: "1px solid #e2e8f0", fontSize: 11 }}>
                        <Clock size={11} /> En attente
                      </span>
                    )}
                  </div>
                </div>

                {/* Response preview */}
                {hasReply && (
                  <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#16a34a", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" }}>Réponse · {fmtDate(fb.responded_at ?? "")}</div>
                    <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.6, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {fb.admin_response}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 540, maxWidth: "95vw", maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column" }}>

            <div style={{ padding: "16px 22px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>Détail du feedback</div>
              <button onClick={() => setSelected(null)} style={{ width: 30, height: 30, borderRadius: "50%", background: "#f1f5f9", border: "1px solid #e2e8f0", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
                <X size={14} />
              </button>
            </div>

            <div style={{ overflowY: "auto", padding: "18px 22px", display: "grid", gap: 14 }}>
              <div>
                <div style={mlabelStyle}>Titre</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{selected.title}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={mlabelStyle}>Type</div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 8, background: (typeConfig[selected.type] ?? typeConfig.comment).bg, color: (typeConfig[selected.type] ?? typeConfig.comment).color, border: `1px solid ${(typeConfig[selected.type] ?? typeConfig.comment).border}`, fontSize: 12, fontWeight: 700 }}>
                    {(typeConfig[selected.type] ?? typeConfig.comment).icon} {(typeConfig[selected.type] ?? typeConfig.comment).label}
                  </span>
                </div>
                <div>
                  <div style={mlabelStyle}>Urgence</div>
                  <span style={{ display: "inline-flex", padding: "4px 10px", borderRadius: 8, background: (urgencyConfig[selected.urgency] ?? urgencyConfig.medium).bg, color: (urgencyConfig[selected.urgency] ?? urgencyConfig.medium).color, border: `1px solid ${(urgencyConfig[selected.urgency] ?? urgencyConfig.medium).border}`, fontSize: 12, fontWeight: 700 }}>
                    {(urgencyConfig[selected.urgency] ?? urgencyConfig.medium).label}
                  </span>
                </div>
              </div>
              <div>
                <div style={mlabelStyle}>Date d'envoi</div>
                <div style={{ fontSize: 13, color: "#475569" }}>{fmtDate(selected.created_at)}</div>
              </div>
              <div>
                <div style={mlabelStyle}>Votre commentaire</div>
                <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.75, background: "#f8fafc", borderRadius: 10, padding: "12px 14px", border: "1px solid #e2e8f0", whiteSpace: "pre-wrap", minHeight: 56 }}>
                  {selected.comment || <span style={{ color: "#94a3b8", fontStyle: "italic" }}>Aucun commentaire</span>}
                </div>
              </div>
              {selected.screenshot_path && (
                <div>
                  <div style={mlabelStyle}>Capture d'écran jointe</div>
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
              {selected.admin_response ? (
                <div style={{ padding: "14px 16px", borderRadius: 12, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <CheckCircle2 size={14} color="#16a34a" />
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#16a34a", textTransform: "uppercase", letterSpacing: ".04em" }}>Réponse de l'équipe · {fmtDate(selected.responded_at ?? "")}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.75, whiteSpace: "pre-wrap" }}>{selected.admin_response}</div>
                </div>
              ) : (
                <div style={{ padding: "14px 16px", borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8, color: "#94a3b8", fontSize: 13 }}>
                  <Clock size={14} />
                  Aucune réponse pour l'instant. L'équipe a pris note de votre retour.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const mlabelStyle: React.CSSProperties = {
  fontSize: 11, color: "#64748b", marginBottom: 5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em",
};

export default GMCBMyFeedbacks;
