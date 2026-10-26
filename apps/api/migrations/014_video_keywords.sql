ALTER TABLE video_engagement_snapshots
  ADD COLUMN IF NOT EXISTS video_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS keywords_generated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS video_engagement_keywords_gin_idx
  ON video_engagement_snapshots USING GIN (keywords);
