# Game server (Supabase) — design and contract

Status: implemented and wired up — `server/` core, Supabase migrations,
10 Edge Functions (rooms-*, game-*, rooms-state polling read, game-draft
spectator stream), and the web client in `src/` plays through them (2–4
seats, preset-sized boards, ~1 s state polling, live spectator board,
server-validated commits). Setup and deploy steps:
see `server/README.md`.

## Decisions (agreed)

- Authoritative server: deals, validates turns, advances turns, detects wins.
- 2–4 seats per room; host (seat 0) starts; turn passes in seat order.
- Fixed board-size presets chosen at room creation; same 106-tile deck and
  rules on every preset.
- Persist rooms plus live game state so players can refresh/rejoin mid-game.
- No authentication; public/private rooms behave like today's lobby.
- Fully automatic deployment to a new linked Supabase project via CLI + CI.

## Architecture

- Postgres tables: `rooms` (code, public flag, board preset, phase,
  `lastActivityAt`), `seats` (room, seat index, display name, connected),
  `games` (board, pool, turn pointer, meld flags, `winnerId`).
- Ten Edge Functions (Deno/TypeScript): `rooms-create`, `rooms-join`,
  `rooms-leave`, `game-start` (deal), `game-commit` (validate), `game-draw`,
  `game-draft` (live spectator draft), `rooms-list` (lobby), `rooms-state`
  (polling read), `rooms-cleanup`. All but the two reads are the only writers.
- Reads: room/game rows directly (pollable) plus Realtime subscription for
  live updates. Clients never write game state; RLS reflects that.
- Shared logic, not forked: functions import `src/game/rules.ts`
  (`buildDeck`, `validateTurn`, `HAND_SIZE 14`, `INITIAL_MELD_MIN 30`) and
  `src/game/types.ts` so meld, turn, and win semantics cannot drift.

## Board presets (proposed defaults)

| Preset  | Grid  | Notes                                   |
|---------|-------|-----------------------------------------|
| small   | 12×4  | Tighter table, same deck and rules      |
| classic | 18×6  | Matches today's `GRID_COLS`/`GRID_ROWS` |
| large   | 24×8  | Headroom for 4-player late games        |

Preset is fixed at `rooms-create`; the server rejects placements outside it.

## Turn flow

1. `game-start`: server shuffles `buildDeck()`, deals 14 tiles per seated
   player (2×14, 3×14, or 4×14 from the 106-tile deck), sets host first.
2. `game-commit`: server runs `validateTurn` (initial-meld 30+ with
   no-board-rearrangement rule pre-meld; full-board validity after), updates
   board/hands, declares winner on empty rack, advances turn in seat order.
3. `game-draw`: server pops the pool; on an empty pool the draw is a no-op
   and the turn still advances (no hangs — cf. `docs/code-review.md` §7).
4. Every mutation refreshes `lastActivityAt`; disconnects mark seats
   disconnected without destroying the game (rejoin by room code).

## Public / private parity

Mirrors `src/net/lobby.ts`: public rooms are listable (heartbeat-style
`lastActivityAt`, TTL pruning); private rooms are code-only and never listed.
Room codes keep today's 5-letter shape (`randomCode` alphabet).

## Deployment (automatic)

- `supabase/` holds `config.toml`, SQL migrations, and the ten functions.
- One command deploys everything to the linked project:
  `supabase db push` + `supabase functions deploy` (wrapped as
  `npm run server:deploy`).
- CI adds a Supabase deploy job; local path is `supabase start` + serve
  functions + migration dry-run. No manual dashboard steps.

## Testing (no client changes)

- Vitest suites for pure core: deal counts per player count, seat rotation
  and skip-disconnected, preset bounds, commit-validation delegation
  (valid/invalid fixtures from `rules.test.ts`), empty-pool draws,
  public/private filtering, rejoin.
- Handler tests per function with a mocked Supabase client: happy paths plus
  full-room, unknown-code, wrong-turn, and validation-failure errors.
- Gates: `npm test`, `tsc --noEmit`, migration dry-run, local function smoke
  (valid + invalid payloads for all functions).

## Non-goals and open questions

- Non-goals: client migration, matchmaking, chat, kick/moderation,
  rankings, production abuse hardening (open RLS is by design for now).
- Open: confirm preset dimensions above; confirm stale-room TTLs (proposed:
  1 h idle for empty public listings, 24 h for active/private rooms).
