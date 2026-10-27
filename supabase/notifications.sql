-- Emberline notifications (1v1 invites, new followers) and phone alerts. Run once in Supabase > SQL Editor,
-- BEFORE deploying the player function that uses them. Only the player function (service role) touches these tables.
create table if not exists notes (
  id bigint generated always as identity primary key,
  player text not null,            -- who gets it
  kind text not null,              -- 'invite' or 'follow'
  from_id text,
  from_name text,
  data jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notes_player_time on notes (player, created_at desc);
alter table notes enable row level security;   -- no policies: the app can't read these directly

create table if not exists push_subs (           -- phones that get lock-screen alerts
  endpoint text primary key,
  player text not null,
  sub jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_player on push_subs (player);
alter table push_subs enable row level security;

create table if not exists push_links (          -- 6-character codes that connect the Alerts app to a profile (15 minutes)
  code text primary key,
  player text not null,
  until timestamptz not null
);
alter table push_links enable row level security;

create table if not exists app_kv (               -- the push keys, made by the function the first time
  key text primary key,
  value jsonb
);
alter table app_kv enable row level security;

-- Old notifications: delete anything older than 30 days now and then
-- delete from notes where created_at < now() - interval '30 days';
