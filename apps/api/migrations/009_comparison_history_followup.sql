ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS follow_up_date DATE,
  ADD COLUMN IF NOT EXISTS follow_up_note TEXT;

CREATE TABLE IF NOT EXISTS channel_change_history (
  id BIGSERIAL PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changes JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS channel_change_history_channel_time_idx
  ON channel_change_history (channel_id, changed_at DESC);

CREATE OR REPLACE FUNCTION record_channel_change_history() RETURNS TRIGGER AS $$
DECLARE
  change_data JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    change_data := jsonb_build_object('created', jsonb_build_object('to', NEW.channel_name));
  ELSE
    change_data := jsonb_strip_nulls(jsonb_build_object(
      'channelName', CASE WHEN NEW.channel_name IS DISTINCT FROM OLD.channel_name THEN jsonb_build_object('from', OLD.channel_name, 'to', NEW.channel_name) END,
      'category', CASE WHEN NEW.category IS DISTINCT FROM OLD.category THEN jsonb_build_object('from', OLD.category, 'to', NEW.category) END,
      'state', CASE WHEN NEW.state IS DISTINCT FROM OLD.state THEN jsonb_build_object('from', OLD.state, 'to', NEW.state) END,
      'region', CASE WHEN NEW.region IS DISTINCT FROM OLD.region THEN jsonb_build_object('from', OLD.region, 'to', NEW.region) END,
      'district', CASE WHEN NEW.district IS DISTINCT FROM OLD.district THEN jsonb_build_object('from', OLD.district, 'to', NEW.district) END,
      'subscribers', CASE WHEN NEW.subscriber_count IS DISTINCT FROM OLD.subscriber_count THEN jsonb_build_object('from', OLD.subscriber_count, 'to', NEW.subscriber_count) END,
      'outreachStatus', CASE WHEN NEW.outreach_status IS DISTINCT FROM OLD.outreach_status THEN jsonb_build_object('from', OLD.outreach_status, 'to', NEW.outreach_status) END,
      'followUpDate', CASE WHEN NEW.follow_up_date IS DISTINCT FROM OLD.follow_up_date THEN jsonb_build_object('from', OLD.follow_up_date, 'to', NEW.follow_up_date) END
    ));
  END IF;
  IF change_data <> '{}'::jsonb THEN
    INSERT INTO channel_change_history (channel_id, changes) VALUES (NEW.id, change_data);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS channels_record_change_history ON channels;
CREATE TRIGGER channels_record_change_history
  AFTER INSERT OR UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION record_channel_change_history();
