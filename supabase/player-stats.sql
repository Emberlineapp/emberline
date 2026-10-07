-- Run once in Supabase > SQL Editor before deploying the new player function.
-- stats: profile numbers the app sends (sessions, hits, best hit, days dabbed this month, all-time blinkers)
alter table players add column if not exists stats jsonb;
