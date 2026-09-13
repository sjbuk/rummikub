-- Game server tables. All access goes through Edge Functions using the
-- service role; RLS is enabled with no permissive policies, so direct
-- anon/authenticated table access is denied. Room codes are the capability
-- (same trust model as the P2P lobby: public rooms listed, private by code).

create table public.rooms (
  code text primary key check (code ~ '^[A-Z2-9]{5}$'),
  host_name text not null,
  is_public boolean not null default true,
  preset text not null default 'classic'
    check (preset in ('small', 'classic', 'large')),
  phase text not null default 'lobby'
    check (phase in ('lobby', 'playing', 'gameover')),
  winner_seat integer null,
  created_at bigint not null,
  last_activity_at bigint not null
);

create table public.seats (
  room_code text not null references public.rooms (code) on delete cascade,
  seat integer not null check (seat between 0 and 3),
  name text not null,
  connected boolean not null default true,
  hand jsonb not null default '[]'::jsonb,
  has_melded boolean not null default false,
  primary key (room_code, seat)
);
create index seats_room_idx on public.seats (room_code);

create table public.games (
  room_code text primary key references public.rooms (code) on delete cascade,
  board jsonb not null default '[]'::jsonb,
  pool jsonb not null default '[]'::jsonb,
  turn_seat integer not null default 0
);

alter table public.rooms enable row level security;
alter table public.seats enable row level security;
alter table public.games enable row level security;
-- Intentionally no policies: functions bypass RLS with the service role.
