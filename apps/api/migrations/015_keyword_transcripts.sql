ALTER TABLE video_engagement_snapshots
  ADD COLUMN IF NOT EXISTS keyword_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS keyword_source TEXT,
  ADD COLUMN IF NOT EXISTS keyword_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE video_engagement_snapshots
SET keyword_status = 'ready', keyword_source = COALESCE(keyword_source, 'metadata')
WHERE keywords_generated_at IS NOT NULL AND keyword_status = 'pending';

CREATE INDEX IF NOT EXISTS video_engagement_keyword_queue_idx
  ON video_engagement_snapshots (keyword_status, keyword_updated_at)
  WHERE keywords_generated_at IS NULL;
