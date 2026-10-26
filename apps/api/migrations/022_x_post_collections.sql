CREATE TABLE IF NOT EXISTS x_post_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topics TEXT[] NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  max_items INTEGER NOT NULL CHECK (max_items BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  topics_total INTEGER NOT NULL CHECK (topics_total > 0),
  topics_completed INTEGER NOT NULL DEFAULT 0 CHECK (topics_completed >= 0),
  posts_saved INTEGER NOT NULL DEFAULT 0 CHECK (posts_saved >= 0),
  topic_progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_summary TEXT,
  actor_run_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CHECK (start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS x_post_collections_created_idx
  ON x_post_collections (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS x_post_collections_one_active_idx
  ON x_post_collections ((TRUE))
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS x_posts (
  post_id TEXT PRIMARY KEY,
  post_url TEXT NOT NULL,
  post_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ,
  language TEXT,
  author_id TEXT,
  author_name TEXT,
  author_handle TEXT,
  author_url TEXT,
  likes_count BIGINT CHECK (likes_count IS NULL OR likes_count >= 0),
  reposts_count BIGINT CHECK (reposts_count IS NULL OR reposts_count >= 0),
  replies_count BIGINT CHECK (replies_count IS NULL OR replies_count >= 0),
  quotes_count BIGINT CHECK (quotes_count IS NULL OR quotes_count >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x_posts_created_idx ON x_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS x_posts_author_idx ON x_posts (author_handle);

CREATE TABLE IF NOT EXISTS x_post_collection_results (
  collection_id UUID NOT NULL REFERENCES x_post_collections(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES x_posts(post_id) ON DELETE CASCADE,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, topic, post_id)
);

CREATE INDEX IF NOT EXISTS x_post_collection_results_post_idx
  ON x_post_collection_results (collection_id, post_id);
