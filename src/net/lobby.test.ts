import { describe, expect, it } from 'vitest';
import {
  LISTING_TTL_MS,
  isLobbyMessage,
  pruneGames,
  upsertGame,
  type OpenGame,
} from './lobby';

const NOW = 1_000_000;

function game(code: string, seenAt: number, name = 'Host'): OpenGame {
  return { code, name, seenAt };
}

describe('lobby listings', () => {
  it('adds a new listing from a hosting announcement', () => {
    const out = upsertGame([], { t: 'hosting', code: 'abc12', name: 'Stu' }, NOW);
    expect(out).toEqual([{ code: 'ABC12', name: 'Stu', seenAt: NOW }]);
  });

  it('refreshes an existing code instead of duplicating it', () => {
    const before = [game('ABC12', NOW - 5000, 'Stu')];
    const out = upsertGame(before, { t: 'hosting', code: 'abc12', name: 'Stuart' }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ code: 'ABC12', name: 'Stuart', seenAt: NOW });
  });

  it('falls back to a default name and ignores empty codes', () => {
    const unnamed = upsertGame([], { t: 'hosting', code: 'ZZ999', name: '   ' }, NOW);
    expect(unnamed[0].name).toBe('Host');
    expect(upsertGame([], { t: 'hosting', code: '   ', name: 'Stu' }, NOW)).toEqual([]);
  });

  it('removes the listing on a closed announcement', () => {
    const before = [game('ABC12', NOW), game('XYZ99', NOW)];
    expect(upsertGame(before, { t: 'closed', code: 'ABC12' }, NOW)).toEqual([game('XYZ99', NOW)]);
  });

  it('prunes stale listings but keeps fresh ones', () => {
    const games = [
      game('OLD11', NOW - LISTING_TTL_MS - 1),
      game('EDGE2', NOW - LISTING_TTL_MS + 1000),
      game('NEW33', NOW),
    ];
    expect(pruneGames(games, NOW).map((g) => g.code)).toEqual(['EDGE2', 'NEW33']);
  });

  it('accepts only well-shaped inbound messages', () => {
    expect(isLobbyMessage({ t: 'hosting', code: 'A', name: 'B' })).toBe(true);
    expect(isLobbyMessage({ t: 'closed', code: 'A' })).toBe(true);
    expect(isLobbyMessage({ t: 'hosting', code: 'A' })).toBe(false);
    expect(isLobbyMessage({ t: 'closed', code: 42 })).toBe(false);
    expect(isLobbyMessage({ t: 'deal', hand: [] })).toBe(false);
    expect(isLobbyMessage(null)).toBe(false);
    expect(isLobbyMessage('hosting')).toBe(false);
  });
});
