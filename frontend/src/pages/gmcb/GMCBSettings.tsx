import { useEffect, useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Settings, Camera, RefreshCw, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { backendApi } from "@/core/backendApi";

interface DetectedCamera {
  device: string;
  index: number;
  available: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
}

interface DetectResult {
  detected: DetectedCamera[];
  pipeline_sources: Record<string, number | string>;
}

const PIPELINE_LABELS: Record<string, string> = {
  pipeline_barcode_date: "Barcode + Date",
  pipeline_anomaly: "Détection Anomalie",
};

const GMCBSettings = () => {
  const [result, setResult] = useState<DetectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await backendApi.detectCameras();
      setResult(data);
    } catch (e) {
      setError((e as Error).message ?? "Erreur de connexion au backend");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { detect(); }, [detect]);

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
            onClick={detect}
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
                  // Find pipelines using this camera index
                  const usedBy = Object.entries(result.pipeline_sources)
                    .filter(([, src]) => src === cam.index)
                    .map(([pid]) => PIPELINE_LABELS[pid] ?? pid);

                  return (
                    <div key={cam.device} className="flex items-center gap-4 px-4 py-3 bg-background">
                      {cam.available ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{cam.device}</p>
                        {cam.available && cam.width ? (
                          <p className="text-xs text-muted-foreground">
                            {cam.width}×{cam.height} — {cam.fps} fps
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {cam.available ? "Accessible" : "Non accessible (périphérique non lisible)"}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
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
    </div>
  );
};

export default GMCBSettings;

