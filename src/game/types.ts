export type TileColor = 'red' | 'blue' | 'black' | 'yellow';

export interface NumberTile {
  id: string;
  kind: 'number';
  color: TileColor;
  value: number; // 1..13
}

export interface JokerTile {
  id: string;
  kind: 'joker';
}

export type Tile = NumberTile | JokerTile;

/** A set on the board: a group (same number) or run (same color sequence). */
export type BoardSet = Tile[];

export interface PlayerState {
  id: string;
  name: string;
  hand: Tile[];
  hasMelded: boolean;
  handCount?: number; // for remote display when hand is private
}

export type GamePhase = 'lobby' | 'playing' | 'gameover';

export interface PublicState {
  board: BoardSet[];
  poolCount: number;
  turn: string; // player id
  phase: GamePhase;
  winnerId?: string;
}
