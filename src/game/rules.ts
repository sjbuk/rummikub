import type { BoardSet, Tile, TileColor } from './types';

export const INITIAL_MELD_MIN = 30;
export const HAND_SIZE = 14;

let idCounter = 0;
export function resetIds() {
  idCounter = 0;
}

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

/** Full 106-tile deck: 2 copies of each color×value plus 2 jokers. */
export function buildDeck(): Tile[] {
  resetIds();
  const colors: TileColor[] = ['red', 'blue', 'black', 'yellow'];
  const deck: Tile[] = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const color of colors) {
      for (let value = 1; value <= 13; value++) {
        deck.push({ id: nextId('t'), kind: 'number', color, value });
      }
    }
  }
  deck.push({ id: nextId('j'), kind: 'joker' });
  deck.push({ id: nextId('j'), kind: 'joker' });
  return deck;
}

export function shuffle<T>(deck: T[], rand: () => number = Math.random): T[] {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function tileValueForMeld(tile: Tile, assignedValue: number): number {
  if (tile.kind === 'joker') return assignedValue;
  return tile.value;
}

function isJoker(t: Tile): boolean {
  return t.kind === 'joker';
}

/**
 * Validate a GROUP: 3-4 tiles, same number, distinct colors, jokers wild.
 * Returns assigned joker values on success, null on failure.
 */
export function validateGroup(tiles: BoardSet): number[] | null {
  if (tiles.length < 3 || tiles.length > 4) return null;
  const numbers = tiles.filter((t) => !isJoker(t));
  if (numbers.length === 0) return null; // all-joker group is not a real meld
  const value = (numbers[0] as { value: number }).value;
  if (!numbers.every((t) => (t as { value: number }).value === value)) return null;
  const colors = new Set<string>();
  for (const t of numbers) {
    const c = (t as { color: string }).color;
    if (colors.has(c)) return null; // duplicate color (two copies of same tile)
    colors.add(c);
  }
  return tiles.map(() => value);
}

/**
 * Validate a RUN: 3+ tiles, same color, consecutive values, jokers fill gaps/ends.
 * Joker at an end extends the sequence; value 1 cannot wrap to 13.
 */
export function validateRun(tiles: BoardSet): number[] | null {
  if (tiles.length < 3) return null;
  const numbers = tiles.filter((t) => !isJoker(t));
  if (numbers.length === 0) return null;
  const color = (numbers[0] as { color: TileColor }).color;
  if (!numbers.every((t) => (t as { color: TileColor }).color === color)) return null;
  const values = numbers.map((t) => (t as { value: number }).value).sort((a, b) => a - b);
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) return null; // duplicate number in a run
  }
  const jokers = tiles.length - numbers.length;
  // Try every possible placement window: run occupies [start, start+len-1].
  // When several placements fit, keep the highest-scoring one (deterministic).
  const len = tiles.length;
  const minStart = Math.max(1, values[values.length - 1] - len + 1);
  const maxStart = Math.min(values[0], 14 - len);
  let best: number[] | null = null;
  let bestSum = -1;
  for (let start = minStart; start <= maxStart; start++) {
    const needed = new Set<number>();
    for (let v = start; v < start + len; v++) needed.add(v);
    for (const v of values) needed.delete(v);
    if (needed.size === jokers) {
      // Assign joker values in tile order: walk the run, filling missing slots.
      const missing = new Set(needed);
      const assigned: number[] = [];
      const counts = new Map<number, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      for (let v = start; v < start + len; v++) {
        if ((counts.get(v) ?? 0) > 0) {
          counts.set(v, (counts.get(v) ?? 0) - 1);
        } else if (missing.has(v)) {
          missing.delete(v);
          // placeholder: jokers get values in position order below
        }
      }
      // Assign jokers to the missing values in ascending order,
      // matched to joker tile positions in order.
      const missingSorted = [...needed].sort((a, b) => a - b);
      let ji = 0;
      let sum = 0;
      for (const t of tiles) {
        if (isJoker(t)) {
          const v = missingSorted[ji++];
          assigned.push(v);
          sum += v;
        } else {
          const fv = (t as { value: number }).value;
          assigned.push(fv);
          sum += fv;
        }
      }
      if (sum > bestSum) {
        bestSum = sum;
        best = assigned;
      }
    }
  }
  return best;
}

/** A set is valid if it is a valid group or a valid run. */
export function validateSet(tiles: BoardSet): { valid: boolean; values: number[] } {
  const g = validateGroup(tiles);
  if (g) return { valid: true, values: g };
  const r = validateRun(tiles);
  if (r) return { valid: true, values: r };
  return { valid: false, values: [] };
}

/** Whole board is valid when every set is valid and non-empty. */
export function validateBoard(board: BoardSet[]): boolean {
  if (board.length === 0) return true;
  return board.every((s) => s.length > 0 && validateSet(s).valid);
}

/** Sum of meld values; jokers count as the value they represent. */
export function scoreTiles(tiles: BoardSet, values: number[]): number {
  let sum = 0;
  for (let i = 0; i < tiles.length; i++) {
    sum += tileValueForMeld(tiles[i], values[i]);
  }
  return sum;
}

export interface TurnCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate an end-of-turn board.
 * - Board must be fully valid (no orphans).
 * - Every tile taken from the hand must be on the board.
 * - If the player has not yet made their initial meld, the newly placed
 *   tiles alone must form valid sets scoring >= 30, and the previous board
 *   must be unchanged (no manipulation before/with the initial meld).
 */
export function validateTurn(opts: {
  beforeBoard: BoardSet[];
  afterBoard: BoardSet[];
  placedIds: string[];
  hasMelded: boolean;
}): TurnCheck {
  const { beforeBoard, afterBoard, placedIds, hasMelded } = opts;
  if (!validateBoard(afterBoard)) {
    return { ok: false, reason: 'Board has an invalid or incomplete set.' };
  }
  const afterIds = new Set(afterBoard.flat().map((t) => t.id));
  for (const id of placedIds) {
    if (!afterIds.has(id)) {
      return { ok: false, reason: 'Tiles taken from your rack must end up on the board.' };
    }
  }
  if (!hasMelded) {
    const beforeIds = new Set(beforeBoard.flat().map((t) => t.id));
    if (afterIds.size !== beforeIds.size + placedIds.length) {
      return {
        ok: false,
        reason: 'Your first meld must come only from your rack — board tiles cannot be rearranged yet.',
      };
    }
    for (const id of beforeIds) {
      if (!afterIds.has(id)) {
        return {
          ok: false,
          reason: 'Your first meld must come only from your rack — board tiles cannot be rearranged yet.',
        };
      }
    }
    // Score only the newly placed tiles.
    const byId = new Map(afterBoard.flat().map((t) => [t.id, t] as const));
    const placed = placedIds.map((id) => byId.get(id)!).filter(Boolean);
    // They must partition into valid sets.
    const placedSet = new Set(placedIds);
    let score = 0;
    for (const s of afterBoard) {
      const fresh = s.filter((t) => placedSet.has(t.id));
      if (fresh.length === 0) continue;
      if (fresh.length !== s.length) {
        return { ok: false, reason: 'Initial meld tiles must form their own new set(s).' };
      }
      const v = validateSet(s);
      if (!v.valid) return { ok: false, reason: 'Initial meld contains an invalid set.' };
      score += scoreTiles(s, v.values);
    }
    if (score < INITIAL_MELD_MIN) {
      return { ok: false, reason: `Initial meld needs ${INITIAL_MELD_MIN} points (you have ${score}).` };
    }
    void placed;
  }
  return { ok: true };
}
