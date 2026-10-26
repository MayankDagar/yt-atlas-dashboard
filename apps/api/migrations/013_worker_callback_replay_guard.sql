ALTER TABLE collection_jobs
  ADD COLUMN IF NOT EXISTS callback_received_at TIMESTAMPTZ;
