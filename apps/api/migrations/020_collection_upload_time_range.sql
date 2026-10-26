ALTER TABLE collection_jobs
  ADD COLUMN IF NOT EXISTS published_after_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_before_at TIMESTAMPTZ;
