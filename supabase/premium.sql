-- Emberline Premium. Run once in Supabase > SQL Editor, BEFORE deploying the new player function.
alter table players add column if not exists banner text;

-- Give someone Premium after they pay in their Discord ticket. Easiest: Table Editor > players > their row > awards, add "premium"
-- the same way you hand out bughunter. Or with SQL (change the username). If awards is a text[] column:
-- update players set awards = array_append(coalesce(awards, '{}'), 'premium') where username ilike 'their_username' and not ('premium' = any(coalesce(awards, '{}')));

-- If awards is a jsonb column instead:
-- update players set awards = coalesce(awards, '[]'::jsonb) || '["premium"]'::jsonb where username ilike 'their_username' and not coalesce(awards, '[]'::jsonb) ? 'premium';

-- Take it away (text[]):
-- update players set awards = array_remove(awards, 'premium') where username ilike 'their_username';

-- Everyone with Premium:
-- select username, awards from players where 'premium' = any(awards);
