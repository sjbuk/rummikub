import { commitTurn, drawTile, startGame } from './game.ts';
import { createRoom, joinRoom, leaveRoom, listRooms } from './rooms.ts';
import {
  EMPTY_ROOM_TTL_MS,
  ROOM_MAX_IDLE_MS,
  type Db,
  ServerError,
} from './types.ts';

export interface ApiResult {
  status: number;
  body: unknown;
}

function ok(body: unknown): ApiResult {
  return { status: 200, body };
}

function err(e: unknown): ApiResult {
  if (e instanceof ServerError) return { status: e.status, body: { error: e.code, message: e.message } };
  return { status: 500, body: { error: 'internal', message: 'Unexpected server error.' } };
}

export interface CallDeps {
  now?: number;
  rand?: () => number;
  code?: string;
}

const seatOf = (v: unknown): unknown => (v as { seat?: unknown })?.seat;
const codeOf = (v: unknown): unknown => (v as { code?: unknown })?.code;
const nameOf = (v: unknown): unknown => (v as { name?: unknown })?.name;

/** POST /rooms-create { name, isPublic?, preset? } */
export async function handleRoomsCreate(db: Db, input: unknown, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    const body = input as { name?: unknown; isPublic?: unknown; preset?: unknown };
    return ok(await createRoom(db, { name: body?.name, isPublic: body?.isPublic, preset: body?.preset }, deps));
  } catch (e) {
    return err(e);
  }
}

/** GET /rooms-list */
export async function handleRoomsList(db: Db, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    return ok({ rooms: await listRooms(db, deps.now ?? Date.now()) });
  } catch (e) {
    return err(e);
  }
}

/** POST /rooms-join { code, name } */
export async function handleRoomsJoin(db: Db, input: unknown, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    return ok(await joinRoom(db, codeOf(input), nameOf(input), deps));
  } catch (e) {
    return err(e);
  }
}

/** POST /rooms-leave { code, seat } */
export async function handleRoomsLeave(db: Db, input: unknown, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    return ok(await leaveRoom(db, codeOf(input), seatOf(input), deps.now ?? Date.now()));
  } catch (e) {
    return err(e);
  }
}

/** POST /game-start { code, seat } — host (seat 0) only. */
export async function handleGameStart(db: Db, input: unknown, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    return ok(await startGame(db, codeOf(input), seatOf(input), deps));
  } catch (e) {
    return err(e);
  }
}

/** POST /game-commit { code, seat, board, placedIds } */
export async function handleGameCommit(db: Db, input: unknown, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    const body = input as { board?: unknown; placedIds?: unknown };
    return ok(
      await commitTurn(
        db,
        codeOf(input),
        seatOf(input),
        { board: body?.board, placedIds: body?.placedIds },
        deps.now ?? Date.now(),
      ),
    );
  } catch (e) {
    return err(e);
  }
}

/** POST /game-draw { code, seat } */
export async function handleGameDraw(db: Db, input: unknown, deps: CallDeps = {}): Promise<ApiResult> {
  try {
    return ok(await drawTile(db, codeOf(input), seatOf(input), deps.now ?? Date.now()));
  } catch (e) {
    return err(e);
  }
}

/**
 * Scheduled cleanup: deletes rooms idle beyond ROOM_MAX_IDLE_MS, plus
 * lobby-phase rooms with no connected seats idle beyond EMPTY_ROOM_TTL_MS.
 * Returns the number of rooms deleted.
 */
export async function handleRoomsCleanup(db: Db, now: number = Date.now()): Promise<ApiResult> {
  try {
    const rooms = await db.listAllRooms();
    let deleted = 0;
    for (const room of rooms) {
      const idle = now - room.lastActivityAt;
      if (idle < ROOM_MAX_IDLE_MS) {
        if (room.phase !== 'lobby' || idle < EMPTY_ROOM_TTL_MS) continue;
        const seats = await db.listSeats(room.code);
        if (seats.some((s) => s.connected)) continue;
      }
      await db.deleteSeats(room.code);
      await db.deleteGame(room.code);
      await db.deleteRoom(room.code);
      deleted++;
    }
    return ok({ deleted });
  } catch (e) {
    return err(e);
  }
}
