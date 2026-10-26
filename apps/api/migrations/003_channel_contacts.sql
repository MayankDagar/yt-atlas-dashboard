ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS contact_details JSONB NOT NULL DEFAULT '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb;
