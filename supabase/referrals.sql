-- Run once in Supabase > SQL Editor before deploying the new player function.
-- referred_by: the player who invited this one (set from an invite link when the profile is made)
alter table players add column if not exists referred_by text;
create index if not exists players_referred_by on players (referred_by);
