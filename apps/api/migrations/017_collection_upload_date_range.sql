ALTER TABLE collection_jobs
  ADD COLUMN IF NOT EXISTS published_after DATE,
  ADD COLUMN IF NOT EXISTS published_before DATE;
