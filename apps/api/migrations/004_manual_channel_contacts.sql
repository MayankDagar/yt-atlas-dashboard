ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS manual_contact_details JSONB,
  ADD COLUMN IF NOT EXISTS manual_contact_details_observed_at TIMESTAMPTZ;

-- Old versions populated this field from video descriptions, which often
-- contained unrelated redirect links. Contact details are now admin managed.
UPDATE channels
SET contact_details = '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb
WHERE contact_details IS DISTINCT FROM '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb;
