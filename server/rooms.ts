import { isBoardPresetName, type BoardPresetName } from './presets.ts';
import {
  LOBBY_LIST_TTL_MS,
  MAX_NAME_LEN,
  MAX_SEATS,
  ROOM_CODE_LEN,
  type Db,
  type PublicState,
  type RoomListing,
  type RoomRow,
  ServerError,
  normalizeCode,
} from './types.ts';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type RandomFn = () => number;

/** 5-letter room code in the same shape as the P2P client. */
export function randomCode(rand: RandomFn = Math.random, length: number = ROOM_CODE_LEN): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  }
  return out;
}

/** Normalize a display name; throws 400 when empty. */
export function normalizeName(name: unknown): string {
  if (typeof name !== 'string') throw new ServerError(400, 'bad_name', 'Name must be a string.');
  const n = name.trim().slice(0, MAX_NAME_LEN) || 'Player';
  return n;
}

export interface CreateRoomInput {
  name: unknown;
  isPublic?: unknown;
  preset?: unknown;
}

export interface CreateRoomDeps {
  now?: number;
  rand?: RandomFn;
}

/** Create a room with the caller seated as host (seat 0). */
export async function createRoom(
  db: Db,
  input: CreateRoomInput,
  deps: CreateRoomDeps = {},
): Promise<PublicState> {
  const name = normalizeName(input.name);
  const preset: BoardPresetName = isBoardPresetName(input.preset) ? input.preset : 'classic';
  const isPublic = input.isPublic !== false;
  const now = deps.now ?? Date.now();
  const rand = deps.rand ?? Math.random;

  let code = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCode(rand);
    if (!(await db.getRoom(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new ServerError(503, 'code_exhausted', 'Could not allocate a room code.');

  const room: RoomRow = {
    code,
    hostName: name,
    isPublic,
    preset,
    phase: 'lobby',
    winnerSeat: null,
    createdAt: now,
    lastActivityAt: now,
  };
  await db.insertRoom(room);
  await db.insertSeat({ roomCode: code, seat: 0, name, connected: true, hand: [], hasMelded: false });
  return await projectState(db, room, 0);
}

/** List open public rooms with recent activity. */
export async function listRooms(db: Db, now: number = Date.now()): Promise<RoomListing[]> {
  const rooms = await db.listPublicLobbyRooms();
  const out: RoomListing[] = [];
  for (const room of rooms) {
    if (room.phase !== 'lobby') continue;
    if (now - room.lastActivityAt >= LOBBY_LIST_TTL_MS) continue;
    const seats = await db.listSeats(room.code);
    const taken = seats.filter((s) => s.connected).length;
    if (taken === 0 || taken >= MAX_SEATS) continue;
    out.push({ code: room.code, name: room.hostName, seatsTaken: taken, preset: room.preset });
  }
  return out;
}

export interface JoinRoomDeps {
  now?: number;
}

/**
 * Join a room. A matching connected-or-not name reclaims its seat (rejoin);
 * otherwise the first free seat (0..3) is taken. Full rooms reject with 409.
 * Joining a started game is only possible as a rejoin.
 */
export async function joinRoom(
  db: Db,
  rawCode: unknown,
  rawName: unknown,
  deps: JoinRoomDeps = {},
): Promise<PublicState> {
  const code = normalizeCode(rawCode);
  const name = normalizeName(rawName);
  const now = deps.now ?? Date.now();
  const room = await db.getRoom(code);
  if (!room) throw new ServerError(404, 'no_room', 'No room with that code.');
  const seats = await db.listSeats(code);

  const reclaim = seats.find((s) => s.name === name);
  if (reclaim) {
    reclaim.connected = true;
    await db.updateSeat(reclaim);
    room.lastActivityAt = now;
    await db.updateRoom(room);
    return await projectState(db, room, reclaim.seat);
  }

  if (room.phase !== 'lobby') throw new ServerError(409, 'game_started', 'That game already started.');
  const used = new Set(seats.map((s) => s.seat));
  let free = -1;
  for (let i = 0; i < MAX_SEATS; i++) {
    if (!used.has(i)) {
      free = i;
      break;
    }
  }
  if (free === -1) throw new ServerError(409, 'room_full', 'That room is full.');
  await db.insertSeat({ roomCode: code, seat: free, name, connected: true, hand: [], hasMelded: false });
  room.lastActivityAt = now;
  await db.updateRoom(room);
  return await projectState(db, room, free);
}

/**
 * Leave a room (marks the seat disconnected, keeps state for rejoin).
 * Empty lobby-phase rooms are deleted outright.
 */
export async function leaveRoom(
  db: Db,
  rawCode: unknown,
  seat: unknown,
  now: number = Date.now(),
): Promise<{ left: boolean; roomDeleted: boolean }> {
  const code = normalizeCode(rawCode);
  if (!Number.isInteger(seat)) throw new ServerError(400, 'bad_seat', 'Seat must be an integer.');
  const room = await db.getRoom(code);
  if (!room) throw new ServerError(404, 'no_room', 'No room with that code.');
  const row = await db.getSeat(code, seat as number);
  if (!row) throw new ServerError(404, 'no_seat', 'No such seat in that room.');
  row.connected = false;
  await db.updateSeat(row);
  room.lastActivityAt = now;
  await db.updateRoom(room);

  const seats = await db.listSeats(code);
  if (room.phase === 'lobby' && seats.every((s) => !s.connected)) {
    await db.deleteSeats(code);
    await db.deleteGame(code);
    await db.deleteRoom(code);
    return { left: true, roomDeleted: true };
  }
  return { left: true, roomDeleted: false };
}

/** State projection: own hand only for `yourSeat`, counts for everyone. */
export async function projectState(db: Db, room: RoomRow, yourSeat: number): Promise<PublicState> {
  const seats = (await db.listSeats(room.code)).sort((a, b) => a.seat - b.seat);
  const game = await db.getGame(room.code);
  const mine = seats.find((s) => s.seat === yourSeat);
  return {
    code: room.code,
    preset: room.preset,
    phase: room.phase,
    board: game?.board ?? [],
    poolCount: game?.pool.length ?? 0,
    turnSeat: game?.turnSeat ?? 0,
    winnerSeat: room.winnerSeat,
    seats: seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      connected: s.connected,
      handCount: s.hand.length,
      hasMelded: s.hasMelded,
    })),
    yourSeat,
    hand: mine ? [...mine.hand] : null,
  };
}
