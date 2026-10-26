-- Fixes tiers that a picture-only save reset to Ember (Oct 2026). Run once in Supabase > SQL Editor.
-- Same thresholds as the player function's tierFor.
update players set tier = case
  when rp >= 5000 then 'Legend' when rp >= 500 then 'Champion' when rp >= 300 then 'Inferno'
  when rp >= 150 then 'Blaze' when rp >= 50 then 'Flame' else 'Ember' end
where month = to_char(now(), 'YYYY-MM');

-- See who it touched (run before the update to preview):
-- select username, rp, tier from players where month = to_char(now(), 'YYYY-MM') and tier = 'Ember' and rp >= 50 order by rp desc;
