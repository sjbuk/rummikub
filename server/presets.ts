import type { BoardSet, Tile } from '../src/game/types.ts';

/** Fixed board-size presets selectable at room creation. */
export const BOARD_PRESETS = {
  small: { cols: 12, rows: 4 },
  classic: { cols: 18, rows: 6 },
  large: { cols: 24, rows: 8 },
} as const;

export type BoardPresetName = keyof typeof BOARD_PRESETS;

export function isBoardPresetName(v: unknown): v is BoardPresetName {
  return typeof v === 'string' && v in BOARD_PRESETS;
}

/** Total tile slots for a preset grid. */
export function presetCapacity(preset: BoardPresetName): number {
  const p = BOARD_PRESETS[preset];
  return p.cols * p.rows;
}
