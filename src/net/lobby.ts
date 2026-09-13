/**
 * Open-game discovery for the serverless lobby.
 *
 * There is no game server, so public hosts announce themselves in one
 * well-known room (`LOBBY_CODE`) with a periodic heartbeat. Guests watching
 * the lobby collect announcements into a list and drop entries that go
 * quiet. Private hosts never join the lobby room, so they stay invisible.
 */

/** Fixed room code where public hosts announce open games. */
export const LOBBY_CODE = 'rumikub-lobby-v1';

/** How often a waiting host re-announces its game. */
export const ANNOUNCE_MS = 10_000;

/** How long a guest keeps a listing without a fresh heartbeat. */
export const LISTING_TTL_MS = 25_000;

export type LobbyMessage =
  | { t: 'hosting'; code: string; name: string }
  | { t: 'closed'; code: string };

export interface OpenGame {
  code: string;
  name: string;
  seenAt: number;
}

/** Shape-check an inbound lobby message; anything else is ignored. */
export function isLobbyMessage(v: unknown): v is LobbyMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m.t === 'hosting') return typeof m.code === 'string' && typeof m.name === 'string';
  if (m.t === 'closed') return typeof m.code === 'string';
  return false;
}

/**
 * Fold one announcement into the listing: `hosting` inserts or refreshes,
 * `closed` removes. Empty codes are ignored.
 */
export function upsertGame(games: OpenGame[], msg: LobbyMessage, now: number): OpenGame[] {
  if (msg.t === 'closed') return games.filter((g) => g.code !== msg.code);
  const code = msg.code.trim().toUpperCase();
  if (!code) return games;
  const name = msg.name.trim() || 'Host';
  return [...games.filter((g) => g.code !== code), { code, name, seenAt: now }];
}

/** Drop listings not refreshed within the TTL. */
export function pruneGames(games: OpenGame[], now: number): OpenGame[] {
  return games.filter((g) => now - g.seenAt < LISTING_TTL_MS);
}
