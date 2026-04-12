export const PRODUCTION_CADENCE = 75;

/** Use empty string so MJPEG video feed goes through nginx (works from any client machine). */
const BACKEND_HOST = "";

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
  enabled_pipelines?: string;  // JSON string e.g. '["pipeline_barcode_date"]'
  enabled_checks?: string;     // JSON string e.g. '{"barcode":true,"date":true,"anomaly":true}'
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
  enabled_pipelines?: string[];  // e.g. ["pipeline_barcode_date", "pipeline_anomaly"]
  enabled_checks?: { barcode: boolean; date: boolean; anomaly: boolean };
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
  enabled_pipelines?: string[];
  enabled_checks?: { barcode: boolean; date: boolean; anomaly: boolean };
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
  enabled_checks?: string; // JSON string
  created_at: string;
}

export interface CreateOneOffPayload {
  label: string;
  date: string;
  start_time: string;
  end_time: string;
  camera_source?: string;
  checkpoint_id?: string;
  enabled_checks?: { barcode: boolean; date: boolean; anomaly: boolean };
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

  startAll(sources?: Record<string, string | number>, enabledPipelines?: string[], enabledChecks?: { barcode: boolean; date: boolean; anomaly: boolean }) {
    const body: Record<string, unknown> = {};
    if (sources) body.sources = sources;
    if (enabledPipelines) body.enabled_pipelines = enabledPipelines;
    if (enabledChecks) body.enabled_checks = enabledChecks;
    return request("POST", "/start", Object.keys(body).length ? body : undefined);
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
  deleteSession(sessionId: string) {
    return request("DELETE", `/stats/session/${sessionId}`);
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

// ─── Feedback endpoints ───────────────────────────────────────────────────────

export const feedbackApi = {
  create(payload: { title: string; comment: string; type: string; scope: string; urgency: string; sessionId?: string | null; screenshot?: File | null }) {
    const token = localStorage.getItem("auth_token");
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    if (payload.screenshot) {
      const fd = new FormData();
      fd.append("title", payload.title);
      fd.append("comment", payload.comment);
      fd.append("type", payload.type);
      fd.append("scope", payload.scope);
      fd.append("urgency", payload.urgency);
      if (payload.sessionId) fd.append("sessionId", payload.sessionId);
      fd.append("screenshot", payload.screenshot);
      return fetch(`${BASE}/feedback`, { method: "POST", headers, body: fd }).then((r) => {
        if (!r.ok) throw new Error(`POST /feedback → ${r.status}`);
        return r.json();
      });
    }

    return fetch(`${BASE}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }).then((r) => {
      if (!r.ok) throw new Error(`POST /feedback → ${r.status}`);
      return r.json();
    });
  },

  list(limit = 200) {
    const token = localStorage.getItem("auth_token");
    return fetch(`${BASE}/feedback?limit=${limit}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then((r) => {
      if (!r.ok) throw new Error(`GET /feedback → ${r.status}`);
      return r.json() as Promise<{ feedbacks: any[] }>;
    });
  },

  mine() {
    const token = localStorage.getItem("auth_token");
    return fetch(`${BASE}/feedback/mine`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then((r) => {
      if (!r.ok) throw new Error(`GET /feedback/mine → ${r.status}`);
      return r.json() as Promise<{ feedbacks: any[] }>;
    });
  },

  screenshotUrl(feedbackId: number) {
    const token = localStorage.getItem("auth_token");
    // Append token as query param since browser img src doesn't support custom headers
    return `${BASE}/feedback/${feedbackId}/screenshot?t=${encodeURIComponent(token ?? "")}`;
  },

  respond(feedbackId: number, response: string) {
    const token = localStorage.getItem("auth_token");
    return fetch(`${BASE}/feedback/${feedbackId}/response`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ response }),
    }).then((r) => {
      if (!r.ok) throw new Error(`POST /feedback/${feedbackId}/response → ${r.status}`);
      return r.json();
    });
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

  // Video feed URL — optional token forces the browser to reconnect the MJPEG stream.
  videoFeedUrl: (refreshToken?: number | string) =>
    `/video_feed?fps=30${refreshToken !== undefined ? `&t=${encodeURIComponent(String(refreshToken))}` : ""}`,

  // Camera config (from tracking_config) + live device probe
  listCameras: (): Promise<{ cameras: Array<{ id: string; label: string; source: number | string }> }> =>
    request("GET", "/cameras"),
  detectCameras: (): Promise<{
    detected: Array<{
      device: string;
      index: number;
      available: boolean;
      in_use: boolean;
      width: number | null;
      height: number | null;
      fps: number | null;
      reader_fps: number | null;
    }>;
    pipeline_sources: Record<string, number | string>;
  }> => request("GET", "/cameras/detect"),

  // Camera assignment overrides
  getCameraAssignments: (): Promise<{ assignments: Record<string, number | string> }> =>
    request("GET", "/cameras/assignments"),
  setCameraAssignments: (assignments: Record<string, number | string>): Promise<{
    assignments: Record<string, number | string>;
    restarted: string[];
  }> => request("POST", "/cameras/assignments", { assignments }),

  // Session crossings
  getCrossings: (sessionId: string, limit = 10) => statsApi.getCrossings(sessionId, limit),

  // Session history
  getSessions: (limit = 100) => statsApi.sessions(limit),

  // Single session
  getSession: (id: string) => statsApi.getSession(id),

  // Delete a stats session
  deleteSession: (id: string) => statsApi.deleteSession(id),

  // Proof image URL (not a fetch — just a URL string)
  proofImageUrl: (sessionId: string, defectType: string, packetNum: number) =>
    `${BASE}/proof/${sessionId}/${defectType}/${packetNum}`,

  // Manual session control
  startAll: (sources?: Record<string, string | number>, enabledPipelines?: string[], enabledChecks?: { barcode: boolean; date: boolean; anomaly: boolean }) => pipelinesApi.startAll(sources, enabledPipelines, enabledChecks),
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

  // ── Feedback ──────────────────────────────────────────────────────────────
  submitFeedback: (payload: { title: string; comment: string; type: string; scope: string; urgency: string; sessionId?: string | null; screenshot?: File | null }) =>
    feedbackApi.create(payload),
  listFeedbacks: (limit = 200) => feedbackApi.list(limit),
  listMyFeedbacks: () => feedbackApi.mine(),
  feedbackScreenshotUrl: (id: number) => feedbackApi.screenshotUrl(id),
  respondToFeedback: (id: number, response: string) => feedbackApi.respond(id, response),
};
