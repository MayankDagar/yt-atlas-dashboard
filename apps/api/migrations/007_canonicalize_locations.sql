-- Merge known Uttarakhand spelling variants and remove collector-only district labels.
UPDATE channels
SET state = 'Uttarakhand', updated_at = NOW()
WHERE lower(regexp_replace(state, '[^a-zA-Z0-9]', '', 'g')) IN ('uttrakhand', 'uttaranchal');

UPDATE channels
SET district = NULLIF(BTRIM(regexp_replace(district, '\s*\(from videos\)\s*$', '', 'i')), ''),
    updated_at = NOW()
WHERE district ~* '\s*\(from videos\)\s*$';
