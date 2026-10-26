ALTER TABLE collection_jobs
  ADD COLUMN IF NOT EXISTS processed_channel_ids UUID[] NOT NULL DEFAULT '{}';
