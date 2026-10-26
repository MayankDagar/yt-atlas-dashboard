UPDATE channels
SET state = CASE regexp_replace(lower(BTRIM(state)), '[^a-z0-9]', '', 'g')
  WHEN 'andhrapradesh' THEN 'Andhra Pradesh'
  WHEN 'arunachalpradesh' THEN 'Arunachal Pradesh'
  WHEN 'assam' THEN 'Assam'
  WHEN 'bihar' THEN 'Bihar'
  WHEN 'chhattisgarh' THEN 'Chhattisgarh'
  WHEN 'goa' THEN 'Goa'
  WHEN 'gujarat' THEN 'Gujarat'
  WHEN 'haryana' THEN 'Haryana'
  WHEN 'himachalpradesh' THEN 'Himachal Pradesh'
  WHEN 'jharkhand' THEN 'Jharkhand'
  WHEN 'karnataka' THEN 'Karnataka'
  WHEN 'kerala' THEN 'Kerala'
  WHEN 'madhyapradesh' THEN 'Madhya Pradesh'
  WHEN 'maharashtra' THEN 'Maharashtra'
  WHEN 'manipur' THEN 'Manipur'
  WHEN 'meghalaya' THEN 'Meghalaya'
  WHEN 'mizoram' THEN 'Mizoram'
  WHEN 'nagaland' THEN 'Nagaland'
  WHEN 'odisha' THEN 'Odisha'
  WHEN 'orissa' THEN 'Odisha'
  WHEN 'punjab' THEN 'Punjab'
  WHEN 'rajasthan' THEN 'Rajasthan'
  WHEN 'sikkim' THEN 'Sikkim'
  WHEN 'tamilnadu' THEN 'Tamil Nadu'
  WHEN 'telangana' THEN 'Telangana'
  WHEN 'tripura' THEN 'Tripura'
  WHEN 'uttarpradesh' THEN 'Uttar Pradesh'
  WHEN 'uttarakhand' THEN 'Uttarakhand'
  WHEN 'uttrakhand' THEN 'Uttarakhand'
  WHEN 'uttaranchal' THEN 'Uttarakhand'
  WHEN 'westbengal' THEN 'West Bengal'
  WHEN 'andamanandnicobarislands' THEN 'Andaman and Nicobar Islands'
  WHEN 'andamannicobarislands' THEN 'Andaman and Nicobar Islands'
  WHEN 'andamanandnicobar' THEN 'Andaman and Nicobar Islands'
  WHEN 'andamannicobar' THEN 'Andaman and Nicobar Islands'
  WHEN 'anislands' THEN 'Andaman and Nicobar Islands'
  WHEN 'chandigarh' THEN 'Chandigarh'
  WHEN 'dadranagarhavelianddamananddiu' THEN 'Dadra and Nagar Haveli and Daman and Diu'
  WHEN 'dadranagarhavelianddamandiu' THEN 'Dadra and Nagar Haveli and Daman and Diu'
  WHEN 'dadranagarhaveli' THEN 'Dadra and Nagar Haveli and Daman and Diu'
  WHEN 'damananddiu' THEN 'Dadra and Nagar Haveli and Daman and Diu'
  WHEN 'delhi' THEN 'Delhi'
  WHEN 'nctdelhi' THEN 'Delhi'
  WHEN 'nctofdelhi' THEN 'Delhi'
  WHEN 'nationalcapitalterritoryofdelhi' THEN 'Delhi'
  WHEN 'jammuandkashmir' THEN 'Jammu and Kashmir'
  WHEN 'jammukashmir' THEN 'Jammu and Kashmir'
  WHEN 'jk' THEN 'Jammu and Kashmir'
  WHEN 'ladakh' THEN 'Ladakh'
  WHEN 'lakshadweep' THEN 'Lakshadweep'
  WHEN 'puducherry' THEN 'Puducherry'
  WHEN 'pondicherry' THEN 'Puducherry'
  ELSE BTRIM(state)
END,
updated_at = NOW()
WHERE regexp_replace(lower(BTRIM(state)), '[^a-z0-9]', '', 'g') IN (
  'andhrapradesh', 'arunachalpradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana',
  'himachalpradesh', 'jharkhand', 'karnataka', 'kerala', 'madhyapradesh', 'maharashtra', 'manipur',
  'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan', 'sikkim', 'tamilnadu',
  'telangana', 'tripura', 'uttarpradesh', 'uttarakhand', 'uttrakhand', 'uttaranchal', 'westbengal',
  'andamanandnicobarislands', 'andamannicobarislands', 'andamanandnicobar', 'andamannicobar', 'anislands',
  'chandigarh', 'dadranagarhavelianddamananddiu', 'dadranagarhavelianddamandiu', 'dadranagarhaveli',
  'damananddiu', 'delhi', 'nctdelhi', 'nctofdelhi', 'nationalcapitalterritoryofdelhi', 'jammuandkashmir',
  'jammukashmir', 'jk', 'ladakh', 'lakshadweep', 'puducherry', 'pondicherry'
);
