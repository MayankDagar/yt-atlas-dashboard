ALTER TABLE video_engagement_snapshots
  ADD COLUMN IF NOT EXISTS keyword_algorithm_version SMALLINT NOT NULL DEFAULT 1;
