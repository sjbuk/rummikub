import type { BoardSet, Tile } from '../src/game/types.ts';
import type { BoardPresetName } from './presets.ts';

/** Room code length (same 5-letter shape as the P2P client). */
export const ROOM_CODE_LEN = 5;

/** Normalize a user-supplied room code; throws 400 when malformed. */
export function normalizeCode(code: unknown): string {
  if (typeof code !== 'string') throw new ServerError(400, 'bad_code', 'Room code must be a string.');
  const c = code.trim().toUpperCase();
  if (!new RegExp(`^[A-Z2-9]{${ROOM_CODE_LEN}}$`).test(c)) {
    throw new ServerError(400, 'bad_code', 'Room code must be a 5-letter code.');
  }
  return c;
}

export type RoomPhase = 'lobby' | 'playing' | 'gameover';

/** Maximum seated players per room. */
export const MAX_SEATS = 4;

/** Max display-name length. */
export const MAX_NAME_LEN = 24;

/**
 * A lobby-listed room must have activity within this window, otherwise it
 * is hidden (same role as the P2P lobby TTL, server-appropriate scale).
 */
export const LOBBY_LIST_TTL_MS = 5 * 60_000;

/** Idle rooms older than this are deleted by cleanup. */
export const ROOM_MAX_IDLE_MS = 24 * 60 * 60_000;

/** Empty lobby-phase rooms older than this are deleted by cleanup. */
export const EMPTY_ROOM_TTL_MS = 60 * 60_000;

export interface RoomRow {
  code: string;
  hostName: string;
  isPublic: boolean;
  preset: BoardPresetName;
  phase: RoomPhase;
  winnerSeat: number | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface SeatRow {
  roomCode: string;
  seat: number;
  name: string;
  connected: boolean;
  hand: Tile[];
  hasMelded: boolean;
}

export interface GameRow {
  roomCode: string;
  board: BoardSet[];
  pool: Tile[];
  turnSeat: number;
  /** Live arrangement the turn holder is working on ([] = none). */
  draft: BoardSet[];
}

/** Public seat info: hand counts only, never tiles. */
export interface PublicSeat {
  seat: number;
  name: string;
  connected: boolean;
  handCount: number;
  hasMelded: boolean;
}

/** State projection sent to clients. `hand` is present only for the integer seat. */
export interface PublicState {
  code: string;
  preset: BoardPresetName;
  phase: RoomPhase;
  board: BoardSet[];
  poolCount: number;
  turnSeat: number;
  winnerSeat: number | null;
  seats: PublicSeat[];
  yourSeat: number;
  hand: Tile[] | null;
  /** Turn holder's live draft for everyone else; null for the holder. */
  draftView: BoardSet[] | null;
}

/** Lobby listing entry for one open public room. */
export interface RoomListing {
  code: string;
  name: string;
  seatsTaken: number;
  preset: BoardPresetName;
}

/** Storage backend. Edge functions use Supabase; tests use the in-memory fake. */
export interface Db {
  insertRoom(room: RoomRow): Promise<void>;
  getRoom(code: string): Promise<RoomRow | null>;
  updateRoom(room: RoomRow): Promise<void>;
  deleteRoom(code: string): Promise<void>;
  listPublicLobbyRooms(): Promise<RoomRow[]>;
  listAllRooms(): Promise<RoomRow[]>;
  insertSeat(seat: SeatRow): Promise<void>;
  getSeat(roomCode: string, seat: number): Promise<SeatRow | null>;
  listSeats(roomCode: string): Promise<SeatRow[]>;
  updateSeat(seat: SeatRow): Promise<void>;
  deleteSeats(roomCode: string): Promise<void>;
  getGame(roomCode: string): Promise<GameRow | null>;
  upsertGame(game: GameRow): Promise<void>;
  deleteGame(roomCode: string): Promise<void>;
}

/** Domain error with an HTTP status for the function wrapper. */
export class ServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
  }
}
