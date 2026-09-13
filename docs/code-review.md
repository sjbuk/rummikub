# Rummikub Code Review

Scope: `src/game/*`, `src/net/p2p.ts`, `src/ui/app.ts`, Tauri config.
Every source file was read and the Trystero API was cross-checked against
`node_modules/@trystero-p2p/core/dist/types.d.mts`.
`npm test` / `tsc` could not be run (npm is not installed in the review
environment), so nothing below is dynamically verified.

## Vulnerabilities

### 1. Stored XSS via peer-sent tiles (highest severity)

`tileEl` in `src/ui/app.ts:468` builds `innerHTML` with `${tile.value}`.
Board tiles, dealt hands, and drawn tiles all come straight from the network
(`msg.board`, `msg.hand`, `msg.tile`) with zero shape validation — `onNet`
casts with `as` and uses the objects directly. A malicious peer can send a
tile whose `value` is an HTML string and get script execution in the victim's
browser. This is amplified by `"csp": null` in `src-tauri/tauri.conf.json`,
which disables Tauri's default Content Security Policy.

Fix: validate every inbound tile (kind/color/value ranges) and render with
`textContent`, plus restore the CSP.

### 2. No validation of remote game messages — peer can cheat at will

`onNet` (`src/ui/app.ts:165`) accepts `commit`, `deal`, `drawGrant`,
`drawBoard` unconditionally: no `validateBoard`/`validateTurn` on receipt, no
`winnerId` verification (opponent can declare themselves winner), arbitrary
`handCount`/`poolCount`/`turn`, and the sender's Trystero `peerId` is
discarded even though `src/net/p2p.ts:24` provides it — so role checks
(`msg.by`, `msg.to`) are self-asserted and a third party in the room can
impersonate either side. Related: `deal.hand` is broadcast to the whole room
with no 2-player cap, so any extra peer with `role='guest'` also adopts the
dealt hand. The default strategy is public Nostr relays (`trystero`
re-exports `@trystero-p2p/nostr`, which exports `defaultRelayUrls`), and
5-character room codes from a 31-symbol alphabet (31^5 ≈ 2^24.8, i.e. ~25
bits) shared out-of-band are the only secret — fine for a casual game, but
there is no peer authentication whatsoever.

## Bugs (correctness)

### 3. Melded players can pocket board tiles into their rack

The `hasMelded: true` path in `src/game/rules.ts:172` checks that the board
is valid and that placed tiles are on it, but never checks that all
pre-existing board tiles are still there (the `beforeIds ⊆ afterIds` check
exists only in the initial-meld branch). The exploit path is real:
`handleCellTarget` (`src/ui/app.ts:376`) swaps a rack tile onto an occupied
cell and puts the occupant — possibly a committed board tile — into the hand,
while the parallel return-to-rack path in `clickRackTile` explicitly forbids
touching committed tiles (`src/ui/app.ts:437`). So the UI both forbids and
allows the same illegal move depending on the gesture.

### 4. Swap + Revert duplicates tiles

Following the swap in #3, `doRevert` (`src/ui/app.ts:350`) pushes rack-origin
draft tiles back to the hand but never removes the committed tile that leaked
into the hand — then restores the board, leaving the same tile id on the
board *and* in the hand.

### 5. Fixed 90-slot grid has no overflow path (lower severity than first reported)

`layoutSetsToGrid` (`src/game/board.ts:45`) `break`s past row 6, dropping
sets — but it is a test-only helper: its only callers are in
`src/game/board.test.ts`, never in `src/ui/app.ts`. `commit` broadcasts the
live draft grid directly (`src/ui/app.ts:336-338`), so the originally
described "dropped tiles vanish for both players" path does not exist.
The residual issue is capacity, not silent loss: the live board is a fixed
15×6 grid (90 slots including inter-set gaps), a late game can approach that
(from the 106-tile deck), and the UI has no overflow handling — placements
just fail with "needs a free stretch". The "far exceeds 2-player needs"
comment (`src/game/board.ts:55`) is still overconfident.

### 6. Tauri bundle build is broken

`tauri.conf.json` references `icons/128x128.png`,
`icons/128x128@2x.png`, `icons/icon.icns`, `icons/icon.ico`, but
`src-tauri/icons/` does not exist. Also `identifier:
com.example.rumikub` is still the placeholder.

### 7. Draw protocol holes

Host's `drawRequest` handler (`src/ui/app.ts:215`) doesn't check it's the
guest's turn, so the guest can harvest free tiles out of turn. Empty pool is
`if (!tile) return` — the guest hangs on "Requesting a tile…" with no
timeout, retry, or error. The guest fundamentally cannot play without the
host (no pool copy, no fallback).

### 8. Guest never sees the opponent's tile count

The status bar hardcodes `'—'` for the guest role (`src/ui/app.ts:583`)
even though `peerHandCount` is populated from `commit`/`drawBoard` for both
sides.

## Poor practices / robustness

- **Fragile presence sync:** `hello` fires once after 800ms; a late joiner
  misses it, and `deal.names` carries only the host's name, so both sides can
  sit on "Opponent" forever. Disconnect wipes the game ("host redeals"
  reshuffles; guest's hand is lost) — no resync or message epoch, so stale
  messages from a previous game are accepted as current.
- **Dead code / dead params:** `placed` is computed (`src/game/rules.ts:206`)
  then discarded via `void placed` (`src/game/rules.ts:223`); `connect(code, role)` ignores `role`
  (`src/ui/app.ts:118`); unknown `placedIds` are silently filtered instead of
  rejected.
- **Rules deviation:** `validateRun` keeps the highest-scoring joker
  placement, inflating initial-meld scores (a trailing joker is always worth
  the maximum). Fine if deliberate, but it makes the 30-point meld easier
  than standard rules and isn't documented to players.
- **Test gaps:** game/UI/net layers have no tests — notably the swap, revert,
  and melded-pocketing paths, inbound-message handling, and grid overflow.
  Existing `board`/`rules` tests are good for the happy paths.
- **Trust-by-design notes (acceptable if conscious):** `Math.random` shuffle
  plus host-deals means the host can stack the deck — inherent to the
  no-server design, but worth stating. `dist/` in the working tree is just a
  local build artifact (correctly gitignored, untracked).

## Suggested priority

Fix #1 and #2 first (validate + sanitize all inbound messages, bind messages
to peer ids, verify commits/wins locally), then #3/#4 (one-line `beforeIds ⊆
afterIds` check in the melded path + block committed tiles in the swap path),
then #6 (icons/identifier) and the #5 grid-capacity follow-up (overflow
handling in the live UI, not `layoutSetsToGrid`, which is test-only).
