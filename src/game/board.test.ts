import { describe, expect, it } from 'vitest';
import {
  GRID_COLS,
  GRID_SIZE,
  RACK_COLS,
  RACK_SIZE,
  canPlaceSet,
  deriveRackSets,
  deriveSets,
  emptyGrid,
  emptyRack,
  findInvalidCells,
  firstEmptyRackSlot,
  insertRackTile,
  layoutSetsToGrid,
  moveBoardSetToRack,
  moveRackSetToBoard,
  moveSet,
  moveTile,
  rackFromTiles,
  rackTiles,
  sortTiles,
} from './board';
import type { Tile } from './types';

function num(value: number, id: string): Tile {
  return { id, kind: 'number', color: 'red', value };
}
function blue(value: number, id: string): Tile {
  return { id, kind: 'number', color: 'blue', value };
}

describe('slot grid', () => {
  it('lays sets out with one empty slot between them', () => {
    const grid = layoutSetsToGrid([
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(5, 'd'), num(5, 'e'), num(5, 'f')],
    ]);
    expect(grid[0]?.id).toBe('a');
    expect(grid[2]?.id).toBe('c');
    expect(grid[3]).toBeNull(); // gap
    expect(grid[4]?.id).toBe('d');
  });
  it('wraps a set that no longer fits to the next row', () => {
    const long = Array.from({ length: GRID_COLS - 1 }, (_, i) => num((i % 13) + 1, `t${i}`));
    const grid = layoutSetsToGrid([long, [num(1, 'x'), num(2, 'y'), num(3, 'z')]]);
    // First set occupies row 0 cols 0..13, gap would be col 14, so next set wraps.
    expect(grid[GRID_COLS]?.id).toBe('x');
  });
  it('lays out and reads back with preset dimensions', () => {
    const sets = [
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(7, 'd'), num(7, 'e'), num(7, 'f')],
    ];
    const cols = 12;
    const rows = 4;
    const grid = layoutSetsToGrid(sets, cols, rows);
    expect(grid).toHaveLength(cols * rows);
    const back = deriveSets(grid, cols, rows).map((s) => s.tiles.map((t) => t.id));
    expect(back).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
    expect(emptyGrid(cols * rows)).toHaveLength(cols * rows);
  });
  it('drops sets past a small grid instead of overflowing', () => {
    const sets = [
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(4, 'd'), num(5, 'e'), num(6, 'f')],
    ];
    const grid = layoutSetsToGrid(sets, 4, 1); // one row of 4: only the first set fits
    expect(deriveSets(grid, 4, 1).map((s) => s.tiles.map((t) => t.id))).toEqual([['a', 'b', 'c']]);
  });
  it('moves a rack set onto a narrow board', () => {
    const rack = [num(1, 'a'), num(2, 'b'), null, null];
    const board = emptyGrid(12 * 4);
    const moved = moveRackSetToBoard(rack, board, [0, 1], 10, 12);
    expect(moved?.board[10]?.id).toBe('a');
    expect(moved?.board[11]?.id).toBe('b');
    expect(moveRackSetToBoard(rack, board, [0, 1], 11, 12)).toBeNull(); // would wrap
  });
  it('round-trips sets through the grid', () => {
    const sets = [
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(7, 'd'), num(7, 'e'), num(7, 'f'), num(7, 'g')],
    ];
    const back = deriveSets(layoutSetsToGrid(sets)).map((s) => s.tiles.map((t) => t.id));
    expect(back).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f', 'g'],
    ]);
  });
  it('swaps two tiles with moveTile', () => {
    const grid = layoutSetsToGrid([[num(1, 'a'), num(2, 'b'), num(3, 'c')]]);
    const moved = moveTile(grid, 0, 2);
    expect(moved[0]?.id).toBe('c');
    expect(moved[2]?.id).toBe('a');
  });
  it('relocates a whole set to a free stretch', () => {
    const grid = layoutSetsToGrid([
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(5, 'd'), num(5, 'e'), num(5, 'f')],
    ]);
    const cells = [0, 1, 2];
    const moved = moveSet(grid, cells, 8);
    expect(moved).not.toBeNull();
    expect(moved![8]?.id).toBe('a');
    expect(moved![10]?.id).toBe('c');
    expect(moved![0]).toBeNull();
  });
  it('starts with a fully empty grid', () => {
    const g = emptyGrid();
    expect(g).toHaveLength(GRID_SIZE);
    expect(g.every((c) => c === null)).toBe(true);
  });
  it('sorts the rack by colour then number', () => {
    const hand = [blue(3, 'b3'), num(11, 'r11'), blue(1, 'b1'), num(2, 'r2'), { id: 'j1', kind: 'joker' } as Tile];
    expect(sortTiles(hand, 'color').map((t) => t.id)).toEqual(['r2', 'r11', 'b1', 'b3', 'j1']);
  });
  it('sorts the rack by number, jokers last', () => {
    const hand = [blue(3, 'b3'), num(11, 'r11'), blue(1, 'b1'), num(2, 'r2'), { id: 'j1', kind: 'joker' } as Tile];
    expect(sortTiles(hand, 'number').map((t) => t.id)).toEqual(['b1', 'r2', 'b3', 'r11', 'j1']);
  });
  it('keeps the player arrangement untouched in manual mode', () => {
    const hand = [blue(3, 'b3'), num(11, 'r11'), blue(1, 'b1'), num(2, 'r2'), { id: 'j1', kind: 'joker' } as Tile];
    const sorted = sortTiles(hand, 'manual');
    expect(sorted.map((t) => t.id)).toEqual(['b3', 'r11', 'b1', 'r2', 'j1']);
    expect(sorted).not.toBe(hand); // a copy, so later pushes can't alias the old rack
  });
  it('inserts a dragged rack tile into a gap instead of swapping', () => {
    const hand = [num(1, 'a'), num(2, 'b'), num(3, 'c'), num(4, 'd')];
    // Drop a left of the gap before c.
    expect(insertRackTile(hand, 0, 2).map((t) => t.id)).toEqual(['b', 'a', 'c', 'd']);
    // Drop d into the gap after a.
    expect(insertRackTile(hand, 3, 1).map((t) => t.id)).toEqual(['a', 'd', 'b', 'c']);
    // Drop b to the end.
    expect(insertRackTile(hand, 1, 4).map((t) => t.id)).toEqual(['a', 'c', 'd', 'b']);
    // Dropping back into its own gap is a no-op.
    expect(insertRackTile(hand, 1, 2).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('ignores out-of-range rack gaps without mutating', () => {
    const hand = [num(1, 'a'), num(2, 'b')];
    expect(insertRackTile(hand, 5, 0).map((t) => t.id)).toEqual(['a', 'b']);
    expect(insertRackTile(hand, 0, 9).map((t) => t.id)).toEqual(['a', 'b']);
    expect(insertRackTile(hand, NaN, 0).map((t) => t.id)).toEqual(['a', 'b']);
    const out = insertRackTile(hand, 0, 1);
    expect(out).not.toBe(hand);
    expect(hand.map((t) => t.id)).toEqual(['a', 'b']);
  });
  it('leaves same-number tiles in rack order when sorting by number', () => {
    const hand = [blue(5, 'b5'), num(2, 'r2'), num(5, 'r5'), blue(2, 'b2'), { id: 'j1', kind: 'joker' } as Tile];
    expect(sortTiles(hand, 'number').map((t) => t.id)).toEqual(['r2', 'b2', 'b5', 'r5', 'j1']);
  });
  it('flags cells of invalid sets, including singles', () => {
    const grid = layoutSetsToGrid([
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(5, 'd'), num(7, 'e')],
      [num(9, 'f')],
    ]);
    const bad = findInvalidCells(grid);
    expect(bad.has(0)).toBe(false);
    expect([...bad].sort((x, y) => x - y)).toEqual([4, 5, 7]);
  });
  it('refuses a set move that overlaps foreign tiles or the row end', () => {
    const grid = layoutSetsToGrid([
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(5, 'd'), num(5, 'e'), num(5, 'f')],
    ]);
    expect(moveSet(grid, [0, 1, 2], 4)).toBeNull(); // overlaps second set
    expect(moveSet(grid, [0, 1, 2], GRID_COLS - 2)).toBeNull(); // past row end
  });
});

describe('staging grid', () => {
  it('packs tiles into a 2x16 grid and reads them back in slot order', () => {
    const tiles = [num(1, 'a'), blue(2, 'b'), num(3, 'c')];
    const rack = rackFromTiles(tiles);
    expect(rack).toHaveLength(RACK_SIZE);
    expect(rackTiles(rack).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(emptyRack()).toHaveLength(RACK_SIZE);
    expect(emptyRack().every((c) => c === null)).toBe(true);
  });
  it('finds the first free slot and grows by a row when full', () => {
    const rack = rackFromTiles([num(1, 'a'), num(2, 'b')]);
    rack[0] = null;
    expect(firstEmptyRackSlot(rack)).toBe(0);
    const full = rackFromTiles(Array.from({ length: RACK_SIZE }, (_, i) => num((i % 13) + 1, `t${i}`)));
    const grownAt = firstEmptyRackSlot(full);
    expect(grownAt).toBe(RACK_SIZE);
    expect(full).toHaveLength(RACK_SIZE + RACK_COLS);
  });
  it('reads contiguous runs as sets with the rack column count', () => {
    const rack = emptyRack();
    rack[0] = num(1, 'a');
    rack[1] = num(2, 'b');
    rack[2] = num(3, 'c');
    rack[RACK_COLS] = blue(5, 'd');
    const sets = deriveRackSets(rack).map((s) => s.cells);
    expect(sets).toEqual([[0, 1, 2], [RACK_COLS]]);
  });
  it('moves a whole run within the staging grid like on the board', () => {
    const rack = emptyRack();
    rack[0] = num(1, 'a');
    rack[1] = num(2, 'b');
    rack[2] = num(3, 'c');
    const moved = moveSet(rack, [0, 1, 2], 5, RACK_COLS);
    expect(moved?.[5]?.id).toBe('a');
    expect(moved?.[7]?.id).toBe('c');
    expect(moved?.[0]).toBeNull();
    expect(moveSet(rack, [0, 1, 2], RACK_COLS - 2, RACK_COLS)).toBeNull(); // past row end
  });
  it('lifts a staged run onto the board and clears its slots', () => {
    const rack = emptyRack();
    rack[0] = num(1, 'a');
    rack[1] = num(2, 'b');
    rack[2] = num(3, 'c');
    const board = emptyGrid();
    const moved = moveRackSetToBoard(rack, board, [0, 1, 2], 4);
    expect(moved?.board[4]?.id).toBe('a');
    expect(moved?.board[6]?.id).toBe('c');
    expect(moved?.rack.slice(0, 3).every((c) => c === null)).toBe(true);
  });
  it('refuses a staged run that overlaps board tiles or the row end', () => {
    const rack = emptyRack();
    rack[0] = num(1, 'a');
    rack[1] = num(2, 'b');
    const board = emptyGrid();
    board[5] = blue(9, 'x');
    expect(moveRackSetToBoard(rack, board, [0, 1], 4)).toBeNull(); // overlaps x
    expect(moveRackSetToBoard(rack, board, [0, 1], GRID_COLS - 1)).toBeNull(); // past row end
  });
  it('returns a board run to the staging grid and clears its cells', () => {
    const board = emptyGrid();
    board[0] = num(1, 'a');
    board[1] = num(2, 'b');
    board[2] = num(3, 'c');
    const rack = emptyRack();
    const moved = moveBoardSetToRack(board, rack, [0, 1, 2], 5);
    expect(moved?.rack[5]?.id).toBe('a');
    expect(moved?.rack[7]?.id).toBe('c');
    expect(moved?.board.slice(0, 3).every((c) => c === null)).toBe(true);
  });
  it('refuses a board run that overlaps staging tiles or the row end', () => {
    const board = emptyGrid();
    board[0] = num(1, 'a');
    board[1] = num(2, 'b');
    const rack = emptyRack();
    rack[6] = blue(9, 'x');
    expect(moveBoardSetToRack(board, rack, [0, 1], 5)).toBeNull(); // overlaps x
    expect(moveBoardSetToRack(board, rack, [0, 1], RACK_COLS - 1)).toBeNull(); // past row end
    expect(moveBoardSetToRack(board, rack, [], 5)).toBeNull();
  });
  it('checks set fit without moving anything', () => {
    const grid = layoutSetsToGrid([
      [num(1, 'a'), num(2, 'b'), num(3, 'c')],
      [num(5, 'd'), num(5, 'e'), num(5, 'f')],
    ]);
    expect(canPlaceSet(grid, [0, 1, 2], 8)).toBe(true);
    expect(canPlaceSet(grid, [0, 1, 2], 4)).toBe(false); // overlaps second set
    expect(canPlaceSet(grid, [0, 1, 2], GRID_COLS - 2)).toBe(false); // past row end
    expect(canPlaceSet(grid, [], 8)).toBe(false);
    // A set dropped back onto the stretch it already owns still fits.
    expect(canPlaceSet(grid, [8, 9, 10], 8)).toBe(true);
  });
});
