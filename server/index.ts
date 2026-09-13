export { BOARD_PRESETS, isBoardPresetName, presetCapacity, type BoardPresetName } from './presets.ts';
export {
  commitTurn,
  checkBoard,
  checkDraft,
  checkTile,
  drawTile,
  nextTurn,
  startGame,
  submitDraft,
  turnOrder,
} from './game.ts';
export {
  handleGameCommit,
  handleGameDraft,
  handleGameDraw,
  handleGameStart,
  handleRoomsCleanup,
  handleRoomsCreate,
  handleRoomsJoin,
  handleRoomsLeave,
  handleRoomsList,
  handleRoomsState,
  type ApiResult,
  type CallDeps,
} from './handlers.ts';
export { makeFakeDb } from './fake-db.ts';
export {
  createRoom,
  joinRoom,
  leaveRoom,
  listRooms,
  normalizeName,
  projectState,
  randomCode,
} from './rooms.ts';
export {
  EMPTY_ROOM_TTL_MS,
  LOBBY_LIST_TTL_MS,
  MAX_NAME_LEN,
  MAX_SEATS,
  ROOM_CODE_LEN,
  ROOM_MAX_IDLE_MS,
  ServerError,
  normalizeCode,
  type Db,
  type GameRow,
  type PublicSeat,
  type PublicState,
  type RoomListing,
  type RoomPhase,
  type RoomRow,
  type SeatRow,
} from './types.ts';
