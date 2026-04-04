export const PRODUCTION_CADENCE = 75;

/** Direct backend host for resources that bypass the Vite proxy (e.g. MJPEG). */
const BACKEND_HOST =
  import.meta.env.VITE_BACKEND_HOST ?? "http://127.0.0.1:5000";

const BASE = "/api";
const REQUEST_TIMEOUT_MS = 8_000; // 8 s — abort hanging requests so they don't pile up

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Shift types (backend wire format) ───────────────────────────────────────

export interface BackendShift {
  id: string;
  label: string;
  start_time: string;      // "HH:MM"
  end_time: string;        // "HH:MM"
  start_date?: string | null; // "YYYY-MM-DD" activation start
  end_date?: string | null;   // "YYYY-MM-DD" activation end
  days_of_week: string;    // JSON string e.g. '["mon","tue"]'
  camera_source: string;
  checkpoint_id: string;
  active: number;          // 1 | 0
  created_at: string;
  variants?: BackendVariant[];
}

export interface CreateShiftPayload {
  label: string;
  start_time: string;
  end_time: string;
  start_date?: string;
  end_date?: string;
  days_of_week: string[];  // plain array — backend serialises to JSON
  camera_source?: string;
  checkpoint_id?: string;
}

export interface UpdateShiftPayload {
  label?: string;
  start_time?: string;
  end_time?: string;
  start_date?: string | null;
  end_date?: string | null;
  days_of_week?: string[];
  camera_source?: string;
  checkpoint_id?: string;
}

// ─── Shift variant types (backend wire format) ────────────────────────────────

export interface BackendVariant {
  id: string;
  shift_id: string;
  kind: "timing" | "availability";
  active?: number;       // 1=enable override, 0=disable; availability only
  start_time?: string;   // timing only
  end_time?: string;     // timing only
  start_date: string;
  end_date: string;
  days_of_week: string;  // JSON string '["mon"]'
  created_at: string;
}

export interface CreateVariantPayload {
  kind: "timing" | "availability";
  active?: number;
  start_time?: string;
  end_time?: string;
  start_date: string;
  end_date: string;
  days_of_week: string[];
}

// ─── Shifts endpoints ─────────────────────────────────────────────────────────

export const shiftsApi = {
  list(): Promise<{ shifts: BackendShift[] }> {
    return request("GET", "/shifts");
  },

  create(payload: CreateShiftPayload): Promise<{ shift: BackendShift }> {
    return request("POST", "/shifts", payload);
  },

  update(id: string, payload: UpdateShiftPayload): Promise<{ shift: BackendShift }> {
    return request("PUT", `/shifts/${id}`, payload);
  },

  delete(id: string): Promise<{ deleted: boolean }> {
    return request("DELETE", `/shifts/${id}`);
  },

  toggle(id: string): Promise<{ id: string; active: number }> {
    return request("POST", `/shifts/${id}/toggle`);
  },
};

// ─── Shift variants endpoints ─────────────────────────────────────────────────

export const variantsApi = {
  create(shiftId: string, payload: CreateVariantPayload): Promise<{ variant: BackendVariant }> {
    return request("POST", `/shifts/${shiftId}/variants`, payload);
  },

  update(shiftId: string, variantId: string, payload: Partial<CreateVariantPayload>): Promise<{ updated: boolean }> {
    return request("PUT", `/shifts/${shiftId}/variants/${variantId}`, payload);
  },

  delete(shiftId: string, variantId: string): Promise<{ deleted: boolean }> {
    return request("DELETE", `/shifts/${shiftId}/variants/${variantId}`);
  },
};

// ─── One-off sessions endpoints ───────────────────────────────────────────────

export interface BackendOneOff {
  id: string;
  label: string;
  date: string;        // "YYYY-MM-DD"
  start_time: string;  // "HH:MM"
  end_time: string;    // "HH:MM"
  camera_source: string;
  checkpoint_id: string;
  created_at: string;
}

export interface CreateOneOffPayload {
  label: string;
  date: string;
  start_time: string;
  end_time: string;
  camera_source?: string;
  checkpoint_id?: string;
}

export const oneOffApi = {
  list(): Promise<{ sessions: BackendOneOff[] }> {
    return request("GET", "/one-off-sessions");
  },

  create(payload: CreateOneOffPayload): Promise<{ session: BackendOneOff }> {
    return request("POST", "/one-off-sessions", payload);
  },

  update(id: string, payload: { start_time?: string; end_time?: string }): Promise<{ updated: boolean }> {
    return request("PUT", `/one-off-sessions/${id}`, payload);
  },

  delete(id: string): Promise<{ deleted: boolean }> {
    return request("DELETE", `/one-off-sessions/${id}`);
  },
};

// ─── Pipelines endpoints ──────────────────────────────────────────────────────

export interface BackendPipeline {
  id: string;
  label: string;
  camera_source: string;
  checkpoint_id: string;
  is_running: boolean;
  is_paused: boolean;
  stats_active: boolean;
  session_id: string | null;
  total_packets: number;
  is_active_view: boolean;
}

export const pipelinesApi = {
  list(): Promise<{ pipelines: BackendPipeline[]; active_view_id: string }> {
    return request("GET", "/pipelines");
  },

  setView(pipelineId: string): Promise<{ active_view_id: string }> {
    return request("POST", `/pipelines/${pipelineId}/view`);
  },

  start(pipelineId: string, source?: string, checkpointId?: string) {
    return request("POST", `/pipelines/${pipelineId}/start`, {
      ...(source !== undefined && { source }),
      ...(checkpointId !== undefined && { checkpoint_id: checkpointId }),
    });
  },

  stop(pipelineId: string) {
    return request("POST", `/pipelines/${pipelineId}/stop`);
  },

  startAll(sources?: Record<string, string | number>) {
    return request("POST", "/start", sources ? { sources } : undefined);
  },

  stopAll() {
    return request("POST", "/stop");
  },

  prewarm(sources?: Record<string, string | number>) {
    return request("POST", "/prewarm", sources ? { sources } : undefined);
  },

  prewarmStatus(): Promise<{ pipelines: Record<string, { is_running: boolean; stats_active: boolean }>; is_prewarmed: boolean; is_recording: boolean }> {
    return request("GET", "/prewarm/status");
  },
};

// ─── Stats endpoints ──────────────────────────────────────────────────────────

export const statsApi = {
  get() {
    return request("GET", "/stats");
  },

  toggle() {
    return request("POST", "/stats/toggle");
  },

  sessions(limit = 50) {
    return request("GET", `/stats/sessions?limit=${limit}`);
  },

  getSession(id: string) {
    return request("GET", `/stats/session/${id}`);
  },

  getCrossings(sessionId: string, limit = 10) {
    return request("GET", `/stats/session/${sessionId}/crossings?limit=${limit}`);
  },
  getHourlyStats(sessionId: string) {
    return request("GET", `/stats/session/${sessionId}/hourly`);
  },
};

// ─── Pipeline stats ───────────────────────────────────────────────────────────

export const pipelineStatsApi = {
  get(pipelineId: string) {
    return request("GET", `/pipelines/${pipelineId}/stats`);
  },
};

// ─── Exit-line endpoints ──────────────────────────────────────────────────────

export const exitLineApi = {
  toggle(): Promise<{ enabled: boolean }> {
    return request("POST", "/exit_line");
  },
  toggleOrientation(): Promise<{ vertical: boolean; orientation: string }> {
    return request("POST", "/exit_line_orientation");
  },
  toggleInvert(): Promise<{ inverted: boolean }> {
    return request("POST", "/exit_line_invert");
  },
  setPosition(pct: number): Promise<{ position_pct: number; exit_line_y: number }> {
    return request("POST", "/exit_line_position", { position: pct });
  },
};

// ─── Convenience facade ───────────────────────────────────────────────────────
// Single object for consumer pages so they can call backendApi.* uniformly.

export const backendApi = {
  // Pipeline stats
  getPipelineStats: (pipelineId: string) => pipelineStatsApi.get(pipelineId),

  // Pipelines list / active view
  listPipelines: () => pipelinesApi.list(),

  // Switch active video feed
  switchView: (pipelineId: string) => pipelinesApi.setView(pipelineId),

  // Video feed URL — direct to Flask backend (bypasses Vite proxy for lower latency)
  videoFeedUrl: () => `/video_feed`,

  // Camera config (from tracking_config) + live device probe
  listCameras: (): Promise<{ cameras: Array<{ id: string; label: string; source: number | string }> }> =>
    request("GET", "/cameras"),
  detectCameras: (): Promise<{
    detected: Array<{ device: string; index: number; available: boolean; width: number | null; height: number | null; fps: number | null }>;
    pipeline_sources: Record<string, number | string>;
  }> => request("GET", "/cameras/detect"),

  // Session crossings
  getCrossings: (sessionId: string, limit = 10) => statsApi.getCrossings(sessionId, limit),

  // Session hourly stats
  getHourlyStats: (sessionId: string) => statsApi.getHourlyStats(sessionId),

  // Session history
  getSessions: (limit = 100) => statsApi.sessions(limit),

  // Single session
  getSession: (id: string) => statsApi.getSession(id),

  // Proof image URL (not a fetch — just a URL string)
  proofImageUrl: (sessionId: string, defectType: string, packetNum: number) =>
    `${BASE}/proof/${sessionId}/${defectType}/${packetNum}`,

  // Manual session control
  startAll: () => pipelinesApi.startAll(),
  stopAll: () => pipelinesApi.stopAll(),
  toggleRecording: () => statsApi.toggle(),
  prewarm: () => pipelinesApi.prewarm(),
  prewarmStatus: () => pipelinesApi.prewarmStatus(),
  resetSessionGuard: () => request<{ reset: boolean; previous_source: string | null }>("POST", "/session/reset-guard"),
  sessionStatus: () => request<{ active: boolean; source: string | null; guard_stale: boolean; any_running: boolean; any_recording: boolean }>("GET", "/session/status"),

  // Auto-stop scheduling
  scheduleStop: (stopAt: string | null) => request<{ scheduled_stop: string | null }>("POST", "/session/schedule-stop", { stop_at: stopAt }),
  getScheduledStop: () => request<{ scheduled_stop: string | null }>("GET", "/session/schedule-stop"),

  // Exit line controls
  exitLineToggle: () => exitLineApi.toggle(),
  exitLineOrientation: () => exitLineApi.toggleOrientation(),
  exitLineInvert: () => exitLineApi.toggleInvert(),
  exitLinePosition: (pct: number) => exitLineApi.setPosition(pct),

  // ── Local JWT Auth ──────────────────────────────────────────────────────────
  login: (email: string, password: string) =>
    request<{ token: string; email: string; role: string }>("POST", "/auth/login", { email, password }),

  authMe: async (): Promise<{ email: string; role: string } | null> => {
    const token = localStorage.getItem("auth_token");
    if (!token) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};
