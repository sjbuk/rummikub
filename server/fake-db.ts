import type { Db, GameRow, RoomRow, SeatRow } from './types.ts';

/** In-memory Db for unit tests (and local experimentation). */
export function makeFakeDb(): Db {
  const rooms = new Map<string, RoomRow>();
  const seats = new Map<string, SeatRow[]>();
  const games = new Map<string, GameRow>();

  const cloneRoom = (r: RoomRow): RoomRow => ({ ...r });
  const cloneSeat = (s: SeatRow): SeatRow => ({ ...s, hand: [...s.hand] });
  const cloneGame = (g: GameRow): GameRow => ({
    ...g,
    board: g.board.map((set) => [...set]),
    pool: [...g.pool],
    draft: g.draft.map((set) => [...set]),
  });

  return {
    async insertRoom(room) {
      rooms.set(room.code, cloneRoom(room));
    },
    async getRoom(code) {
      const r = rooms.get(code);
      return r ? cloneRoom(r) : null;
    },
    async updateRoom(room) {
      rooms.set(room.code, cloneRoom(room));
    },
    async deleteRoom(code) {
      rooms.delete(code);
    },
    async listPublicLobbyRooms() {
      return [...rooms.values()].filter((r) => r.isPublic).map(cloneRoom);
    },
    async listAllRooms() {
      return [...rooms.values()].map(cloneRoom);
    },
    async insertSeat(seat) {
      const list = seats.get(seat.roomCode) ?? [];
      seats.set(seat.roomCode, [...list, cloneSeat(seat)]);
    },
    async getSeat(roomCode, seat) {
      const found = (seats.get(roomCode) ?? []).find((s) => s.seat === seat);
      return found ? cloneSeat(found) : null;
    },
    async listSeats(roomCode) {
      return (seats.get(roomCode) ?? []).map(cloneSeat);
    },
    async updateSeat(seat) {
      const list = seats.get(seat.roomCode) ?? [];
      seats.set(
        seat.roomCode,
        list.map((s) => (s.seat === seat.seat ? cloneSeat(seat) : s)),
      );
    },
    async deleteSeats(roomCode) {
      seats.delete(roomCode);
    },
    async getGame(roomCode) {
      const g = games.get(roomCode);
      return g ? cloneGame(g) : null;
    },
    async upsertGame(game) {
      games.set(game.roomCode, cloneGame(game));
    },
    async deleteGame(roomCode) {
      games.delete(roomCode);
    },
  };
}
