ALTER TABLE video_engagement_snapshots
  DROP COLUMN IF EXISTS transcript_job_id;

UPDATE video_engagement_snapshots
SET keyword_status = 'pending', keyword_updated_at = NOW()
WHERE keywords_generated_at IS NULL
  AND keyword_status IN ('needs_transcript', 'transcribing');
