import { describe, expect, it } from 'vitest';
import { HAND_SIZE } from '../src/game/rules';
import type { BoardSet, Tile } from '../src/game/types';
import { makeFakeDb } from './fake-db';
import { checkBoard, checkTile, commitTurn, drawTile, nextTurn, startGame, submitDraft, turnOrder } from './game';
import { createRoom, joinRoom, projectState } from './rooms';
import { type Db, ServerError } from './types';

async function expectError(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServerError);
    expect((e as ServerError).status).toBe(status);
    expect((e as ServerError).code).toBe(code);
    return;
  }
  throw new Error(`expected ServerError ${status}/${code}`);
}

function num(color: 'red' | 'blue' | 'black' | 'yellow', value: number, id: string): Tile {
  return { id, kind: 'number', color, value };
}

const MELD_TILES: Tile[] = [num('red', 10, 'm1'), num('blue', 10, 'm2'), num('black', 10, 'm3')];
const meldBoard = (): BoardSet[] => [MELD_TILES.map((t) => ({ ...t }))];
const meldIds = (): string[] => ['m1', 'm2', 'm3'];

/** Room with `names` seated (first is host), game started. */
async function started(names: string[], preset: 'small' | 'classic' | 'large' = 'classic') {
  const db = makeFakeDb();
  const created = await createRoom(db, { name: names[0], preset }, { now: 1000, rand: () => 0 });
  for (const n of names.slice(1)) await joinRoom(db, created.code, n, { now: 1000 });
  const state = await startGame(db, created.code, 0, { now: 2000, rand: () => 0.42 });
  return { db, code: created.code, state };
}

async function setHand(db: Db, code: string, seat: number, hand: Tile[]) {
  const row = (await db.getSeat(code, seat))!;
  row.hand = hand;
  await db.updateSeat(row);
}

describe('turnOrder / nextTurn', () => {
  it('sorts seats ascending', () => {
    expect(turnOrder([2, 0, 3])).toEqual([0, 2, 3]);
  });
  it('advances to the next connected seat, skipping the disconnected', () => {
    const taken = [
      { seat: 0, connected: true },
      { seat: 1, connected: false },
      { seat: 2, connected: true },
    ];
    expect(nextTurn(taken, 0)).toBe(2);
    expect(nextTurn(taken, 2)).toBe(0);
  });
  it('wraps around the table', () => {
    const taken = [
      { seat: 0, connected: true },
      { seat: 1, connected: true },
    ];
    expect(nextTurn(taken, 1)).toBe(0);
  });
  it('falls back to the next taken seat when nobody is connected', () => {
    const taken = [
      { seat: 0, connected: false },
      { seat: 1, connected: false },
    ];
    expect(nextTurn(taken, 0)).toBe(1);
  });
});

describe('checkTile / checkBoard', () => {
  it('accepts number tiles and jokers', () => {
    expect(checkTile({ id: 'a', kind: 'number', color: 'red', value: 7 })).toEqual({
      id: 'a',
      kind: 'number',
      color: 'red',
      value: 7,
    });
    expect(checkTile({ id: 'j', kind: 'joker' })).toEqual({ id: 'j', kind: 'joker' });
  });
  it('rejects malformed tiles', () => {
    for (const bad of [
      null,
      { id: '', kind: 'number', color: 'red', value: 1 },
      { id: 'a', kind: 'wild', color: 'red', value: 1 },
      { id: 'a', kind: 'number', color: 'green', value: 1 },
      { id: 'a', kind: 'number', color: 'red', value: 0 },
      { id: 'a', kind: 'number', color: 'red', value: 14 },
    ]) {
      expect(() => checkTile(bad)).toThrowError(ServerError);
    }
  });
  it('rejects duplicate ids, empty sets, and non-arrays', () => {
    const t = { id: 'a', kind: 'number', color: 'red', value: 1 };
    expect(() => checkBoard([[t], [{ ...t }]])).toThrowError(/duplicate/);
    expect(() => checkBoard([[]])).toThrowError(ServerError);
    expect(() => checkBoard({})).toThrowError(ServerError);
  });
});

describe('startGame', () => {
  it('deals 14 unique tiles per seat with the remainder pooled, host first', async () => {
    const { db, code } = await started(['A', 'B', 'C', 'D']);
    const game = (await db.getGame(code))!;
    expect(game.board).toEqual([]);
    expect(game.turnSeat).toBe(0);
    expect(game.pool).toHaveLength(106 - 4 * HAND_SIZE);
    const ids: string[] = [];
    for (let s = 0; s < 4; s++) {
      const seat = (await db.getSeat(code, s))!;
      expect(seat.hand).toHaveLength(HAND_SIZE);
      ids.push(...seat.hand.map((t) => t.id));
    }
    expect(new Set(ids).size).toBe(4 * HAND_SIZE);
    expect(game.pool.every((t) => !ids.includes(t.id))).toBe(true);
    const room = (await db.getRoom(code))!;
    expect(room.phase).toBe('playing');
  });
  it('supports 2 and 3 players with matching pool sizes', async () => {
    const two = await started(['A', 'B']);
    expect((await two.db.getGame(two.code))!.pool).toHaveLength(106 - 2 * HAND_SIZE);
    const three = await started(['A', 'B', 'C']);
    expect((await three.db.getGame(three.code))!.pool).toHaveLength(106 - 3 * HAND_SIZE);
  });
  it('is host-only, needs 2 players, and runs once', async () => {
    const db = makeFakeDb();
    const created = await createRoom(db, { name: 'H' }, { rand: () => 0 });
    await expectError(startGame(db, created.code, 'x'), 400, 'bad_seat');
    await joinRoom(db, created.code, 'G');
    await expectError(startGame(db, created.code, 1), 403, 'not_host');
    await startGame(db, created.code, 0);
    await expectError(startGame(db, created.code, 0), 409, 'already_started');
    const solo = makeFakeDb();
    const one = await createRoom(solo, { name: 'Solo' }, { rand: () => 0.3 });
    await expectError(startGame(solo, one.code, 0), 409, 'need_players');
    await expectError(startGame(solo, 'ZZZ99', 0), 404, 'no_room');
  });
});

describe('commitTurn', () => {
  it('accepts a 30-point initial meld and advances the turn', async () => {
    const { db, code } = await started(['A', 'B']);
    await setHand(db, code, 0, [...MELD_TILES, num('red', 1, 'f1')]);
    const state = await commitTurn(db, code, 0, { board: meldBoard(), placedIds: meldIds() });
    expect(state.board).toHaveLength(1);
    expect(state.turnSeat).toBe(1);
    expect(state.seats[0]).toMatchObject({ handCount: 1, hasMelded: true });
    expect(state.hand!.map((t) => t.id)).toEqual(['f1']);
  });
  it('declares the winner on an empty rack', async () => {
    const { db, code } = await started(['A', 'B']);
    await setHand(db, code, 0, [...MELD_TILES]);
    const state = await commitTurn(db, code, 0, { board: meldBoard(), placedIds: meldIds() });
    expect(state.phase).toBe('gameover');
    expect(state.winnerSeat).toBe(0);
  });
  it('rejects short initial melds, wrong turns, and unknown tiles', async () => {
    const { db, code } = await started(['A', 'B']);
    await setHand(db, code, 0, [...MELD_TILES]);
    const pair: BoardSet[] = [[num('red', 10, 'm1'), num('blue', 10, 'm2')]];
    await expectError(commitTurn(db, code, 0, { board: pair, placedIds: ['m1', 'm2'] }), 400, 'invalid_turn');
    await expectError(commitTurn(db, code, 1, { board: meldBoard(), placedIds: meldIds() }), 409, 'not_your_turn');
    await expectError(commitTurn(db, code, 0, { board: meldBoard(), placedIds: ['m1', 'nope'] }), 400, 'not_in_hand');
  });
  it('rejects injected tiles from outside board and hand', async () => {
    const { db, code } = await started(['A', 'B']);
    await setHand(db, code, 0, [...MELD_TILES]);
    const injected: BoardSet[] = [[...MELD_TILES, num('yellow', 10, 'evil')]];
    await expectError(
      commitTurn(db, code, 0, { board: injected, placedIds: meldIds() }),
      400,
      'foreign_tile',
    );
  });
  it('allows board rearrangement after the initial meld', async () => {
    const { db, code } = await started(['A', 'B']);
    const before: BoardSet[] = [[num('red', 4, 'r4'), num('red', 5, 'r5'), num('red', 6, 'r6')]];
    const game = (await db.getGame(code))!;
    game.board = before;
    await db.upsertGame(game);
    const me = (await db.getSeat(code, 0))!;
    me.hasMelded = true;
    me.hand = [num('red', 7, 'r7'), num('blue', 1, 'x1')];
    await db.updateSeat(me);
    const after: BoardSet[] = [[num('red', 4, 'r4'), num('red', 5, 'r5'), num('red', 6, 'r6'), num('red', 7, 'r7')]];
    const state = await commitTurn(db, code, 0, { board: after, placedIds: ['r7'] });
    expect(state.board).toHaveLength(1);
    expect(state.turnSeat).toBe(1);
  });
  it('rejects boards that overflow the room preset', async () => {
    const { db, code } = await started(['A', 'B'], 'small'); // 12x4 = 48 slots
    const colors: ('red' | 'blue' | 'black' | 'yellow')[] = ['red', 'blue', 'black', 'yellow'];
    const big: BoardSet[] = [];
    for (let v = 1; v <= 13; v++) big.push(colors.map((c, i) => num(c, v, `g${v}-${i}`)));
    expect(big.flat().length).toBeGreaterThan(48);
    await expectError(commitTurn(db, code, 0, { board: big, placedIds: [] }), 400, 'board_overflow');
  });
  it('rejects malformed placedIds', async () => {
    const { db, code } = await started(['A', 'B']);
    await expectError(commitTurn(db, code, 0, { board: meldBoard(), placedIds: 'm1' }), 400, 'bad_placed');
  });
});

/** Positional draft: tiles plus their exact board cells. */
const draftAt = (tiles: Tile[], cells: number[]) => [{ tiles: tiles.map((t) => ({ ...t })), cells: [...cells] }];

describe('submitDraft', () => {
  it('shows the live arrangement at true positions to spectators, not the holder', async () => {
    const { db, code } = await started(['A', 'B']);
    // Middle of the classic 18x6 board — must NOT come back packed top-left.
    const draft = draftAt(MELD_TILES, [40, 41, 42]);
    await submitDraft(db, code, 0, draft);
    const room = (await db.getRoom(code))!;
    expect((await projectState(db, room, 0)).draftView).toBeNull();
    expect((await projectState(db, room, 1)).draftView).toEqual(draft);
  });
  it('accepts mid-arrange (invalid) boards but rejects garbage and strangers', async () => {
    const { db, code } = await started(['A', 'B']);
    const partial = draftAt([num('red', 4, 'r4')], [40]); // single tile: invalid set, fine live
    await submitDraft(db, code, 0, partial);
    const room = (await db.getRoom(code))!;
    expect((await projectState(db, room, 1)).draftView).toEqual(partial);
    await expectError(submitDraft(db, code, 1, partial), 409, 'not_your_turn');
    await expectError(submitDraft(db, code, 0, [{ tiles: [{ id: 'x' }], cells: [0] }]), 400, 'bad_tile');
    await expectError(submitDraft(db, code, 'x', partial), 400, 'bad_seat');
  });
  it('rejects duplicate, mismatched, and out-of-range cells', async () => {
    const { db, code } = await started(['A', 'B']);
    const tiles = [num('red', 4, 'a'), num('red', 5, 'b')];
    await expectError(submitDraft(db, code, 0, draftAt(tiles, [7, 7])), 400, 'bad_draft');
    await expectError(submitDraft(db, code, 0, draftAt(tiles, [7])), 400, 'bad_draft');
    await expectError(submitDraft(db, code, 0, draftAt(tiles, [0, 108])), 400, 'bad_draft');
    await expectError(submitDraft(db, code, 0, 'nope'), 400, 'bad_draft');
  });
  it('clears the draft on commit', async () => {
    const { db, code } = await started(['A', 'B']);
    await setHand(db, code, 0, [...MELD_TILES]);
    await submitDraft(db, code, 0, draftAt(MELD_TILES, [0, 1, 2]));
    await commitTurn(db, code, 0, { board: meldBoard(), placedIds: meldIds() });
    const room = (await db.getRoom(code))!;
    // Game is over (rack emptied); winner sees the final board, no draft.
    expect((await projectState(db, room, 1)).draftView).toBeNull();
  });
});

describe('drawTile', () => {
  it('deals the top pool tile and advances the turn', async () => {
    const { db, code } = await started(['A', 'B']);
    const before = (await db.getGame(code))!.pool.length;
    const state = await drawTile(db, code, 0);
    expect(state.drew).toMatchObject({ id: expect.any(String) });
    expect(state.seats[0].handCount).toBe(HAND_SIZE + 1);
    expect(state.poolCount).toBe(before - 1);
    expect(state.turnSeat).toBe(1);
  });
  it('passes the turn with no tile when the pool is empty', async () => {
    const { db, code } = await started(['A', 'B']);
    const game = (await db.getGame(code))!;
    game.pool = [];
    await db.upsertGame(game);
    const state = await drawTile(db, code, 0);
    expect(state.drew).toBeNull();
    expect(state.seats[0].handCount).toBe(HAND_SIZE);
    expect(state.turnSeat).toBe(1);
  });
  it('rejects out-of-turn draws', async () => {
    const { db, code } = await started(['A', 'B']);
    await expectError(drawTile(db, code, 1), 409, 'not_your_turn');
  });
});
