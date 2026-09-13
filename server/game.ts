import { HAND_SIZE, buildDeck, shuffle, validateTurn } from '../src/game/rules.ts';
import type { BoardSet, Tile, TileColor } from '../src/game/types.ts';
import { presetCapacity } from './presets.ts';
import { projectState } from './rooms.ts';
import { type Db, type DraftSet, type PublicState, ServerError, normalizeCode } from './types.ts';

export type RandomFn = () => number;

const COLORS: TileColor[] = ['red', 'blue', 'black', 'yellow'];

/** Shape-check one inbound tile; throws 400 on anything malformed. */
export function checkTile(v: unknown): Tile {
  if (typeof v !== 'object' || v === null) throw new ServerError(400, 'bad_tile', 'Tile must be an object.');
  const t = v as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id) throw new ServerError(400, 'bad_tile', 'Tile id must be a non-empty string.');
  if (t.kind === 'joker') return { id: t.id, kind: 'joker' };
  if (t.kind !== 'number') throw new ServerError(400, 'bad_tile', 'Tile kind must be number or joker.');
  if (!COLORS.includes(t.color as TileColor)) throw new ServerError(400, 'bad_tile', 'Bad tile color.');
  if (!Number.isInteger(t.value) || (t.value as number) < 1 || (t.value as number) > 13) {
    throw new ServerError(400, 'bad_tile', 'Tile value must be 1..13.');
  }
  return { id: t.id, kind: 'number', color: t.color as TileColor, value: t.value as number };
}

/** Shape-check an inbound board (array of non-empty tile arrays). */
export function checkBoard(v: unknown): BoardSet[] {
  if (!Array.isArray(v)) throw new ServerError(400, 'bad_board', 'Board must be an array of sets.');
  const board: BoardSet[] = v.map((s) => {
    if (!Array.isArray(s) || s.length === 0) throw new ServerError(400, 'bad_board', 'Board sets must be non-empty arrays.');
    return s.map(checkTile);
  });
  const ids = board.flat().map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new ServerError(400, 'bad_board', 'Board has duplicate tile ids.');
  return board;
}

/** Seats in turn order: taken seats sorted ascending. */
export function turnOrder(seatIndexes: number[]): number[] {
  return [...seatIndexes].sort((a, b) => a - b);
}

/**
 * Next turn holder after `from`: the next taken seat, preferring connected
 * seats so a disconnected player does not stall the table. Falls back to
 * the next taken seat (even if disconnected) so the game can always advance.
 */
export function nextTurn(
  taken: { seat: number; connected: boolean }[],
  from: number,
): number {
  const order = turnOrder(taken.map((t) => t.seat));
  const idx = order.indexOf(from);
  for (let k = 1; k <= order.length; k++) {
    const cand = order[(idx + k) % order.length];
    if (taken.find((t) => t.seat === cand)?.connected) return cand;
  }
  return order[(idx + 1) % order.length];
}

export interface StartGameDeps {
  now?: number;
  rand?: RandomFn;
}

/**
 * Host-only (seat 0) deal: shuffles a fresh 106-tile deck, deals HAND_SIZE
 * to every taken seat, empties the board, host moves first.
 */
export async function startGame(
  db: Db,
  rawCode: unknown,
  seat: unknown,
  deps: StartGameDeps = {},
): Promise<PublicState> {
  const code = normalizeCode(rawCode);
  if (!Number.isInteger(seat)) throw new ServerError(400, 'bad_seat', 'Seat must be an integer.');
  const now = deps.now ?? Date.now();
  const rand = deps.rand ?? Math.random;

  const room = await db.getRoom(code);
  if (!room) throw new ServerError(404, 'no_room', 'No room with that code.');
  if (room.phase !== 'lobby') throw new ServerError(409, 'already_started', 'That game already started.');
  if (seat !== 0) throw new ServerError(403, 'not_host', 'Only the host (seat 0) can start the game.');
  const seats = await db.listSeats(code);
  const host = seats.find((s) => s.seat === 0);
  if (!host || !host.connected) throw new ServerError(403, 'not_host', 'Only the host (seat 0) can start the game.');
  const taken = seats.filter((s) => s.connected);
  if (taken.length < 2) throw new ServerError(409, 'need_players', 'Need at least 2 players to start.');

  const deck = shuffle(buildDeck(), rand);
  const ordered = turnOrder(taken.map((s) => s.seat));
  let cursor = 0;
  for (const s of ordered) {
    const row = seats.find((x) => x.seat === s)!;
    row.hand = deck.slice(cursor, cursor + HAND_SIZE);
    cursor += HAND_SIZE;
    row.hasMelded = false;
    await db.updateSeat(row);
  }
  await db.upsertGame({ roomCode: code, board: [], pool: deck.slice(cursor), turnSeat: 0, draft: [] });
  room.phase = 'playing';
  room.winnerSeat = null;
  room.lastActivityAt = now;
  await db.updateRoom(room);
  return await projectState(db, room, seat as number);
}

export interface CommitTurnInput {
  board: unknown;
  placedIds: unknown;
}

/**
 * Commit the current player's board. Validates tile shapes, rejects boards
 * with tiles outside (previous board + hand) to block tile injection, then
 * delegates to the shared `validateTurn` rules. Empty rack wins the game.
 */
export async function commitTurn(
  db: Db,
  rawCode: unknown,
  seat: unknown,
  input: CommitTurnInput,
  now: number = Date.now(),
): Promise<PublicState> {
  const code = normalizeCode(rawCode);
  if (!Number.isInteger(seat)) throw new ServerError(400, 'bad_seat', 'Seat must be an integer.');
  if (!Array.isArray(input.placedIds) || !input.placedIds.every((id) => typeof id === 'string')) {
    throw new ServerError(400, 'bad_placed', 'placedIds must be an array of tile-id strings.');
  }

  const room = await db.getRoom(code);
  if (!room) throw new ServerError(404, 'no_room', 'No room with that code.');
  if (room.phase !== 'playing') throw new ServerError(409, 'not_playing', 'That game is not in play.');
  const game = await db.getGame(code);
  if (!game) throw new ServerError(500, 'no_game', 'Game state missing.');
  if (game.turnSeat !== seat) throw new ServerError(409, 'not_your_turn', 'It is not your turn.');
  const me = await db.getSeat(code, seat as number);
  if (!me || !me.connected) throw new ServerError(404, 'no_seat', 'No such seat in that room.');

  const board = checkBoard(input.board);
  const total = board.flat().length;
  if (total > presetCapacity(room.preset)) {
    throw new ServerError(400, 'board_overflow', 'Board does not fit the room preset.');
  }
  const placedIds = input.placedIds as string[];
  const handIds = new Set(me.hand.map((t) => t.id));
  for (const id of placedIds) {
    if (!handIds.has(id)) throw new ServerError(400, 'not_in_hand', 'Placed tiles must come from your hand.');
  }
  const beforeIds = new Set(game.board.flat().map((t) => t.id));
  const afterIds = new Set(board.flat().map((t) => t.id));
  for (const id of afterIds) {
    if (!beforeIds.has(id) && !handIds.has(id)) {
      throw new ServerError(400, 'foreign_tile', 'Board has tiles from neither the board nor your hand.');
    }
  }

  const check = validateTurn({ beforeBoard: game.board, afterBoard: board, placedIds, hasMelded: me.hasMelded });
  if (!check.ok) throw new ServerError(400, 'invalid_turn', check.reason ?? 'Invalid turn.');

  const placed = new Set(placedIds);
  me.hand = me.hand.filter((t) => !placed.has(t.id));
  me.hasMelded = true;
  await db.updateSeat(me);
  game.board = board;
  game.draft = [];

  if (me.hand.length === 0) {
    room.phase = 'gameover';
    room.winnerSeat = me.seat;
    room.lastActivityAt = now;
    await db.updateRoom(room);
    await db.upsertGame(game);
    return await projectState(db, room, seat as number);
  }

  const seats = await db.listSeats(code);
  game.turnSeat = nextTurn(
    seats.map((s) => ({ seat: s.seat, connected: s.connected })),
    game.turnSeat,
  );
  room.lastActivityAt = now;
  await db.updateRoom(room);
  await db.upsertGame(game);
  return await projectState(db, room, seat as number);
}

/** Draw a tile (or pass the turn when the pool is empty). */
export async function drawTile(
  db: Db,
  rawCode: unknown,
  seat: unknown,
  now: number = Date.now(),
): Promise<PublicState & { drew: Tile | null }> {
  const code = normalizeCode(rawCode);
  if (!Number.isInteger(seat)) throw new ServerError(400, 'bad_seat', 'Seat must be an integer.');

  const room = await db.getRoom(code);
  if (!room) throw new ServerError(404, 'no_room', 'No room with that code.');
  if (room.phase !== 'playing') throw new ServerError(409, 'not_playing', 'That game is not in play.');
  const game = await db.getGame(code);
  if (!game) throw new ServerError(500, 'no_game', 'Game state missing.');
  if (game.turnSeat !== seat) throw new ServerError(409, 'not_your_turn', 'It is not your turn.');
  const me = await db.getSeat(code, seat as number);
  if (!me || !me.connected) throw new ServerError(404, 'no_seat', 'No such seat in that room.');

  const drew = game.pool.pop() ?? null;
  if (drew) me.hand = [...me.hand, drew];
  await db.updateSeat(me);
  game.draft = [];
  const seats = await db.listSeats(code);
  game.turnSeat = nextTurn(
    seats.map((s) => ({ seat: s.seat, connected: s.connected })),
    game.turnSeat,
  );
  room.lastActivityAt = now;
  await db.updateRoom(room);
  await db.upsertGame(game);
  const state = await projectState(db, room, seat as number);
  return { ...state, drew };
}

/**
 * Shape-check a positional draft: sets with tiles plus their board cells.
 * Set validity is NOT checked (mid-arrange boards are legitimately broken),
 * but cells must be unique, in range, and match the tiles one-to-one.
 */
export function checkDraft(v: unknown, capacity: number): DraftSet[] {
  if (!Array.isArray(v)) throw new ServerError(400, 'bad_draft', 'Draft must be an array of sets.');
  const seen = new Set<number>();
  return v.map((s) => {
    if (typeof s !== 'object' || s === null) throw new ServerError(400, 'bad_draft', 'Draft sets must be objects.');
    const { tiles, cells } = s as { tiles?: unknown; cells?: unknown };
    if (!Array.isArray(tiles) || tiles.length === 0) {
      throw new ServerError(400, 'bad_draft', 'Draft sets must hold tiles.');
    }
    if (!Array.isArray(cells) || cells.length !== tiles.length) {
      throw new ServerError(400, 'bad_draft', 'Draft cells must match tiles one-to-one.');
    }
    for (const c of cells) {
      if (!Number.isInteger(c) || (c as number) < 0 || (c as number) >= capacity) {
        throw new ServerError(400, 'bad_draft', 'Draft cell out of range.');
      }
      if (seen.has(c as number)) throw new ServerError(400, 'bad_draft', 'Draft cells must be unique.');
      seen.add(c as number);
    }
    return { tiles: tiles.map(checkTile), cells: cells as number[] };
  });
}

/**
 * Publish the turn holder's in-progress arrangement for spectators.
 * Shape-checked only (mid-arrange boards are legitimately invalid);
 * only the current turn holder may publish. Cleared by commit/draw.
 */
export async function submitDraft(
  db: Db,
  rawCode: unknown,
  seat: unknown,
  rawBoard: unknown,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  const code = normalizeCode(rawCode);
  if (!Number.isInteger(seat)) throw new ServerError(400, 'bad_seat', 'Seat must be an integer.');

  const room = await db.getRoom(code);
  if (!room) throw new ServerError(404, 'no_room', 'No room with that code.');
  if (room.phase !== 'playing') throw new ServerError(409, 'not_playing', 'That game is not in play.');
  const game = await db.getGame(code);
  if (!game) throw new ServerError(500, 'no_game', 'Game state missing.');
  if (game.turnSeat !== seat) throw new ServerError(409, 'not_your_turn', 'It is not your turn.');

  game.draft = checkDraft(rawBoard, presetCapacity(room.preset));
  room.lastActivityAt = now;
  await db.updateRoom(room);
  await db.upsertGame(game);
  return { ok: true };
}
