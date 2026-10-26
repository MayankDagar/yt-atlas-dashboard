CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  admin_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY,
  youtube_channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  category TEXT NOT NULL,
  state TEXT NOT NULL,
  region TEXT,
  district TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id BIGSERIAL PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  views_total BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'youtube_data_api_public',
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS metric_snapshots_channel_time_idx
  ON metric_snapshots (channel_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS metric_snapshots_expiry_idx ON metric_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS video_engagement_snapshots (
  id BIGSERIAL PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  youtube_video_id TEXT NOT NULL,
  video_title TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  likes_count BIGINT,
  comments_count BIGINT,
  shares_count BIGINT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'youtube_data_api_public',
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS video_engagement_latest_idx
  ON video_engagement_snapshots (channel_id, youtube_video_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS video_engagement_expiry_idx ON video_engagement_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS collection_jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  scope TEXT NOT NULL CHECK (scope IN ('all', 'views', 'engagement')),
  channel_ids UUID[] NOT NULL,
  channels_total INTEGER NOT NULL DEFAULT 0,
  channels_completed INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS collection_jobs_created_idx ON collection_jobs (created_at DESC);
