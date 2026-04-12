CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    group_id        TEXT DEFAULT '',
    shift_id        TEXT DEFAULT '',
    started_at      TEXT,
    ended_at        TEXT,
    checkpoint_id   TEXT DEFAULT '',
    camera_source   TEXT DEFAULT '',
    total           INTEGER DEFAULT 0,
    ok_count        INTEGER DEFAULT 0,
    nok_no_barcode  INTEGER DEFAULT 0,
    nok_no_date     INTEGER DEFAULT 0,
    nok_anomaly     INTEGER DEFAULT 0,
    enabled_checks  TEXT DEFAULT '{"barcode":true,"date":true,"anomaly":true}'
);

-- Migration: add enabled_checks to sessions if it doesn't exist yet
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS enabled_checks TEXT DEFAULT '{"barcode":true,"date":true,"anomaly":true}';

CREATE TABLE IF NOT EXISTS defective_packets (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id),
    packet_num      INTEGER NOT NULL,
    defect_type     TEXT NOT NULL,
    crossed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_defective_session ON defective_packets (session_id);

CREATE TABLE IF NOT EXISTS shifts (
    id              TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'recurring',  -- 'recurring' | 'one_off'
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    start_date      TEXT,                               -- activation start: "YYYY-MM-DD"
    end_date        TEXT,                               -- activation end:   "YYYY-MM-DD"
    session_date    TEXT,                               -- one_off only: "YYYY-MM-DD"
    days_of_week    TEXT NOT NULL DEFAULT '[]',
    camera_source   TEXT DEFAULT '0',
    checkpoint_id   TEXT NOT NULL DEFAULT 'tracking',
    enabled_pipelines TEXT DEFAULT '["pipeline_barcode_date","pipeline_anomaly"]',
    enabled_checks  TEXT DEFAULT '{"barcode":true,"date":true,"anomaly":true}',
    active          INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL
);

-- Migration: add enabled_pipelines if it doesn't exist yet
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS enabled_pipelines TEXT DEFAULT '["pipeline_barcode_date","pipeline_anomaly"]';
-- Migration: add enabled_checks if it doesn't exist yet
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS enabled_checks TEXT DEFAULT '{"barcode":true,"date":true,"anomaly":true}';

CREATE TABLE IF NOT EXISTS shift_variants (
    id          TEXT PRIMARY KEY,
    shift_id    TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,       -- 'timing' | 'availability'
    active      INTEGER,             -- availability only: 1=enable override, 0=disable
    start_time  TEXT,                -- timing only: "HH:MM"
    end_time    TEXT,                -- timing only: "HH:MM"
    start_date  TEXT NOT NULL,
    end_date    TEXT NOT NULL,
    days_of_week TEXT NOT NULL,      -- JSON array e.g. '["mon"]'
    created_at  TEXT NOT NULL
);

-- one_off sessions are stored in the shifts table with type='one_off'
CREATE INDEX IF NOT EXISTS idx_shifts_type ON shifts (type);
CREATE INDEX IF NOT EXISTS idx_shift_variants_shift_id ON shift_variants (shift_id);

-- ── Auth users  ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_users (
    email       TEXT PRIMARY KEY,
    pw_hash     TEXT NOT NULL,       
    role        TEXT NOT NULL DEFAULT 'client',
    created_at  TEXT NOT NULL DEFAULT ''
);
-- ── Feedback  ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedbacks (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    comment     TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL DEFAULT 'bug',
    scope       TEXT NOT NULL DEFAULT 'global',
    urgency     TEXT NOT NULL DEFAULT 'medium',
    session_id  TEXT,
    user_email  TEXT,
    created_at  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks (created_at DESC);

