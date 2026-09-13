import { describe, expect, it } from 'vitest';
import { makeFakeDb } from './fake-db';
import { createRoom, joinRoom, leaveRoom, listRooms, normalizeName, randomCode } from './rooms';
import { normalizeCode, ServerError } from './types';

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

describe('normalizeCode', () => {
  it('uppercases and trims valid codes', () => {
    expect(normalizeCode(' ab3dk ')).toBe('AB3DK');
  });
  it('rejects short, long, and ambiguous characters', async () => {
    for (const bad of ['ABCD', 'ABCDEF', 'ABC1E', 'AB0DE', 'AB DE', 42, null]) {
      await expectError(Promise.resolve().then(() => normalizeCode(bad)), 400, 'bad_code');
    }
  });
});

describe('normalizeName', () => {
  it('trims and defaults blanks to Player', () => {
    expect(normalizeName('  Ada  ')).toBe('Ada');
    expect(normalizeName('   ')).toBe('Player');
  });
  it('caps length and rejects non-strings', () => {
    expect(normalizeName('x'.repeat(99)).length).toBeLessThanOrEqual(24);
    expect(() => normalizeName(7)).toThrowError(ServerError);
  });
});

describe('randomCode', () => {
  it('uses the 5-letter unambiguous alphabet', () => {
    expect(randomCode(() => 0)).toBe('AAAAA');
    expect(randomCode(() => 0.99999)).toMatch(/^[A-Z2-9]{5}$/);
  });
});

describe('createRoom', () => {
  it('seats the creator as host with defaults', async () => {
    const db = makeFakeDb();
    const state = await createRoom(db, { name: 'Host' }, { now: 1000, rand: () => 0 });
    expect(state.code).toBe('AAAAA');
    expect(state.yourSeat).toBe(0);
    expect(state.preset).toBe('classic');
    expect(state.phase).toBe('lobby');
    expect(state.seats).toEqual([
      { seat: 0, name: 'Host', connected: true, handCount: 0, hasMelded: false },
    ]);
    expect(state.hand).toEqual([]);
  });
  it('honors preset and private flag', async () => {
    const db = makeFakeDb();
    const state = await createRoom(db, { name: 'H', isPublic: false, preset: 'large' }, { rand: () => 0 });
    expect(state.preset).toBe('large');
    expect(await listRooms(db)).toEqual([]);
  });
  it('falls back to classic on unknown preset', async () => {
    const db = makeFakeDb();
    const state = await createRoom(db, { name: 'H', preset: 'mega' }, { rand: () => 0 });
    expect(state.preset).toBe('classic');
  });
  it('retries on code collision', async () => {
    const db = makeFakeDb();
    await createRoom(db, { name: 'A' }, { rand: () => 0 });
    let calls = 0;
    const rand = () => (calls++ === 0 ? 0 : 0.5);
    const state = await createRoom(db, { name: 'B' }, { rand });
    expect(state.code).not.toBe('AAAAA');
  });
});

describe('joinRoom', () => {
  async function twoPlayer() {
    const db = makeFakeDb();
    const created = await createRoom(db, { name: 'Host' }, { now: 1000, rand: () => 0 });
    return { db, code: created.code };
  }

  it('takes the first free seat', async () => {
    const { db, code } = await twoPlayer();
    const joined = await joinRoom(db, code, 'Guest', { now: 2000 });
    expect(joined.yourSeat).toBe(1);
    expect(joined.seats.map((s) => s.name)).toEqual(['Host', 'Guest']);
  });
  it('reclaims a seat by name (rejoin)', async () => {
    const { db, code } = await twoPlayer();
    await joinRoom(db, code, 'Guest');
    await leaveRoom(db, code, 1);
    const rejoined = await joinRoom(db, code, 'Guest');
    expect(rejoined.yourSeat).toBe(1);
    expect(rejoined.seats[1].connected).toBe(true);
  });
  it('rejects a fourth-plus player with room_full', async () => {
    const { db, code } = await twoPlayer();
    await joinRoom(db, code, 'P2');
    await joinRoom(db, code, 'P3');
    await joinRoom(db, code, 'P4');
    await expectError(joinRoom(db, code, 'P5'), 409, 'room_full');
  });
  it('rejects new names once playing, but allows rejoin', async () => {
    const { db, code } = await twoPlayer();
    const room = (await db.getRoom(code))!;
    room.phase = 'playing';
    await db.updateRoom(room);
    await expectError(joinRoom(db, code, 'Late'), 409, 'game_started');
    const back = await joinRoom(db, code, 'Host');
    expect(back.yourSeat).toBe(0);
  });
  it('404s on unknown codes', async () => {
    const db = makeFakeDb();
    await expectError(joinRoom(db, 'ZZZ99', 'Ghost'), 404, 'no_room');
  });
});

describe('leaveRoom', () => {
  it('marks the seat disconnected but keeps a playing room', async () => {
    const db = makeFakeDb();
    const created = await createRoom(db, { name: 'H' }, { rand: () => 0 });
    await joinRoom(db, created.code, 'G');
    const room = (await db.getRoom(created.code))!;
    room.phase = 'playing';
    await db.updateRoom(room);
    const res = await leaveRoom(db, created.code, 1);
    expect(res).toEqual({ left: true, roomDeleted: false });
    expect((await db.getSeat(created.code, 1))!.connected).toBe(false);
  });
  it('deletes an emptied lobby room', async () => {
    const db = makeFakeDb();
    const created = await createRoom(db, { name: 'H' }, { rand: () => 0 });
    const res = await leaveRoom(db, created.code, 0);
    expect(res).toEqual({ left: true, roomDeleted: true });
    expect(await db.getRoom(created.code)).toBeNull();
  });
  it('validates seat and room', async () => {
    const db = makeFakeDb();
    await expectError(leaveRoom(db, 'ZZZ99', 0), 404, 'no_room');
    const created = await createRoom(db, { name: 'H' }, { rand: () => 0.1 });
    await expectError(leaveRoom(db, created.code, 3), 404, 'no_seat');
    await expectError(leaveRoom(db, created.code, 'x'), 400, 'bad_seat');
  });
});

describe('listRooms', () => {
  it('lists fresh public rooms with seat counts, skipping private/stale/full/empty', async () => {
    const db = makeFakeDb();
    const open = await createRoom(db, { name: 'Open' }, { now: 1000, rand: () => 0 });
    await joinRoom(db, open.code, 'Guest', { now: 1500 });
    await createRoom(db, { name: 'Hidden', isPublic: false }, { now: 1000, rand: () => 0.2 });
    await createRoom(db, { name: 'Stale' }, { now: 1000, rand: () => 0.4 });
    const rooms = await db.listAllRooms();
    for (const r of rooms) {
      if (r.hostName === 'Stale') {
        r.lastActivityAt = 1000 - 400_000; // older than LOBBY_LIST_TTL_MS
        await db.updateRoom(r);
      }
    }
    const full = await createRoom(db, { name: 'Full' }, { now: 1000, rand: () => 0.6 });
    await joinRoom(db, full.code, 'F2', { now: 1500 });
    await joinRoom(db, full.code, 'F3', { now: 1500 });
    await joinRoom(db, full.code, 'F4', { now: 1500 });
    const listed = await listRooms(db, 1000 + 60_000);
    expect(listed.map((l) => l.name)).toEqual(['Open']);
    expect(listed[0]).toMatchObject({ seatsTaken: 2, preset: 'classic' });
  });
});
