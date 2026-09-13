import { BOARD_PRESETS, type BoardPresetName } from '../../server/presets';
import type { BoardSet, Tile } from '../game/types';
import type { PublicState, RoomListing } from '../../server/types';

export { BOARD_PRESETS, type BoardPresetName };

/** Deployed functions base; override locally with VITE_SUPABASE_FUNCTIONS_URL. */
export const DEFAULT_FUNCTIONS_BASE = 'https://rsixhrxpngtjxchevakc.supabase.co/functions/v1';

export function functionsBase(): string {
  const custom = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined;
  return (custom && custom.trim()) || DEFAULT_FUNCTIONS_BASE;
}

/** API error with the function's HTTP status and stable error name. */
export class ServerApiError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.name = 'ServerApiError';
    this.status = status;
    this.error = error;
  }
}

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${functionsBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServerApiError(0, 'network', 'Could not reach the game server.');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON (gateway) error below.
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: unknown; message?: unknown };
    throw new ServerApiError(
      res.status,
      typeof err.error === 'string' ? err.error : 'request_failed',
      typeof err.message === 'string' ? err.message : `Server request failed (${res.status}).`,
    );
  }
  return data as T;
}

export interface DrawResult extends PublicState {
  drew: Tile | null;
}

export const api = {
  createRoom: (input: { name: string; isPublic: boolean; preset: BoardPresetName }) =>
    call<PublicState>('/rooms-create', input),
  listRooms: () => call<{ rooms: RoomListing[] }>('/rooms-list', undefined, 'GET'),
  joinRoom: (input: { code: string; name: string }) => call<PublicState>('/rooms-join', input),
  leaveRoom: (input: { code: string; seat: number }) =>
    call<{ left: boolean; roomDeleted: boolean }>('/rooms-leave', input),
  startGame: (input: { code: string; seat: number }) => call<PublicState>('/game-start', input),
  commitTurn: (input: { code: string; seat: number; board: BoardSet[]; placedIds: string[] }) =>
    call<PublicState>('/game-commit', input),
  drawTile: (input: { code: string; seat: number }) => call<DrawResult>('/game-draw', input),
  getState: (input: { code: string; seat: number }) => call<PublicState>('/rooms-state', input),
};
