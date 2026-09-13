import { describe, expect, it } from 'vitest';
import { makeFakeDb } from './fake-db';
import {
  handleGameCommit,
  handleGameDraw,
  handleGameStart,
  handleRoomsCleanup,
  handleRoomsCreate,
  handleRoomsJoin,
  handleRoomsLeave,
  handleRoomsList,
  handleRoomsState,
} from './handlers';
import type { Tile } from '../src/game/types';

function num(color: 'red' | 'blue' | 'black' | 'yellow', value: number, id: string): Tile {
  return { id, kind: 'number', color, value };
}

const MELD = [num('red', 10, 'm1'), num('blue', 10, 'm2'), num('black', 10, 'm3')];

/** Create + join a 2-player room; returns code and host seat. */
async function lobby() {
  const db = makeFakeDb();
  const created = await handleRoomsCreate(db, { name: 'Host' }, { now: 1000, rand: () => 0 });
  const code = (created.body as { code: string }).code;
  await handleRoomsJoin(db, { code, name: 'Guest' }, { now: 1000 });
  return { db, code };
}

describe('room handlers', () => {
  it('creates, lists, joins, and leaves through HTTP-shaped results', async () => {
    const db = makeFakeDb();
    const created = await handleRoomsCreate(db, { name: 'Host' }, { now: 1000, rand: () => 0 });
    expect(created.status).toBe(200);
    const code = (created.body as { code: string }).code;
    expect(code).toBe('AAAAA');

    const listed = await handleRoomsList(db, { now: 2000 });
    expect(listed).toEqual({ status: 200, body: { rooms: [expect.objectContaining({ code })] } });

    const joined = await handleRoomsJoin(db, { code, name: 'Guest' }, {});
    expect(joined.status).toBe(200);
    expect((joined.body as { yourSeat: number }).yourSeat).toBe(1);

    const left = await handleRoomsLeave(db, { code, seat: 1 }, {});
    expect(left).toEqual({ status: 200, body: { left: true, roomDeleted: false } });
  });
  it('maps domain errors to status codes with stable error names', async () => {
    const db = makeFakeDb();
    expect((await handleRoomsCreate(db, { name: 7 }, {})).status).toBe(400);
    const missing = await handleRoomsJoin(db, { code: 'ZZZ99', name: 'G' }, {});
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'no_room' });
    const badLeave = await handleRoomsLeave(db, { code: '???', seat: 0 }, {});
    expect(badLeave.status).toBe(400);
  });
});

describe('game handlers', () => {
  it('runs a full start-commit-draw round trip', async () => {
    const { db, code } = await lobby();
    const dealt = await handleGameStart(db, { code, seat: 0 }, { rand: () => 0.1 });
    expect(dealt.status).toBe(200);
    expect((dealt.body as { poolCount: number }).poolCount).toBe(106 - 28);

    // Rig seat 0 with an exact 30-point meld.
    const me = (await db.getSeat(code, 0))!;
    me.hand = [...MELD, num('red', 1, 'f1')];
    await db.updateSeat(me);
    const committed = await handleGameCommit(
      db,
      { code, seat: 0, board: [[...MELD]], placedIds: ['m1', 'm2', 'm3'] },
      {},
    );
    expect(committed.status).toBe(200);
    expect((committed.body as { turnSeat: number }).turnSeat).toBe(1);

    const drawn = await handleGameDraw(db, { code, seat: 1 }, {});
    expect(drawn.status).toBe(200);
    expect((drawn.body as { drew: Tile | null }).drew).not.toBeNull();
    expect((drawn.body as { turnSeat: number }).turnSeat).toBe(0);
  });
  it('rejects non-host starts and invalid commits with error names', async () => {
    const { db, code } = await lobby();
    const forbidden = await handleGameStart(db, { code, seat: 1 }, {});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ error: 'not_host' });

    await handleGameStart(db, { code, seat: 0 }, {});
    const bad = await handleGameCommit(db, { code, seat: 1, board: [], placedIds: [] }, {});
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ error: 'not_your_turn' });
  });
});

describe('handleRoomsState', () => {
  it('returns the state projection for a seated player', async () => {
    const { db, code } = await lobby();
    const res = await handleRoomsState(db, { code, seat: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code, yourSeat: 0, phase: 'lobby' });
    expect((res.body as { hand: unknown }).hand).toEqual([]);
  });
  it('hides other hands and rejects strangers', async () => {
    const { db, code } = await lobby();
    const res = await handleRoomsState(db, { code, seat: 1 });
    expect(res.body).toMatchObject({ yourSeat: 1 });
    expect(await handleRoomsState(db, { code, seat: 5 })).toMatchObject({ status: 404 });
    expect(await handleRoomsState(db, { code: 'ZZZ99', seat: 0 })).toMatchObject({ status: 404 });
    expect(await handleRoomsState(db, { code, seat: 'x' })).toMatchObject({ status: 400 });
  });
});

describe('handleRoomsCleanup', () => {
  it('deletes idle rooms and stale empty lobbies, keeps the living', async () => {
    const db = makeFakeDb();
    const now = 25 * 60 * 60_000;
    const fresh = await handleRoomsCreate(db, { name: 'Fresh' }, { now: now - 60_000, rand: () => 0 });
    const freshCode = (fresh.body as { code: string }).code;
    const old = await handleRoomsCreate(db, { name: 'Old' }, { now: 0, rand: () => 0.2 });
    const oldCode = (old.body as { code: string }).code;
    const priv = await handleRoomsCreate(
      db,
      { name: 'Priv', isPublic: false },
      { now: 0, rand: () => 0.4 },
    );
    const privCode = (priv.body as { code: string }).code;

    const res = await handleRoomsCleanup(db, now);
    expect(res).toEqual({ status: 200, body: { deleted: 2 } });
    expect(await db.getRoom(freshCode)).not.toBeNull();
    expect(await db.getRoom(oldCode)).toBeNull();
    expect(await db.getRoom(privCode)).toBeNull();
  });
  it('deletes abandoned lobby rooms past EMPTY_ROOM_TTL but keeps seated ones', async () => {
    const db = makeFakeDb();
    const gone = await handleRoomsCreate(db, { name: 'Gone' }, { now: 0, rand: () => 0 });
    const goneCode = (gone.body as { code: string }).code;
    // Simulate an abandoned seat bypassing leaveRoom's immediate delete.
    const seat = (await db.getSeat(goneCode, 0))!;
    seat.connected = false;
    await db.updateSeat(seat);
    const stay = await handleRoomsCreate(db, { name: 'Stay' }, { now: 0, rand: () => 0.3 });
    const stayCode = (stay.body as { code: string }).code;

    const res = await handleRoomsCleanup(db, 2 * 60 * 60_000);
    expect(res).toEqual({ status: 200, body: { deleted: 1 } });
    expect(await db.getRoom(goneCode)).toBeNull();
    expect(await db.getRoom(stayCode)).not.toBeNull();
  });
});
