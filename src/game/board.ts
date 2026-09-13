import type { BoardSet, Tile } from './types';
import { validateSet } from './rules';

export const GRID_COLS = 18;
export const GRID_ROWS = 6;
export const GRID_SIZE = GRID_COLS * GRID_ROWS;

/** Player staging area: a smaller 2-row sibling of the main board grid. */
export const RACK_COLS = 16;
export const RACK_ROWS = 2;
export const RACK_SIZE = RACK_COLS * RACK_ROWS;

/** Main board: fixed grid of slots, each holding a tile or nothing. */
export type Grid = (Tile | null)[];

export function emptyGrid(size: number = GRID_SIZE): Grid {
  return Array<Tile | null>(size).fill(null);
}

/** Empty player staging grid. Grows by whole rows when a big hand needs it. */
export function emptyRack(): Grid {
  return Array<Tile | null>(RACK_SIZE).fill(null);
}

/** Tiles held in a rack grid, in slot order. */
export function rackTiles(rack: Grid): Tile[] {
  return rack.filter(Boolean) as Tile[];
}

/** Pack tiles compactly into the first slots (extra rows if they overflow). */
export function rackFromTiles(tiles: Tile[]): Grid {
  const size = Math.max(RACK_SIZE, Math.ceil(tiles.length / RACK_COLS) * RACK_COLS);
  const rack: Grid = Array<Tile | null>(size).fill(null);
  tiles.forEach((t, i) => { rack[i] = t; });
  return rack;
}

/** First empty rack slot, appending a fresh row when the rack is full. */
export function firstEmptyRackSlot(rack: Grid): number {
  const empty = rack.indexOf(null);
  if (empty !== -1) return empty;
  const grown = rack.length;
  for (let i = 0; i < RACK_COLS; i++) rack.push(null);
  return grown;
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

export function cellRow(cell: number, cols: number = GRID_COLS): number {
  return Math.floor(cell / cols);
}
export function cellCol(cell: number, cols: number = GRID_COLS): number {
  return cell % cols;
}

/**
 * Lay committed sets into the grid, left to right with one empty slot
 * between sets, wrapping to the next row when a set no longer fits.
 * Defaults match the classic preset; pass the room preset dims instead.
 */
export function layoutSetsToGrid(sets: BoardSet[], cols: number = GRID_COLS, rows: number = GRID_ROWS): Grid {
  const grid: Grid = Array<Tile | null>(cols * rows).fill(null);
  let r = 0;
  let c = 0;
  for (const set of sets) {
    if (set.length === 0) continue;
    if (c + set.length > cols) {
      r++;
      c = 0;
    }
    if (r >= rows) break; // overflow guard: committed sets beyond capacity are dropped
    for (const t of set) {
      grid[r * cols + c] = t;
      c++;
    }
    c++; // one empty slot between sets
    if (c >= cols) {
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
export function deriveSets(grid: Grid, cols: number = GRID_COLS, rows: number = GRID_ROWS): DerivedSet[] {
  const out: DerivedSet[] = [];
  let cur: DerivedSet | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const t = c < cols ? grid[r * cols + c] : null;
      if (t) {
        if (!cur) cur = { tiles: [], cells: [] };
        cur.tiles.push(t);
        cur.cells.push(r * cols + c);
      } else if (cur) {
        out.push(cur);
        cur = null;
      }
    }
  }
  return out;
}

/** Sets within the player staging grid (same contiguous-run reading). */
export function deriveRackSets(rack: Grid): DerivedSet[] {
  return deriveSets(rack, RACK_COLS, Math.max(RACK_ROWS, Math.ceil(rack.length / RACK_COLS)));
}

/** Cells belonging to currently-invalid sets (singles and pairs included). */
export function findInvalidCells(grid: Grid, cols: number = GRID_COLS, rows: number = GRID_ROWS): Set<number> {
  const bad = new Set<number>();
  for (const d of deriveSets(grid, cols, rows)) {
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
export function moveSet(grid: Grid, cells: number[], target: number, cols: number = GRID_COLS): Grid | null {
  if (!canPlaceSet(grid, cells, target, cols)) return null;
  const tRow = cellRow(target, cols);
  const tCol = cellCol(target, cols);
  const tiles = cells.map((c) => grid[c]);
  const g = [...grid];
  for (const c of cells) g[c] = null;
  for (let k = 0; k < cells.length; k++) g[tRow * cols + tCol + k] = tiles[k];
  return g;
}

/**
 * Whether `cells.length` tiles fit starting at `target` (same row, no
 * overlap with foreign tiles). Cells the set already owns don't block it.
 * Shared by the drag highlight and the move helpers below.
 */
export function canPlaceSet(grid: Grid, cells: number[], target: number, cols: number = GRID_COLS): boolean {
  if (cells.length === 0 || target < 0) return false;
  const tRow = cellRow(target, cols);
  const tCol = cellCol(target, cols);
  if (tCol + cells.length > cols) return false;
  const first = tRow * cols + tCol;
  if (first + cells.length > grid.length) return false;
  const moving = new Set(cells);
  for (let k = 0; k < cells.length; k++) {
    const slot = first + k;
    if (grid[slot] && !moving.has(slot)) return false;
  }
  return true;
}

/**
 * Lift a whole contiguous run from the staging grid onto the board.
 * The board target needs a free stretch in one row; the rack cells clear.
 */
export function moveRackSetToBoard(rack: Grid, board: Grid, cells: number[], target: number, cols: number = GRID_COLS): { rack: Grid; board: Grid } | null {
  if (cells.length === 0) return null;
  const tRow = cellRow(target, cols);
  const tCol = cellCol(target, cols);
  if (tCol + cells.length > cols) return null;
  // Strict occupancy: cross-grid moves have no owned-cell carve-out.
  // (canPlaceSet covers the same-grid case used for hover highlights.)
  for (let k = 0; k < cells.length; k++) {
    if (board[tRow * cols + tCol + k]) return null;
  }
  const tiles = cells.map((c) => rack[c]);
  if (tiles.some((t) => !t)) return null;
  const nextRack = [...rack];
  const nextBoard = [...board];
  for (const c of cells) nextRack[c] = null;
  for (let k = 0; k < cells.length; k++) nextBoard[tRow * cols + tCol + k] = tiles[k];
  return { rack: nextRack, board: nextBoard };
}

/**
 * Mirror of moveRackSetToBoard: return a whole board run to the staging
 * grid. The staging target needs a free stretch in one rack row; the board
 * cells clear. Enables identical set-drag interactions on both grids.
 */
export function moveBoardSetToRack(board: Grid, rack: Grid, cells: number[], target: number): { board: Grid; rack: Grid } | null {
  if (cells.length === 0) return null;
  const tRow = cellRow(target, RACK_COLS);
  const tCol = cellCol(target, RACK_COLS);
  if (tCol + cells.length > RACK_COLS) return null;
  const first = tRow * RACK_COLS + tCol;
  // Grow the caller's view conceptually: targets past the current rack end
  // count as empty (the UI appends a row on commit when needed).
  for (let k = 0; k < cells.length; k++) {
    if ((rack[first + k] ?? null) !== null) return null;
  }
  const tiles = cells.map((c) => board[c]);
  if (tiles.some((t) => !t)) return null;
  const nextBoard = [...board];
  const nextRack = [...rack];
  while (nextRack.length < first + cells.length) nextRack.push(null);
  for (const c of cells) nextBoard[c] = null;
  for (let k = 0; k < cells.length; k++) nextRack[first + k] = tiles[k];
  return { board: nextBoard, rack: nextRack };
}
