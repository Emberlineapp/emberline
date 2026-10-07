-- Run once in Supabase > SQL Editor before deploying the new player function.
-- rp_day / rp_day_base: RP when today (UTC) started, for the 1000 RP a day limit
-- locked_until: locked out of ranked until this time
alter table players add column if not exists rp_day text;
alter table players add column if not exists rp_day_base integer default 0;
alter table players add column if not exists locked_until timestamptz;
