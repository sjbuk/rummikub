import { describe, expect, it } from 'vitest';
import {
  buildDeck,
  scoreTiles,
  validateBoard,
  validateGroup,
  validateRun,
  validateSet,
  validateTurn,
} from './rules';
import type { Tile } from './types';

function num(color: 'red' | 'blue' | 'black' | 'yellow', value: number, id: string): Tile {
  return { id, kind: 'number', color, value };
}
function joker(id: string): Tile {
  return { id, kind: 'joker' };
}

describe('deck', () => {
  it('builds 106 tiles with unique ids', () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(106);
    expect(new Set(deck.map((t) => t.id)).size).toBe(106);
    expect(deck.filter((t) => t.kind === 'joker')).toHaveLength(2);
  });
});

describe('groups', () => {
  it('accepts a valid 3-tile group', () => {
    const v = validateGroup([num('red', 5, 'a'), num('black', 5, 'b'), num('yellow', 5, 'c')]);
    expect(v).toEqual([5, 5, 5]);
  });
  it('rejects duplicate colors', () => {
    expect(validateGroup([num('red', 5, 'a'), num('red', 5, 'b'), num('blue', 5, 'c')])).toBeNull();
  });
  it('rejects mixed values', () => {
    expect(validateGroup([num('red', 5, 'a'), num('blue', 6, 'b'), num('black', 5, 'c')])).toBeNull();
  });
  it('allows a joker in a group', () => {
    const v = validateGroup([num('red', 7, 'a'), num('blue', 7, 'b'), joker('j1')]);
    expect(v).toEqual([7, 7, 7]);
  });
  it('rejects groups longer than 4', () => {
    expect(
      validateGroup([num('red', 7, 'a'), num('blue', 7, 'b'), num('black', 7, 'c'), num('yellow', 7, 'd'), joker('j1')]),
    ).toBeNull();
  });
});

describe('runs', () => {
  it('accepts a plain run', () => {
    const tiles = [num('red', 4, 'a'), num('red', 5, 'b'), num('red', 6, 'c')];
    expect(validateRun(tiles)).toEqual([4, 5, 6]);
  });
  it('rejects mixed colors', () => {
    expect(validateRun([num('red', 4, 'a'), num('blue', 5, 'b'), num('red', 6, 'c')])).toBeNull();
  });
  it('fills a gap with a joker', () => {
    const tiles = [num('blue', 7, 'a'), joker('j1'), num('blue', 9, 'b')];
    const v = validateRun(tiles);
    expect(v).not.toBeNull();
    expect(scoreTiles(tiles, v!)).toBe(24); // 7 + 8 + 9
  });
  it('extends at the end with a joker', () => {
    const tiles = [num('yellow', 10, 'a'), num('yellow', 11, 'b'), joker('j1')];
    const v = validateRun(tiles);
    expect(v).not.toBeNull();
    expect(scoreTiles(tiles, v!)).toBe(33);
  });
  it('rejects duplicates in a run', () => {
    expect(validateRun([num('red', 5, 'a'), num('red', 5, 'b'), num('red', 6, 'c')])).toBeNull();
  });
});

describe('board and turns', () => {
  it('accepts a fully valid board', () => {
    expect(
      validateBoard([
        [num('red', 1, 'a'), num('red', 2, 'b'), num('red', 3, 'c')],
        [num('blue', 9, 'd'), num('red', 9, 'e'), num('black', 9, 'f')],
      ]),
    ).toBe(true);
  });
  it('rejects a board with an invalid set', () => {
    expect(validateBoard([[num('red', 1, 'a'), num('red', 3, 'b')]])).toBe(false);
  });
  it('accepts an initial meld of exactly 30', () => {
    const after = [
      [num('red', 10, 'a'), num('blue', 10, 'b'), num('black', 10, 'c')], // 30
    ];
    expect(validateTurn({ beforeBoard: [], afterBoard: after, placedIds: ['a', 'b', 'c'], hasMelded: false }).ok).toBe(true);
  });
  it('rejects an initial meld under 30', () => {
    const after = [[num('red', 5, 'a'), num('blue', 5, 'b'), num('black', 5, 'c')]];
    const r = validateTurn({ beforeBoard: [], afterBoard: after, placedIds: ['a', 'b', 'c'], hasMelded: false });
    expect(r.ok).toBe(false);
  });
  it('rejects rearranging the board before the initial meld', () => {
    const before = [[num('red', 1, 'a'), num('red', 2, 'b'), num('red', 3, 'c')]];
    const after = [
      [num('red', 1, 'a'), num('red', 2, 'b'), num('red', 3, 'c')],
      [num('blue', 10, 'd'), num('red', 10, 'e'), num('black', 10, 'f')],
    ];
    // Board tiles unchanged here, so this is fine (new set appended).
    expect(validateTurn({ beforeBoard: before, afterBoard: after, placedIds: ['d', 'e', 'f'], hasMelded: false }).ok).toBe(true);
    // But splitting the existing run for the first meld is not allowed.
    const sneaky = [
      [num('red', 1, 'a'), num('red', 2, 'b')],
      [num('red', 3, 'c'), num('blue', 10, 'd'), num('red', 10, 'e'), num('black', 10, 'f')],
    ];
    expect(validateTurn({ beforeBoard: before, afterBoard: sneaky, placedIds: ['d', 'e', 'f'], hasMelded: false }).ok).toBe(false);
  });
  it('accepts board manipulation after melding', () => {
    const before = [[num('red', 4, 'a'), num('red', 5, 'b'), num('red', 6, 'c'), num('red', 7, 'd')]];
    const after = [
      [num('red', 4, 'a'), num('red', 5, 'b'), num('red', 6, 'c')],
      [num('red', 7, 'd'), num('red', 8, 'e'), num('red', 9, 'f')],
    ];
    expect(validateSet(after[1]).valid).toBe(true);
    expect(validateTurn({ beforeBoard: before, afterBoard: after, placedIds: ['e', 'f'], hasMelded: true }).ok).toBe(true);
  });
  it('requires placed tiles to end on the board', () => {
    const r = validateTurn({ beforeBoard: [], afterBoard: [], placedIds: ['x'], hasMelded: true });
    expect(r.ok).toBe(false);
  });
});
