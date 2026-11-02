-- Monthly standings: the leaderboard only holds the current month, so each player's final score is saved here when
-- their month rolls over (the player function does it). Podium badges for the top 3 are handed out from this.
-- Run once in Supabase > SQL Editor.
create table if not exists month_results (
  month text not null,           -- 'YYYY-MM'
  player text not null,          -- players.id
  username text,
  rp integer not null default 0,
  tier text,
  place integer,                 -- 1, 2 or 3 once the Podium badges are handed out
  saved_at timestamptz not null default now(),
  primary key (month, player)
);
alter table month_results enable row level security; -- only the player function (service role) reads and writes it

-- October 2026, handed out by hand (its scores were already replaced by November ones)
update players set awards = (select array_agg(distinct a) from unnest(coalesce(awards, '{}') || array['podium', 'podium1']) a) where lower(username) = 'bkmoonrock';
update players set awards = (select array_agg(distinct a) from unnest(coalesce(awards, '{}') || array['podium', 'podium2']) a) where lower(username) = 'chip';
update players set awards = (select array_agg(distinct a) from unnest(coalesce(awards, '{}') || array['podium', 'podium3']) a) where lower(username) = 'gwydoboy125';
insert into app_kv (key, value) values ('podium:2026-10', '{"by":"hand"}') on conflict (key) do nothing;

select username, awards from players where lower(username) in ('bkmoonrock', 'chip', 'gwydoboy125');
