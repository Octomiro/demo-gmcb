import { useEffect, useState, useCallback, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Settings, Camera, RefreshCw, CheckCircle2, XCircle, AlertCircle, Activity, WifiOff, ArrowLeftRight, Save } from "lucide-react";
import { backendApi } from "@/core/backendApi";

interface DetectedCamera {
  device: string;
  index: number;
  available: boolean;
  in_use: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  reader_fps: number | null;
  camera_reconnecting?: boolean;
  camera_bw_mbps?: number | null;
}

interface DetectResult {
  detected: DetectedCamera[];
  pipeline_sources: Record<string, number | string>;
}

const PIPELINE_LABELS: Record<string, string> = {
  pipeline_barcode_date: "Barcode & Date",
  pipeline_anomaly: "Détection Anomalie",
};

const GMCBSettings = () => {
  const [result, setResult] = useState<DetectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Camera assignment state
  const [assignments, setAssignments] = useState<Record<string, number | string>>({});
  const [assignDraft, setAssignDraft] = useState<Record<string, number | string>>({});
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignSuccess, setAssignSuccess] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const detect = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await backendApi.detectCameras();
      setResult(data);
    } catch (e) {
      setError((e as Error).message ?? "Erreur de connexion au backend");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Auto-refresh every 2 s when any camera is in use (to show live reader fps)
  useEffect(() => {
    detect();
    // Load current assignments on mount
    backendApi.getCameraAssignments().then((r) => {
      setAssignments(r.assignments);
      setAssignDraft(r.assignments);
    }).catch(() => {});
  }, [detect]);

  useEffect(() => {
    const hasInUse = result?.detected.some((c) => c.in_use) ?? false;
    const hasReconnecting = result?.detected.some((c) => c.camera_reconnecting) ?? false;
    if (hasInUse || hasReconnecting) {
      intervalRef.current = setInterval(() => detect(true), 2000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [detect, result]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-xl bg-primary">
          <Settings className="w-6 h-6 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Paramètres</h1>
          <p className="text-muted-foreground">Configuration du module GMCB</p>
        </div>
      </div>

      {/* Camera detection card */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Camera className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Caméras USB détectées</h2>
          </div>
          <button
            onClick={() => detect()}
            disabled={loading}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Rafraîchir
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {loading && !result && (
          <p className="text-sm text-muted-foreground">Sonde en cours…</p>
        )}

        {result && (
          <>
            {result.detected.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun périphérique /dev/video* trouvé dans le conteneur.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                {result.detected.map((cam) => {
                  const usedBy = Object.entries(result.pipeline_sources)
                    .filter(([, src]) => src === cam.index)
                    .map(([pid]) => PIPELINE_LABELS[pid] ?? pid);

                  return (
                    <div key={cam.device} className="flex items-start gap-4 px-4 py-3 bg-background">
                      {cam.camera_reconnecting ? (
                        <WifiOff className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
                      ) : cam.available ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{cam.device}</p>
                        {cam.camera_reconnecting ? (
                          <p className="text-xs text-orange-500 flex items-center gap-1 mt-0.5">
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            USB déconnecté — reconnexion en cours…
                          </p>
                        ) : cam.available && cam.width ? (
                          <>
                            <p className="text-xs text-muted-foreground">
                              {cam.width}×{cam.height}
                              {cam.in_use && cam.reader_fps != null && cam.reader_fps > 0 ? (
                                <span className="ml-2 inline-flex items-center gap-1 font-semibold text-green-600">
                                  <Activity className="w-3 h-3" />
                                  {cam.reader_fps} fps (reader live)
                                </span>
                              ) : cam.fps != null ? (
                                <span className="ml-2">{cam.fps} fps (négocié)</span>
                              ) : null}
                              {cam.camera_bw_mbps != null && (
                                <span className={`ml-2 font-semibold ${cam.camera_bw_mbps > 300 ? "text-orange-500" : "text-blue-500"}`}>
                                  · {cam.camera_bw_mbps} Mbps USB
                                  {cam.camera_bw_mbps > 300 && " ⚠"}
                                </span>
                              )}
                            </p>
                            {cam.in_use && (
                              <p className="text-xs text-primary mt-0.5">En cours d'utilisation par le pipeline</p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {cam.available ? "Accessible" : "Non connectée ou non lisible"}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0 space-y-1">
                        {usedBy.length > 0 ? (
                          usedBy.map((label) => (
                            <span key={label} className="inline-block ml-1 text-xs bg-primary/10 text-primary rounded-full px-2 py-0.5">
                              {label}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">Non utilisée</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pipeline → source mapping summary */}
            <div className="mt-2 space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sources configurées par pipeline</p>
              {Object.entries(result.pipeline_sources).map(([pid, src]) => (
                <div key={pid} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">{PIPELINE_LABELS[pid] ?? pid}</span>
                  <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">
                    {typeof src === "number" ? `/dev/video${src}` : String(src)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Camera assignment card */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Assignation caméras ↔ pipelines</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Si les caméras sont inversées, réassignez chaque pipeline à la bonne source physique. La configuration est persistée et survivra aux redémarrages.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {Object.entries(PIPELINE_LABELS).map(([pid, label]) => {
            const currentSrc = assignDraft[pid] ?? assignments[pid];
            const availableDevices = result?.detected.filter((c) => c.available || c.in_use) ?? [];
            return (
              <div key={pid} className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-[180px]">
                  <Camera className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium">{label}</span>
                </div>
                <select
                  value={String(currentSrc ?? "")}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setAssignDraft((d) => ({ ...d, [pid]: isNaN(Number(raw)) ? raw : Number(raw) }));
                  }}
                  className="border border-border rounded-lg px-3 py-1.5 text-sm bg-background text-foreground flex-1 min-w-[180px]"
                >
                  {currentSrc !== undefined && !availableDevices.some((d) => String(d.index) === String(currentSrc) || d.device === String(currentSrc)) && (
                    <option value={String(currentSrc)}>{typeof currentSrc === "number" ? `/dev/video${currentSrc}` : String(currentSrc)} (actuel)</option>
                  )}
                  {availableDevices.map((cam) => (
                    <option key={cam.device} value={String(cam.index)}>
                      {cam.device}{cam.width ? ` — ${cam.width}×${cam.height}` : ""}{cam.in_use ? " (en cours)" : ""}
                    </option>
                  ))}
                  {availableDevices.length === 0 && (
                    <option value="">— Rafraîchir pour voir les caméras —</option>
                  )}
                </select>
              </div>
            );
          })}
        </div>

        {assignError && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {assignError}
          </div>
        )}
        {assignSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Assignation appliquée — les pipelines ont été redémarrés sur les nouvelles caméras.
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            disabled={assignSaving}
            onClick={async () => {
              setAssignSaving(true);
              setAssignError(null);
              setAssignSuccess(false);
              try {
                const r = await backendApi.setCameraAssignments(assignDraft);
                setAssignments(r.assignments);
                setAssignDraft(r.assignments);
                setAssignSuccess(true);
                setTimeout(() => setAssignSuccess(false), 4000);
                detect(true);
              } catch (e) {
                setAssignError((e as Error).message ?? "Erreur lors de l'application");
              } finally {
                setAssignSaving(false);
              }
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
          >
            {assignSaving
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <Save className="w-4 h-4" />}
            Appliquer l'assignation
          </button>
          <button
            disabled={assignSaving}
            onClick={() => setAssignDraft(assignments)}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Annuler
          </button>
        </div>
      </Card>
    </div>
  );
};

export default GMCBSettings;

