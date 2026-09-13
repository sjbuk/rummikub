-- Live spectator draft: the turn holder's in-progress arrangement,
-- published while arranging and cleared on commit/draw.
alter table public.games add column draft jsonb not null default '[]'::jsonb;
