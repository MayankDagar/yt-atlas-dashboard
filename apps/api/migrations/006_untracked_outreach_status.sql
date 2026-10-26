ALTER TABLE channels ALTER COLUMN outreach_status DROP DEFAULT;
ALTER TABLE channels ALTER COLUMN outreach_status DROP NOT NULL;
UPDATE channels SET outreach_status = NULL WHERE outreach_status = 'not_contacted';
