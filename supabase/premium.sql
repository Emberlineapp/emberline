-- Emberline Premium. Run once in Supabase > SQL Editor, BEFORE deploying the new player function.
alter table players add column if not exists banner text;

-- For a set time, use "premium:YYYY-MM-DD" (Premium through that day, then it turns off by itself), e.g. premium:2026-11-26
-- Give someone Premium after they pay in their Discord ticket. Easiest: Table Editor > players > their row > awards, add "premium"
-- the same way you hand out bughunter. Or with SQL (change the username). If awards is a text[] column:
-- update players set awards = array_append(coalesce(awards, '{}'), 'premium') where username ilike 'their_username' and not ('premium' = any(coalesce(awards, '{}')));

-- If awards is a jsonb column instead:
-- update players set awards = coalesce(awards, '[]'::jsonb) || '["premium"]'::jsonb where username ilike 'their_username' and not coalesce(awards, '[]'::jsonb) ? 'premium';

-- Take it away (text[]):
-- update players set awards = array_remove(awards, 'premium') where username ilike 'their_username';

-- Everyone with Premium:
-- select username, awards from players where 'premium' = any(awards);

-- One month for Evin_guti03 (through Nov 26, 2026). text[] awards:
-- update players set awards = array_append(coalesce(awards, '{}'), 'premium:2026-11-26') where username ilike 'Evin\_guti03';
-- jsonb awards:
-- update players set awards = coalesce(awards, '[]'::jsonb) || '["premium:2026-11-26"]'::jsonb where username ilike 'Evin\_guti03';
