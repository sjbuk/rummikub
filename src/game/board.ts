import type { BoardSet, Tile } from './types';
import { validateSet } from './rules';

export const GRID_COLS = 15;
export const GRID_ROWS = 6;
export const GRID_SIZE = GRID_COLS * GRID_ROWS;

/** Main board: fixed grid of slots, each holding a tile or nothing. */
export type Grid = (Tile | null)[];

export function emptyGrid(): Grid {
  return Array<Tile | null>(GRID_SIZE).fill(null);
}

export type SortMode = 'color' | 'number' | 'manual';

const COLOR_ORDER: Record<string, number> = { red: 0, blue: 1, black: 2, yellow: 3 };

function compareTiles(a: Tile, b: Tile, mode: SortMode): number {
  if (a.kind === 'joker') return 1;
  if (b.kind === 'joker') return -1;
  if (mode === 'number') {
    // Value only — sort is stable, so same-number tiles keep their rack order.
    return a.value - b.value;
  }
  return COLOR_ORDER[a.color] - COLOR_ORDER[b.color] || a.value - b.value;
}

/**
 * Rack sorting. `color` groups by colour then number; `number` orders by
 * value only. Jokers last. `manual` keeps the player's own arrangement.
 */
export function sortTiles(hand: Tile[], mode: SortMode): Tile[] {
  if (mode === 'manual') return [...hand];
  return [...hand].sort((a, b) => compareTiles(a, b, mode));
}

/**
 * Move the rack tile at `from` into the `gap` between tiles (0..hand.length).
 * Dropping left of tile i is gap i, right of it gap i + 1, so the tile lands
 * between its neighbours instead of swapping. Out-of-range input returns an
 * unchanged copy.
 */
export function insertRackTile(hand: Tile[], from: number, gap: number): Tile[] {
  const next = [...hand];
  if (!Number.isInteger(from) || !Number.isInteger(gap)) return next;
  if (from < 0 || from >= hand.length || gap < 0 || gap > hand.length) return next;
  const [t] = next.splice(from, 1);
  next.splice(gap > from ? gap - 1 : gap, 0, t);
  return next;
}

export function cellRow(cell: number): number {
  return Math.floor(cell / GRID_COLS);
}
export function cellCol(cell: number): number {
  return cell % GRID_COLS;
}

/**
 * Lay committed sets into the grid, left to right with one empty slot
 * between sets, wrapping to the next row when a set no longer fits.
 */
export function layoutSetsToGrid(sets: BoardSet[]): Grid {
  const grid: Grid = Array<Tile | null>(GRID_SIZE).fill(null);
  let r = 0;
  let c = 0;
  for (const set of sets) {
    if (set.length === 0) continue;
    if (c + set.length > GRID_COLS) {
      r++;
      c = 0;
    }
    if (r >= GRID_ROWS) break; // overflow guard: 90 slots far exceeds 2-player needs
    for (const t of set) {
      grid[r * GRID_COLS + c] = t;
      c++;
    }
    c++; // one empty slot between sets
    if (c >= GRID_COLS) {
      r++;
      c = 0;
    }
  }
  return grid;
}

export interface DerivedSet {
  tiles: Tile[];
  cells: number[];
}

/** Read back sets as the maximal contiguous tile runs within each row. */
export function deriveSets(grid: Grid): DerivedSet[] {
  const out: DerivedSet[] = [];
  let cur: DerivedSet | null = null;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c <= GRID_COLS; c++) {
      const t = c < GRID_COLS ? grid[r * GRID_COLS + c] : null;
      if (t) {
        if (!cur) cur = { tiles: [], cells: [] };
        cur.tiles.push(t);
        cur.cells.push(r * GRID_COLS + c);
      } else if (cur) {
        out.push(cur);
        cur = null;
      }
    }
  }
  return out;
}

/** Cells belonging to currently-invalid sets (singles and pairs included). */
export function findInvalidCells(grid: Grid): Set<number> {
  const bad = new Set<number>();
  for (const d of deriveSets(grid)) {
    if (!validateSet(d.tiles).valid) {
      d.cells.forEach((c) => bad.add(c));
    }
  }
  return bad;
}

/** Move a single tile (swap with whatever occupies the target, if anything). */
export function moveTile(grid: Grid, from: number, to: number): Grid {
  const g = [...grid];
  if (from === to) return g;
  const tmp = g[to];
  g[to] = g[from];
  g[from] = tmp;
  return g;
}

/**
 * Relocate a whole set so it starts at `target` (same row, must fit).
 * Cells the set already owns don't block it. Returns null when blocked.
 */
export function moveSet(grid: Grid, cells: number[], target: number): Grid | null {
  if (cells.length === 0) return null;
  const moving = new Set(cells);
  const tRow = cellRow(target);
  const tCol = cellCol(target);
  if (tCol + cells.length > GRID_COLS) return null;
  for (let k = 0; k < cells.length; k++) {
    const occ = grid[tRow * GRID_COLS + tCol + k];
    if (occ && !moving.has(tRow * GRID_COLS + tCol + k)) return null;
  }
  const tiles = cells.map((c) => grid[c]);
  const g = [...grid];
  for (const c of cells) g[c] = null;
  for (let k = 0; k < cells.length; k++) g[tRow * GRID_COLS + tCol + k] = tiles[k];
  return g;
}
