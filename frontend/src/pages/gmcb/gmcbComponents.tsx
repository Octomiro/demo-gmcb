// ─── GMCB Shared UI Components ────────────────────────────────────────────────
// Reusable components used across GMCB pages (QualiteLive, Historique, Admin)

import { useState, useRef } from "react";
import {
  X, ChevronRight, ChevronLeft, Download, Calendar,
  CheckCircle2, AlertCircle, Camera, Clock, TrendingUp,
  Eye, Timer, Flag, Plus, ArrowLeft, Paperclip, ImageIcon,
} from "lucide-react";
import {
  type AnomalyItem, type DayData, type SessionData, type FeedbackItem, type FeedbackDraft,
  DAYS_DATA, doExport, formatHistoryDate, formatAdminDate, todayIso,
} from "./gmcbData";

// ─── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard({ icon, iconBg, value, label }: { icon: React.ReactNode; iconBg: string; value: string | number; label: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e8eaed", padding: "20px 22px", display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ width: 44, height: 44, background: iconBg, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.5px" }}>{value}</div>
        <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{label}</div>
      </div>
    </div>
  );
}

// ─── MiniStat ─────────────────────────────────────────────────────────────────

export function MiniStat({ icon, bg, value, label }: { icon: React.ReactNode; bg: string; value: string | number; label: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #f0f0f0", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 32, height: 32, background: bg, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{label}</div>
      </div>
    </div>
  );
}

// ─── CamFeed ──────────────────────────────────────────────────────────────────

export function CamFeed({ label, sublabel, img, showBadge }: { label: string; sublabel: string; img: string; showBadge?: boolean }) {
  return (
    <div style={{ position: "relative", aspectRatio: "16/10", overflow: "hidden" }}>
      {/* TODO: replace static image with MJPEG stream:
          <img src={`${import.meta.env.VITE_API_BASE_URL}/video_feed`} />
          MJPEG stream — no WebSocket needed, native browser rendering */}
      <img src={img} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.1)" }} />
      <div style={{ position: "absolute", top: 10, left: 10, background: "rgba(0,0,0,0.6)", borderRadius: 5, padding: "3px 9px", color: "#fff", fontSize: 11, fontWeight: 600 }}>{label}</div>
      {/* TODO: fetch from API — GET /api/stats → total_packets */}
      {showBadge && <div style={{ position: "absolute", top: 10, right: 10, background: "rgba(0,0,0,0.6)", borderRadius: 5, padding: "3px 9px", color: "#22c55e", fontSize: 11, fontWeight: 600 }}>TOTAL PACKETS: 42</div>}
      <div style={{ position: "absolute", bottom: 10, left: 10, color: "rgba(255,255,255,0.8)", fontSize: 11 }}>▶ {sublabel}</div>
    </div>
  );
}

// ─── Pager ────────────────────────────────────────────────────────────────────

export function Pager({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid #e0e0e0", background: "#fff", cursor: page === 0 ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: page === 0 ? 0.4 : 1 }}>
        <ChevronLeft size={14} />
      </button>
      <span style={{ fontSize: 12, color: "#666", minWidth: 60, textAlign: "center" }}>{page + 1} / {total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page === total - 1} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid #e0e0e0", background: "#fff", cursor: page === total - 1 ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: page === total - 1 ? 0.4 : 1 }}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

// ─── InfoRow ──────────────────────────────────────────────────────────────────

export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

// ─── Metric ───────────────────────────────────────────────────────────────────

export function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontWeight: 700, fontSize: 16, color }}>{value}</div>
      <div style={{ fontSize: 11, color: "#999" }}>{label}</div>
    </div>
  );
}

// ─── ExportModal ──────────────────────────────────────────────────────────────

export function ExportModal({ data, onClose }: { data: AnomalyItem[]; onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const formats = [
    { id: "csv", icon: "📄", label: "CSV", desc: "Fichier texte séparé par virgules, compatible avec tous les tableurs" },
    { id: "excel", icon: "📊", label: "Excel", desc: "Fichier .xls, s'ouvre directement dans Microsoft Excel" },
    { id: "json", icon: "🔧", label: "JSON", desc: "Format structuré pour intégration avec d'autres systèmes" },
  ];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 440, maxWidth: "92vw", maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Exporter les anomalies</h2>
            <p style={{ margin: 0, fontSize: 12, color: "#888", marginTop: 3 }}>{data.length} entrées • Choisissez un format</p>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: "50%", background: "#f5f5f5", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-scroll-shell">
          <div className="modal-scroll-area" style={{ padding: "16px 24px" }}>
            {formats.map((f) => (
              <div key={f.id} onClick={() => setSelected(f.id)}
                style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 12, border: `2px solid ${selected === f.id ? "#0d9488" : "#f0f0f0"}`, marginBottom: 10, cursor: "pointer", background: selected === f.id ? "#f0fdfa" : "#fff", transition: "all .15s" }}>
                <span style={{ fontSize: 24 }}>{f.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{f.label}</div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{f.desc}</div>
                </div>
                <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${selected === f.id ? "#0d9488" : "#ddd"}`, background: selected === f.id ? "#0d9488" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {selected === f.id && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", display: "inline-block" }}></span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ padding: "0 24px 22px", display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 11, borderRadius: 10, border: "1px solid #e0e0e0", background: "#fff", fontSize: 14, cursor: "pointer", fontWeight: 500, color: "#555" }}>Annuler</button>
          <button
            onClick={() => { if (selected) { doExport(data, selected); onClose(); } }}
            disabled={!selected}
            style={{ flex: 2, padding: 11, borderRadius: 10, border: "none", background: selected ? "#0d9488" : "#e0e0e0", color: selected ? "#fff" : "#aaa", fontSize: 14, cursor: selected ? "pointer" : "not-allowed", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "background .15s" }}>
            <Download size={15} /> Télécharger {selected ? selected.toUpperCase() : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AnomalyModal ─────────────────────────────────────────────────────────────

export function AnomalyModal({ anomaly, onClose }: { anomaly: AnomalyItem; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 560, maxWidth: "92vw", maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.35)", display: "flex", flexDirection: "column" }}>
        <div style={{ position: "relative", height: "min(370px, 52vh)", background: "#0f172a" }}>
          <img
            src={anomaly.img}
            alt={anomaly.type}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#0f172a" }}
            onError={(e) => {
              const img = e.currentTarget;
              if (anomaly.fallbackImg && img.src !== anomaly.fallbackImg) {
                img.src = anomaly.fallbackImg;
                return;
              }
              img.onerror = null;
            }}
          />
          <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={16} />
          </button>
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 72, background: "linear-gradient(transparent,rgba(0,0,0,0.72))", display: "flex", alignItems: "flex-end", padding: "0 16px 14px" }}>
            <div>
              <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>{anomaly.type}</div>
              <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>{anomaly.time} • Paquet {anomaly.lot}</div>
            </div>
          </div>
        </div>
        <div style={{ padding: "16px 20px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
          <InfoRow label="N° Paquet" value={anomaly.lot} />
          <InfoRow label="Heure" value={anomaly.time} />
          <InfoRow label="Type d'anomalie" value={anomaly.type} />
        </div>
      </div>
    </div>
  );
}

// ─── FeedbackModal ────────────────────────────────────────────────────────────

export function FeedbackModal({ draft, onChange, onClose, onSubmit }: {
  draft: FeedbackDraft;
  onChange: (d: FeedbackDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (file) {
      onChange({ ...draft, screenshot: file });
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    }
  }

  function clearScreenshot() {
    onChange({ ...draft, screenshot: null });
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 480, maxWidth: "95vw", maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.2px" }}>Envoyer un retour</div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: "50%", background: "#f1f5f9", border: "1px solid #e2e8f0", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexShrink: 0 }}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-scroll-shell">
          <div className="modal-scroll-area" style={{ padding: "20px 24px", display: "grid", gap: 14 }}>
            <div style={{ fontSize: 13, color: "#667085", lineHeight: 1.6, paddingBottom: 4, borderBottom: "1px solid #f1f5f9" }}>Signalez un bug, suggérez une amélioration ou donnez une note générale.</div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, fontWeight: 600 }}>Type</div>
              <select value={draft.type} onChange={(e) => onChange({ ...draft, type: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #d0d5dd", fontSize: 13 }}>
                <option value="bug">Bug</option>
                <option value="feature">Amélioration</option>
                <option value="comment">Commentaire</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, fontWeight: 600 }}>Titre</div>
              <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} placeholder="Titre succinct" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #d0d5dd", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, fontWeight: 600 }}>Urgence</div>
              <div style={{ display: "flex", gap: 8 }}>
                {[
                  { value: "low", label: "Faible", color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
                  { value: "medium", label: "Moyenne", color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
                  { value: "high", label: "Élevée", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
                ].map((u) => (
                  <button key={u.value} onClick={() => onChange({ ...draft, urgency: u.value })} style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: `1px solid ${draft.urgency === u.value ? u.border : "#d0d5dd"}`, background: draft.urgency === u.value ? u.bg : "#fff", color: draft.urgency === u.value ? u.color : "#667085", fontSize: 13, fontWeight: draft.urgency === u.value ? 700 : 500, cursor: "pointer", transition: "all .15s" }}>
                    {u.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, fontWeight: 600 }}>Commentaire</div>
              <textarea value={draft.comment} onChange={(e) => onChange({ ...draft, comment: e.target.value })} placeholder="Expliquez le problème ou la suggestion" style={{ width: "100%", minHeight: 100, padding: "10px 12px", borderRadius: 8, border: "1px solid #d0d5dd", fontSize: 13, resize: "vertical", boxSizing: "border-box" }} />
            </div>
            {/* Screenshot upload */}
            <div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, fontWeight: 600 }}>Capture d'écran <span style={{ fontWeight: 400, color: "#94a3b8" }}>(optionnel)</span></div>
              {previewUrl ? (
                <div style={{ position: "relative" }}>
                  <img src={previewUrl} alt="preview" style={{ width: "100%", maxHeight: 180, objectFit: "cover", borderRadius: 10, border: "1px solid #e2e8f0" }} />
                  <button onClick={clearScreenshot} style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: "50%", background: "rgba(15,23,42,0.7)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{ width: "100%", padding: "14px 12px", borderRadius: 10, border: "1.5px dashed #d0d5dd", background: "#f8fafc", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#64748b", fontSize: 13 }}
                >
                  <Paperclip size={15} />
                  <span>Joindre une image</span>
                </button>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />
            </div>
          </div>
        </div>
        <div style={{ padding: "16px 24px", borderTop: "1px solid #f0f0f0", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ border: "1px solid #d0d5dd", borderRadius: 12, padding: "10px 18px", background: "#fff", color: "#475467", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Annuler
          </button>
          <button onClick={onSubmit} style={{ border: "none", borderRadius: 12, padding: "10px 18px", background: "#0f172a", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DayModal ─────────────────────────────────────────────────────────────────

interface DayModalProps {
  day: DayData;
  dayModalOrigin: string | null;
  onClose: () => void;
  onBackToCalendar?: (() => void) | null;
  onBackToAdmin?: (() => void) | null;
  setSessionView: (sv: { session: SessionData; day: DayData }) => void;
  setExportModal: (data: AnomalyItem[]) => void;
  openFeedbackModal: (preset?: Record<string, string>) => void;
}

export function DayModal({ day, dayModalOrigin, onClose, onBackToCalendar, onBackToAdmin, setSessionView, setExportModal, openFeedbackModal }: DayModalProps) {
  const [viewMode, setViewMode] = useState("all");
  const backAction = dayModalOrigin === "calendar" ? onBackToCalendar : dayModalOrigin === "admin" ? onBackToAdmin : null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 700, maxWidth: "95vw", maxHeight: "88vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 32px 80px rgba(0,0,0,0.3)" }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {backAction && (
              <button onClick={backAction} title={dayModalOrigin === "admin" ? "Retour à l'admin" : "Retour au calendrier"} style={{ width: 34, height: 34, borderRadius: "50%", background: "#eef2ff", border: "1px solid #c7d2fe", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#4f46e5", flexShrink: 0 }}>
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{day.label}</h2>
              <p style={{ margin: 0, fontSize: 13, color: "#777", marginTop: 2 }}>{day.sessions.length} sessions • {day.paquets.toLocaleString()} paquets analysés</p>
            </div>
          </div>
          <button onClick={onClose} style={{ width: 34, height: 34, borderRadius: "50%", background: "#f5f5f5", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={16} />
          </button>
        </div>
        {/* Stats row */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #f0f0f0", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, flexShrink: 0 }}>
          <MiniStat icon={<CheckCircle2 size={18} color="#16a34a" />} bg="#dcfce7" value={(day.paquets - day.anomalies).toLocaleString()} label="Conformes" />
          <MiniStat icon={<AlertCircle size={18} color="#dc2626" />} bg="#fee2e2" value={day.anomalies} label="Anomalies" />
          <MiniStat icon={<Camera size={18} color="#2563eb" />} bg="#dbeafe" value={day.conformite + "%"} label="Conformité" />
          <MiniStat icon={<Clock size={18} color="#9333ea" />} bg="#f3e8ff" value={day.sessions.length} label="Sessions" />
        </div>
        {/* View toggle */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid #f0f0f0", display: "flex", gap: 6, flexShrink: 0 }}>
          {["all", "sessions"].map((v) => (
            <button key={v} onClick={() => setViewMode(v)} style={{ padding: "6px 16px", borderRadius: 20, border: "1px solid #e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500, background: viewMode === v ? "#111" : "#fff", color: viewMode === v ? "#fff" : "#444", transition: "all .15s" }}>
              {v === "all" ? "Vue globale" : "Par session"}
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
                {day.sessions.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div style={{ width: 72, fontSize: 12, color: "#666" }}>{s.startH}–{s.endH}</div>
                    <div style={{ flex: 1, background: "#f0fdf4", borderRadius: 4, height: 8, overflow: "hidden" }}>
                      <div style={{ width: s.conformite + "%", background: "#22c55e", height: "100%", borderRadius: 4 }} />
                    </div>
                    <div style={{ width: 48, fontSize: 12, fontWeight: 600, textAlign: "right", color: "#16a34a" }}>{s.conformite}%</div>
                    <div style={{ width: 52, fontSize: 11, color: "#999", textAlign: "right" }}>{s.anomalies} défauts</div>
                  </div>
                ))}
              </div>
              <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: "#555" }}>Anomalies par type</div>
                {[["Paquet ouvert", "#16A34A"], ["Paquet sans code à barre", "#84CC16"], ["Date non visible", "#06B6D4"], ["Code à barre non visible", "#3b82f6"]].map(([label, color], i) => {
                  const total = day.sessions.reduce((sum, s) => { const r = s.resultats.find((r) => r.label === label); return sum + (r ? r.count : 0); }, 0);
                  if (!total) return null;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #eee" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
                        <span style={{ fontSize: 13 }}>{label}</span>
                      </div>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{total}</span>
                    </div>
                  );
                })}
              </div>
              {/* Charts */}
              <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
                <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 16, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: "#555" }}>Répartition globale</div>
                  <DoughnutChart day={day} showConformes />
                </div>
                <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 16, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: "#555" }}>Distribution des anomalies</div>
                  <DoughnutChart day={day} showConformes={false} />
                </div>
              </div>
            </div>
          )}
          {viewMode === "sessions" && (
            <div>
              {day.sessions.map((s, i) => (
                <div key={i} style={{ background: "#f8f9fa", borderRadius: 12, padding: 16, marginBottom: 12, border: "1px solid #f0f0f0" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{s.label}</div>
                      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{s.startH} – {s.endH} • {s.lot}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button onClick={() => setSessionView({ session: s, day })} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", background: "#0d9488", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                        <Eye size={14} /> Voir session
                      </button>
                      <button onClick={() => openFeedbackModal({ scope: "session", sessionId: String(s.id), date: day.date })} title="Signaler un problème" style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e", fontSize: 13, cursor: "pointer" }}>
                        <Flag size={14} />
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                    <MiniStat icon={<CheckCircle2 size={16} color="#16a34a" />} bg="#dcfce7" value={(s.paquets - s.anomalies).toLocaleString()} label="Conformes" />
                    <MiniStat icon={<AlertCircle size={16} color="#dc2626" />} bg="#fee2e2" value={s.anomalies} label="Anomalies" />
                    <MiniStat icon={<Camera size={16} color="#2563eb" />} bg="#dbeafe" value={s.conformite + "%"} label="Conformité" />
                    <MiniStat icon={<Timer size={16} color="#9333ea" />} bg="#f3e8ff" value={s.cadence + "/min"} label="Cadence" />
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DoughnutChart helper ─────────────────────────────────────────────────────

function DoughnutChart({ day, showConformes }: { day: DayData; showConformes: boolean }) {
  const total = day.paquets;
  const conformes = total - day.anomalies;
  const anomaliesData = [["Paquet ouvert", "#16A34A"], ["Paquet sans code à barre", "#84CC16"], ["Date non visible", "#06B6D4"], ["Code à barre non visible", "#3b82f6"]].map(([label, color]) => {
    const count = day.sessions.reduce((sum, s) => { const r = s.resultats.find((r) => r.label === label); return sum + (r ? r.count : 0); }, 0);
    return { label: label as string, count, color: color as string };
  }).filter((a) => a.count > 0);

  const pieData = showConformes
    ? [{ label: "Conformes", count: conformes, color: "#22c55e" }, ...anomaliesData]
    : anomaliesData;

  if (pieData.length === 0) return <span style={{ fontSize: 12, color: "#888" }}>Aucune anomalie détectée</span>;

  const totalCount = pieData.reduce((sum, d) => sum + d.count, 0);
  const outerRadius = showConformes ? 40 : 40;
  const innerRadius = showConformes ? 25 : 0;

  let cumulative = 0;
  const paths = pieData.map((d) => {
    const startAngle = (cumulative / totalCount) * 360;
    cumulative += d.count;
    const endAngle = (cumulative / totalCount) * 360;
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    const x1 = 50 + outerRadius * Math.cos((startAngle * Math.PI) / 180);
    const y1 = 50 + outerRadius * Math.sin((startAngle * Math.PI) / 180);
    const x2 = 50 + outerRadius * Math.cos((endAngle * Math.PI) / 180);
    const y2 = 50 + outerRadius * Math.sin((endAngle * Math.PI) / 180);

    let pathData: string;
    if (showConformes) {
      const x3 = 50 + innerRadius * Math.cos((endAngle * Math.PI) / 180);
      const y3 = 50 + innerRadius * Math.sin((endAngle * Math.PI) / 180);
      const x4 = 50 + innerRadius * Math.cos((startAngle * Math.PI) / 180);
      const y4 = 50 + innerRadius * Math.sin((startAngle * Math.PI) / 180);
      pathData = `M ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`;
    } else {
      pathData = `M 50 50 L ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    }
    return <path key={d.label} d={pathData} fill={d.color} />;
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <svg width="100" height="100" viewBox="0 0 100 100">{paths}</svg>
      <div style={{ flex: 1 }}>
        {pieData.map((d) => (
          <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: d.color, display: "inline-block" }} />
            <span style={{ fontSize: 12 }}>{d.label}: {d.count} ({((d.count / totalCount) * 100).toFixed(1)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CalendarPickerModal ──────────────────────────────────────────────────────

interface CalendarPickerModalProps {
  mode?: "single" | "range";
  selectedRange?: { start: string | null; end: string | null } | null;
  onClose: () => void;
  onSelectDay?: (day: DayData) => void;
  onApplyRange?: (range: { start: string; end: string }) => void;
  /** If provided, these dates are highlighted/clickable instead of DAYS_DATA. */
  availableDates?: string[];
}

export function CalendarPickerModal({ mode = "single", selectedRange, onClose, onSelectDay, onApplyRange, availableDates }: CalendarPickerModalProps) {
  const effectiveDates = availableDates && availableDates.length > 0
    ? availableDates.slice().sort()
    : DAYS_DATA.map((d) => d.date).sort();
  const daysByDate: Record<string, DayData> = availableDates && availableDates.length > 0
    ? Object.fromEntries(availableDates.map((d) => [d, { date: d, label: d, sessions: [], paquets: 0, anomalies: 0, defauts: 0, conformite: 0 } as DayData]))
    : Object.fromEntries(DAYS_DATA.map((day) => [day.date, day]));
  const dates = effectiveDates;
  const rangeMinDate = new Date(todayIso() + "T00:00:00");
  rangeMinDate.setFullYear(rangeMinDate.getFullYear() - 1);
  const minDate = mode === "range" ? rangeMinDate : new Date(dates[0] + "T00:00:00");
  const maxDate = new Date(dates[dates.length - 1] + "T00:00:00");
  const initialFocusDate = (selectedRange?.end || selectedRange?.start || dates[dates.length - 1]) as string;
  const [viewMonth, setViewMonth] = useState(new Date(initialFocusDate + "T00:00:00"));
  const [rangeDraft, setRangeDraft] = useState<{ start: string | null; end: string | null }>(selectedRange || { start: null, end: null });

  const monthLabel = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
  const weekLabel = ["Di", "Lu", "Ma", "Me", "Je", "Ve", "Sa"];

  const monthStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const monthEnd = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const leadingEmpty = monthStart.getDay();
  // In range mode allow navigating up to today's month (so user can pick today as range boundary)
  const effectiveMaxDate = mode === "range" ? new Date(todayIso() + "T00:00:00") : maxDate;
  const canPrev = (viewMonth.getFullYear() * 12 + viewMonth.getMonth()) > (minDate.getFullYear() * 12 + minDate.getMonth());
  const canNext = (viewMonth.getFullYear() * 12 + viewMonth.getMonth()) < (effectiveMaxDate.getFullYear() * 12 + effectiveMaxDate.getMonth());

  const toIso = (year: number, month: number, day: number) => {
    const m = String(month + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    return `${year}-${m}-${d}`;
  };

  const handleDayClick = (iso: string, dayData: DayData) => {
    if (mode === "single") {
      onSelectDay?.(dayData);
      return;
    }
    setRangeDraft((prev) => {
      if (!prev?.start || (prev.start && prev.end)) return { start: iso, end: null };
      if (iso < prev.start) return { start: iso, end: prev.start };
      return { start: prev.start, end: iso };
    });
  };

  const isInSelectedRange = (iso: string) => {
    if (mode !== "range" || !rangeDraft?.start) return false;
    if (!rangeDraft.end) return iso === rangeDraft.start;
    return iso >= rangeDraft.start && iso <= rangeDraft.end;
  };

  const isRangeEdge = (iso: string) => {
    if (mode !== "range") return false;
    return iso === rangeDraft?.start || iso === rangeDraft?.end;
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(9,10,20,0.55)", backdropFilter: "blur(3px)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "95vw", maxHeight: "calc(100vh - 40px)", background: "#fff", borderRadius: 20, border: "1px solid #e8eaed", boxShadow: "0 30px 70px rgba(0,0,0,0.30)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid #f0f0f0", background: "linear-gradient(180deg,#f8faff,#ffffff)" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{mode === "single" ? "Sélectionner une date" : "Sélectionner une période"}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{mode === "single" ? "Choisissez un jour pour ouvrir ses statistiques" : "Choisissez une date de début puis une date de fin"}</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: "50%", border: "none", background: "#f3f4f6", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-scroll-shell">
          <div className="modal-scroll-area" style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <button onClick={() => canPrev && setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))} disabled={!canPrev} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e5e7eb", background: canPrev ? "#fff" : "#f5f5f5", color: canPrev ? "#4b5563" : "#bbb", cursor: canPrev ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ChevronLeft size={14} />
            </button>
            <div style={{ fontWeight: 700, fontSize: 14, textTransform: "capitalize" }}>{monthLabel[viewMonth.getMonth()]} {viewMonth.getFullYear()}</div>
            <button onClick={() => canNext && setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))} disabled={!canNext} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e5e7eb", background: canNext ? "#fff" : "#f5f5f5", color: canNext ? "#4b5563" : "#bbb", cursor: canNext ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, marginBottom: 8 }}>
            {weekLabel.map((l) => (<div key={l} style={{ textAlign: "center", fontSize: 11, color: "#9ca3af", fontWeight: 700, padding: "6px 0" }}>{l}</div>))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
            {Array.from({ length: leadingEmpty }).map((_, i) => (<div key={`empty-${i}`} style={{ height: 38 }} />))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const dayNum = i + 1;
              const iso = toIso(viewMonth.getFullYear(), viewMonth.getMonth(), dayNum);
              const dayData = daysByDate[iso];
              const hasData = Boolean(dayData);
              // In range mode: any day up to today is a valid boundary, not just session days.
              // In single mode: only days with session data are selectable (clicking opens details).
              const selectable = mode === "range" ? iso <= todayIso() : hasData;
              const inRange = isInSelectedRange(iso);
              const isEdge = isRangeEdge(iso);
              const effectiveDayData: DayData = dayData || { date: iso, label: iso, sessions: [], paquets: 0, anomalies: 0, defauts: 0, conformite: 0 };
              return (
                <button key={iso} onClick={() => selectable && handleDayClick(iso, effectiveDayData)} disabled={!selectable}
                  style={{ height: 38, borderRadius: 10, border: isEdge ? "1px solid #4338ca" : (hasData || inRange) ? "1px solid #c7d2fe" : selectable ? "1px solid #e2e8f0" : "1px solid #f1f5f9", background: isEdge ? "#4f46e5" : inRange ? "#eef2ff" : "#f8fafc", color: isEdge ? "#fff" : hasData ? "#3730a3" : selectable ? "#9ca3af" : "#c0c4cc", fontWeight: 700, fontSize: 12, cursor: selectable ? "pointer" : "not-allowed", transition: "all .15s" }}>
                  {dayNum}
                </button>
              );
            })}
          </div>
          {mode === "range" && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f0f0f0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>Période choisie</div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#3730a3" }}>
                    {rangeDraft?.start ? formatHistoryDate(rangeDraft.start) : "Date début"} - {rangeDraft?.end ? formatHistoryDate(rangeDraft.end) : "Date fin"}
                  </div>
                </div>
                <button onClick={() => setRangeDraft({ start: null, end: null })} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", color: "#6b7280" }}>
                  Réinitialiser
                </button>
              </div>
              <button onClick={() => rangeDraft?.start && rangeDraft?.end && onApplyRange?.({ start: rangeDraft.start, end: rangeDraft.end })} disabled={!rangeDraft?.start || !rangeDraft?.end}
                style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "none", background: rangeDraft?.start && rangeDraft?.end ? "#4f46e5" : "#c7d2fe", color: "#fff", fontSize: 13, fontWeight: 800, cursor: rangeDraft?.start && rangeDraft?.end ? "pointer" : "not-allowed" }}>
                Appliquer la période
              </button>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Admin Shared Components ──────────────────────────────────────────────────

export function DashboardPanel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", borderRadius: 18, border: "1px solid #e8eaed", padding: 22, boxShadow: "0 10px 30px rgba(15,23,42,0.04)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a" }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "#7c8594", marginTop: 4 }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function AdminActionCard({ icon, title, text, buttonLabel, onClick, tone = "dark", disabled = false }: { icon: React.ReactNode; title: string; text: string; buttonLabel: string; onClick: () => void; tone?: string; disabled?: boolean }) {
  const tones: Record<string, { background: string; color: string }> = {
    dark: { background: "#0f172a", color: "#fff" },
    teal: { background: "#0f766e", color: "#fff" },
    amber: { background: "#f59e0b", color: "#fff" },
  };
  const buttonTone = tones[tone] || tones.dark;

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 18, background: "#fff", display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", color: "#0f172a" }}>{icon}</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>{title}</div>
          <div style={{ fontSize: 12, color: "#667085", marginTop: 3, lineHeight: 1.5 }}>{text}</div>
        </div>
      </div>
      <button disabled={disabled} onClick={onClick} style={{ border: "none", borderRadius: 12, padding: "11px 14px", background: disabled ? "#9ca3af" : buttonTone.background, color: buttonTone.color, fontSize: 13, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: disabled ? 0.72 : 1 }}>
        <Plus size={15} />
        {buttonLabel}
      </button>
    </div>
  );
}

export function AdminModal({ open, title, subtitle, onClose, children, footer }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(4px)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px,100%)", maxHeight: "calc(100vh - 48px)", overflow: "hidden", background: "#fff", borderRadius: 24, border: "1px solid #e5e7eb", boxShadow: "0 24px 80px rgba(15,23,42,0.18)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 24, borderBottom: "1px solid #eef2f7", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 13, color: "#667085", marginTop: 6, lineHeight: 1.5 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ width: 36, height: 36, borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#475467", flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-scroll-shell">
          <div className="modal-scroll-area" style={{ padding: 24 }}>
            {children}
          </div>
        </div>
        {footer && <div style={{ padding: 24, borderTop: "1px solid #eef2f7", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>{footer}</div>}
      </div>
    </div>
  );
}
