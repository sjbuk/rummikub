import { BOARD_PRESETS, type BoardPresetName } from '../../server/presets';
import type { PublicSeat } from '../../server/types';
import { validateTurn } from '../game/rules';
import {
  RACK_COLS,
  deriveRackSets,
  deriveSets,
  emptyGrid,
  emptyRack,
  findInvalidCells,
  firstEmptyRackSlot,
  layoutSetsToGrid,
  moveBoardSetToRack,
  moveRackSetToBoard,
  moveSet,
  moveTile,
  rackFromTiles,
  rackTiles,
  sortTiles,
  type Grid,
  type SortMode,
} from '../game/board';
import { attachTileDrag, installDoubleTapZoomGuard, type DragDest, type DragPayload, type TileDragHooks } from './drag';
import type { Tile } from '../game/types';
import { ServerApiError, api } from '../net/server';

type Selection =
  | { area: 'rack'; index: number }
  | { area: 'rackSet'; cells: number[] }
  | { area: 'cell'; cell: number }
  | { area: 'set'; cells: number[] }
  | null;

interface UiState {
  screen: 'lobby' | 'game';
  code: string;
  name: string;
  /** My seat index in the room. */
  seat: number;
  /** Hide my hosted game from the public lobby list. */
  isPrivate: boolean;
  /** Preset picked at creation; the server is authoritative after join. */
  preset: BoardPresetName;
  cols: number;
  rows: number;
  /** Open public games seen via the server lobby list. */
  openGames: { code: string; name: string; seatsTaken: number; preset: BoardPresetName }[];
  seats: PublicSeat[];
  /** Staging grid: the player's tiles, arranged freely between rounds. */
  rack: Grid;
  /** Rack arrangement when this turn started — Revert restores it. */
  turnStartRack: Grid | null;
  /** Last committed board as laid out locally. */
  board: Grid;
  draft: Grid | null;
  poolCount: number;
  turnSeat: number;
  phase: 'lobby' | 'playing' | 'gameover';
  winnerSeat: number | null;
  /** Id of the most recently drawn rack tile, for the "new tile" marker. */
  justDrewId: string | null;
  selection: Selection;
  sortMode: SortMode;
  /** Turn chime + banner enabled. Persisted in localStorage. */
  soundOn: boolean;
  message: string;
  messageKind: '' | 'error' | 'ok';
  /** Last server contact succeeded. */
  serverOk: boolean;
  /** Request in flight — buttons pause while true. */
  busy: boolean;
}

const el = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const TILE_LABEL: Record<string, string> = { red: 'R', blue: 'B', black: 'K', yellow: 'Y' };

const POLL_MS = 2500;
const LOBBY_POLL_MS = 5000;

export function createApp() {
  const appRoot = document.getElementById('app');
  if (!appRoot) throw new Error('#app not found');
  const root: HTMLElement = appRoot;
  const classic = BOARD_PRESETS.classic;
  const state: UiState = {
    screen: 'lobby',
    code: '',
    name: '',
    seat: 0,
    isPrivate: false,
    preset: 'classic',
    cols: classic.cols,
    rows: classic.rows,
    openGames: [],
    seats: [],
    rack: emptyRack(),
    turnStartRack: null,
    board: emptyGrid(),
    draft: null,
    poolCount: 0,
    turnSeat: 0,
    phase: 'lobby',
    winnerSeat: null,
    justDrewId: null,
    selection: null,
    sortMode: 'color',
    soundOn: ((): boolean => {
      try {
        return localStorage.getItem('rumikub-sound') !== 'off';
      } catch {
        return true;
      }
    })(),
    message: '',
    messageKind: '',
    serverOk: true,
    busy: false,
  };

  const myTurn = () =>
    state.screen === 'game' && state.phase === 'playing' && state.winnerSeat === null && state.turnSeat === state.seat;
  const mySeat = (): PublicSeat | undefined => state.seats.find((s) => s.seat === state.seat);
  const seatName = (seat: number): string => {
    const s = state.seats.find((x) => x.seat === seat);
    if (!s) return 'Player';
    return s.seat === state.seat ? (state.name || 'You') : s.name;
  };

  // ---------- turn alerts: banner, tab title, chime ----------
  let audioCtx: AudioContext | null = null;
  /** Turn state on the previous render — a false→true edge fires the alert. */
  let wasMyTurn = false;

  function ensureAudio(): AudioContext | null {
    if (!state.soundOn) return null;
    try {
      if (!audioCtx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
      }
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      return audioCtx;
    } catch {
      return null;
    }
  }

  /** Short two-tone "bing" synthesized with Web Audio — no asset needed. */
  function playTurnChime() {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime;
      const notes = [
        { freq: 659.25, at: 0 }, // E5
        { freq: 987.77, at: 0.12 }, // B5
      ];
      for (const { freq, at } of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.4);
      }
    } catch {
      // Sound is best-effort; the banner always shows.
    }
  }

  // Browsers gate audio behind a user gesture — unlock the context on first input.
  const unlockAudio = () => { ensureAudio(); };
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
  // #app persists across re-renders, so one guard covers every tile.
  installDoubleTapZoomGuard(root);

  function toggleSound() {
    state.soundOn = !state.soundOn;
    try {
      localStorage.setItem('rumikub-sound', state.soundOn ? 'on' : 'off');
    } catch {
      // Private-mode storage failure shouldn't break the toggle.
    }
    if (state.soundOn) playTurnChime();
    render();
  }

  /** Snapshot the staging grid so Revert can restore it with the board. */
  function snapshotTurnStart() {
    state.turnStartRack = [...state.rack];
  }

  /** Fire the turn alert once per false→true edge while a game is live. */
  function noteTurn() {
    const mine = myTurn();
    const becameMine = mine && !wasMyTurn && state.screen === 'game' && !state.winnerSeat;
    if (becameMine) snapshotTurnStart();
    wasMyTurn = mine;
    document.title = mine && state.screen === 'game' && state.winnerSeat === null
      ? 'Your turn! — Rummikub'
      : 'Rummikub';
    if (becameMine) playTurnChime();
  }

  const committedTiles = (): Tile[] => (state.board.filter(Boolean) as Tile[]);
  const committedIds = (): Set<string> => new Set(committedTiles().map((t) => t.id));

  function say(msg: string, kind: UiState['messageKind'] = '') {
    state.message = msg;
    state.messageKind = kind;
    paintMessage();
  }

  function sayApiError(e: unknown, fallback: string) {
    if (e instanceof ServerApiError) say(e.message || fallback, 'error');
    else say(fallback, 'error');
  }

  // ---------- server state ----------
  /** Fold a server projection into local state, preserving my arrangement. */
  function applyState(s: {
    preset: BoardPresetName;
    board: { id: string }[][];
    poolCount: number;
    turnSeat: number;
    phase: UiState['phase'];
    winnerSeat: number | null;
    seats: PublicSeat[];
    hand: Tile[] | null;
  }) {
    const dims = BOARD_PRESETS[s.preset];
    state.preset = s.preset;
    state.cols = dims.cols;
    state.rows = dims.rows;
    state.seats = s.seats;
    state.poolCount = s.poolCount;
    state.turnSeat = s.turnSeat;
    state.phase = s.phase;
    state.winnerSeat = s.winnerSeat;
    // Adopt the server board only when it actually changed (an opponent
    // committed). My own commit/draw responses rebuild explicitly below.
    const serverIds = new Set((s.board as { id: string }[][]).flat().map((t) => t.id));
    const localIds = committedIds();
    const same = serverIds.size === localIds.size && [...serverIds].every((id) => localIds.has(id));
    if (!same) {
      state.board = layoutSetsToGrid(s.board as import('../game/types').BoardSet[], dims.cols, dims.rows);
      state.draft = null;
    }
    syncRack(s.hand);
    state.serverOk = true;
  }

  /** Rebuild the staging grid when the server hand diverges (no draft: never clobber arranging). */
  function syncRack(hand: Tile[] | null) {
    if (!hand || state.draft) return;
    const a = hand.map((t) => t.id).sort().join(',');
    const b = rackTiles(state.rack).map((t) => t.id).sort().join(',');
    if (a !== b) {
      state.rack = rackFromTiles(sortTiles(hand, state.sortMode));
      state.turnStartRack = null;
    }
  }

  /** Rebuild staging + board straight from a response I caused. */
  function adoptResponse(s: { board: import('../game/types').BoardSet[]; hand: Tile[] | null } & {
    preset: BoardPresetName;
    poolCount: number;
    turnSeat: number;
    phase: UiState['phase'];
    winnerSeat: number | null;
    seats: PublicSeat[];
  }) {
    const dims = BOARD_PRESETS[s.preset];
    state.preset = s.preset;
    state.cols = dims.cols;
    state.rows = dims.rows;
    state.seats = s.seats;
    state.poolCount = s.poolCount;
    state.turnSeat = s.turnSeat;
    state.phase = s.phase;
    state.winnerSeat = s.winnerSeat;
    state.board = layoutSetsToGrid(s.board, dims.cols, dims.rows);
    state.draft = null;
    state.selection = null;
    state.turnStartRack = null;
    if (s.hand) state.rack = rackFromTiles(sortTiles(s.hand, state.sortMode));
    state.serverOk = true;
  }

  async function withBusy<T>(fn: () => Promise<T>): Promise<T | null> {
    if (state.busy) return null;
    state.busy = true;
    try {
      return await fn();
    } finally {
      state.busy = false;
    }
  }

  // ---------- polling ----------
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let lobbyTimer: ReturnType<typeof setInterval> | null = null;

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /** Poll the room while waiting or watching opponents; never on my own turn. */
  function loopPoll() {
    stopPoll();
    if (state.screen !== 'game' || myTurn() || state.phase === 'gameover') return;
    pollTimer = setTimeout(tick, POLL_MS);
  }

  async function tick() {
    pollTimer = null;
    if (state.screen !== 'game' || myTurn()) {
      loopPoll();
      return;
    }
    try {
      const s = await api.getState({ code: state.code, seat: state.seat });
      applyState(s);
      render();
    } catch (e) {
      if (e instanceof ServerApiError && (e.error === 'no_room' || e.error === 'no_seat')) {
        say('This room is gone — back to the lobby.', 'error');
        backToLobby();
        return;
      }
      state.serverOk = e instanceof ServerApiError ? e.status !== 0 : false;
      render();
    }
    loopPoll();
  }

  function startLobbyPoll() {
    stopLobbyPoll();
    void refreshLobby();
    lobbyTimer = setInterval(() => void refreshLobby(), LOBBY_POLL_MS);
  }

  function stopLobbyPoll() {
    if (lobbyTimer) {
      clearInterval(lobbyTimer);
      lobbyTimer = null;
    }
  }

  const lobbySignature = (): string => state.openGames.map((g) => `${g.code}=${g.name}:${g.seatsTaken}`).join('|');

  async function refreshLobby() {
    if (state.screen !== 'lobby') return;
    const before = lobbySignature();
    try {
      const { rooms } = await api.listRooms();
      state.openGames = rooms;
      state.serverOk = true;
    } catch {
      state.serverOk = false;
    }
    if (lobbySignature() !== before) render();
  }

  // ---------- room actions ----------
  function enterGame(code: string, seat: number) {
    state.code = code;
    state.seat = seat;
    state.screen = 'game';
    state.board = emptyGrid(state.cols * state.rows);
    state.draft = null;
    state.turnStartRack = null;
    state.selection = null;
    state.justDrewId = null;
    wasMyTurn = false;
    stopLobbyPoll();
    history.replaceState(null, '', `#room=${code}`);
    render();
    loopPoll();
  }

  async function doCreate(name: string, preset: BoardPresetName, isPrivate: boolean) {
    let s;
    try {
      s = await withBusy(() => api.createRoom({ name, isPublic: !isPrivate, preset }));
    } catch (e) {
      sayApiError(e, 'Could not create the room.');
      render();
      return;
    }
    if (!s) return;
    state.name = name.trim() || 'Host';
    applyState(s);
    say(isPrivate ? `Room ${s.code} created — share the code.` : `Room ${s.code} open — waiting for players.`, 'ok');
    enterGame(s.code, s.yourSeat);
  }

  async function doJoin(code: string, name: string) {
    const clean = code.trim().toUpperCase();
    if (!clean) return;
    let s;
    try {
      s = await withBusy(() => api.joinRoom({ code: clean, name }));
    } catch (e) {
      sayApiError(e, 'Could not join the room.');
      render();
      return;
    }
    if (!s) return;
    state.name = name.trim() || 'Guest';
    applyState(s);
    say(`Joined room ${s.code} as ${seatName(s.yourSeat)}.`, 'ok');
    enterGame(s.code, s.yourSeat);
  }

  async function doLeave() {
    stopPoll();
    try {
      await api.leaveRoom({ code: state.code, seat: state.seat });
    } catch {
      // Leaving is best-effort; the room expires on its own.
    }
    backToLobby();
  }

  function backToLobby() {
    stopPoll();
    Object.assign(state, {
      screen: 'lobby', code: '', seat: 0, seats: [], rack: emptyRack(), turnStartRack: null,
      board: emptyGrid(), draft: null, poolCount: 0, turnSeat: 0, phase: 'lobby',
      winnerSeat: null, selection: null, justDrewId: null, message: '', busy: false,
    } as Partial<UiState>);
    wasMyTurn = false;
    history.replaceState(null, '', location.pathname);
    startLobbyPoll();
    render();
  }

  async function doStart() {
    let s;
    try {
      s = await withBusy(() => api.startGame({ code: state.code, seat: state.seat }));
    } catch (e) {
      sayApiError(e, 'Could not start the game.');
      render();
      return;
    }
    if (!s) return;
    adoptResponse(s);
    say(state.turnSeat === state.seat ? 'Dealt! You start — meld 30+ or draw.' : 'Dealt! Watch for your turn.', 'ok');
    render();
    loopPoll();
  }

  // ---------- turn actions ----------
  function ensureDraft(): Grid {
    if (!state.draft) state.draft = [...state.board];
    return state.draft;
  }

  function draftTileIds(): string[] {
    if (!state.draft) return [];
    return (state.draft.filter(Boolean) as Tile[]).map((t) => t.id).sort();
  }

  function draftDiffers(): boolean {
    if (!state.draft) return false;
    const a = draftTileIds().join(',');
    const b = [...committedIds()].sort().join(',');
    return a !== b;
  }

  /** Tiles currently staged (slot order, gaps skipped). */
  const myTiles = (): Tile[] => rackTiles(state.rack);

  /** Sorts the staging grid in the current mode; the button label always names this same mode. */
  function sortHand() {
    // Manual keeps the player's arrangement; drawn tiles stay in their free slot.
    if (state.sortMode === 'manual') return;
    state.rack = rackFromTiles(sortTiles(myTiles(), state.sortMode));
  }

  /** A hand-arranged rack is manual from here on — auto-sort would undo it. */
  function markManual() {
    if (state.sortMode !== 'manual') {
      state.sortMode = 'manual';
      say('Manual staging order — your arrangement is kept; new tiles join the first free slot.');
    }
  }

  const SORT_LABEL: Record<SortMode, string> = {
    color: 'Sort: colour',
    number: 'Sort: number',
    manual: 'Sort: manual',
  };

  function cycleSortMode() {
    state.sortMode = state.sortMode === 'color' ? 'number' : state.sortMode === 'number' ? 'manual' : 'color';
    sortHand();
    if (state.sortMode === 'manual') say('Manual staging order — drag tiles to rearrange; new tiles join the first free slot.');
    render();
  }

  /** Swap two staging slots (moving into an empty one). Works between rounds too. */
  function moveRack(from: number, to: number) {
    if (from === to || !state.rack[from]) return;
    state.rack = moveTile(state.rack, from, to);
    state.selection = null;
    markManual();
  }

  /** Staging-grid arrangement vs the turn-start snapshot. */
  function rackDiffers(): boolean {
    if (!state.turnStartRack) return false;
    if (state.turnStartRack.length !== state.rack.length) return true;
    return state.turnStartRack.some((t, i) => (t?.id ?? null) !== (state.rack[i]?.id ?? null));
  }

  async function doDraw() {
    if (!myTurn() || state.busy) return;
    if (state.draft && draftDiffers()) {
      say('You moved tiles — End Turn or Revert before drawing.', 'error');
      return;
    }
    let s;
    try {
      s = await withBusy(() => api.drawTile({ code: state.code, seat: state.seat }));
    } catch (e) {
      sayApiError(e, 'Could not draw a tile.');
      render();
      return;
    }
    if (!s) return;
    adoptResponse(s);
    if (s.drew) {
      state.justDrewId = s.drew.id;
      sortHand();
      // Keep the auto-sort from swallowing the marker position: the mark is by id.
      say(`Drew a tile. ${state.turnSeat === state.seat ? 'Your turn.' : `${seatName(state.turnSeat)}'s turn.`}`);
    } else {
      state.justDrewId = null;
      say('Pool is empty — turn passes.', 'error');
    }
    render();
    loopPoll();
  }

  async function doEndTurn() {
    if (!myTurn() || state.busy) return;
    const grid = ensureDraft();
    const sets = deriveSets(grid, state.cols, state.rows).map((d) => d.tiles);
    const beforeIds = committedIds();
    const placedIds = sets.flat().map((t) => t.id).filter((id) => !beforeIds.has(id));
    if (placedIds.length === 0 && draftDiffers()) {
      say('Board changed but no rack tiles were played — Revert or play tiles.', 'error');
      return;
    }
    if (placedIds.length === 0) {
      say('Play tiles or Draw.', 'error');
      return;
    }
    // Fast local pre-check; the server re-validates authoritatively.
    const beforeSets = deriveSets(state.board, state.cols, state.rows).map((d) => d.tiles);
    const me = mySeat();
    const check = validateTurn({ beforeBoard: beforeSets, afterBoard: sets, placedIds, hasMelded: me?.hasMelded ?? false });
    if (!check.ok) {
      say(check.reason ?? 'Invalid turn.', 'error');
      return;
    }
    let s;
    try {
      s = await withBusy(() => api.commitTurn({ code: state.code, seat: state.seat, board: sets, placedIds }));
    } catch (e) {
      sayApiError(e, 'Server rejected the turn.');
      render();
      return;
    }
    if (!s) return;
    if (state.justDrewId && placedIds.includes(state.justDrewId)) state.justDrewId = null;
    adoptResponse(s);
    if (s.winnerSeat !== null && s.winnerSeat !== undefined) {
      say(s.winnerSeat === state.seat ? 'Rummikub! You win!' : `${seatName(s.winnerSeat)} wins.`, s.winnerSeat === state.seat ? 'ok' : 'error');
    } else {
      say(state.turnSeat === state.seat ? 'Your turn.' : `Nice play! ${seatName(state.turnSeat)}'s turn.`, 'ok');
    }
    render();
    loopPoll();
  }

  function doRevert() {
    // Restore the staging grid to the turn start and drop the draft.
    if (state.turnStartRack) state.rack = [...state.turnStartRack];
    state.draft = null;
    state.selection = null;
    say('Board and staging area reverted.');
    render();
  }
  // ---------- selection & placement on the slot grid ----------
  function setForCell(grid: Grid, cell: number): number[] | null {
    for (const d of deriveSets(grid, state.cols, state.rows)) {
      if (d.cells.includes(cell)) return d.cells;
    }
    return null;
  }

  /** Click (or drop) on a board cell with the current selection. */
  function handleCellTarget(cell: number) {
    const s = state.selection;
    if (!s) return;
    if (!myTurn()) {
      state.selection = null;
      say('Wait for your turn — stage tiles now, and play them when it starts.', 'error');
      render();
      return;
    }
    const draft = ensureDraft();
    if (s.area === 'rack') {
      const t = state.rack[s.index];
      if (!t) {
        state.selection = null;
        render();
        return;
      }
      const occ = draft[cell];
      state.rack[s.index] = occ ?? null;
      draft[cell] = t;
    } else if (s.area === 'rackSet') {
      const moved = moveRackSetToBoard(state.rack, draft, s.cells, cell, state.cols);
      if (!moved) {
        say("That set doesn't fit there — it needs a free stretch in one row.", 'error');
        return;
      }
      state.rack = moved.rack;
      state.draft = moved.board;
    } else if (s.area === 'cell') {
      state.draft = moveTile(draft, s.cell, cell);
    } else {
      const moved = moveSet(draft, s.cells, cell, state.cols);
      if (!moved) {
        say("That set doesn't fit there — it needs a free stretch in one row.", 'error');
        return;
      }
      state.draft = moved;
    }
    state.selection = null;
    render();
  }

  /** Click (or drop) on a staging slot with the current selection. */
  function handleRackTarget(slot: number) {
    const s = state.selection;
    if (!s) return;
    if (s.area === 'rack' || s.area === 'rackSet') {
      // Staging-to-staging is always allowed: prep freely, even between rounds.
      if (s.area === 'rack') moveRack(s.index, slot);
      else {
        const moved = moveSet(state.rack, s.cells, slot, RACK_COLS);
        if (!moved) {
          say("That set doesn't fit there — it needs a free stretch in one row.", 'error');
          return;
        }
        state.rack = moved;
        state.selection = null;
        markManual();
      }
      render();
      return;
    }
    if (!myTurn()) {
      // Between rounds a board selection just becomes a staging selection.
      state.selection = state.rack[slot] ? { area: 'rack', index: slot } : null;
      render();
      return;
    }
    if (s.area === 'cell') {
      // Return a rack-origin tile from the board to the staging grid (swap).
      const beforeIds = committedIds();
      const draft = ensureDraft();
      const tile = draft[s.cell];
      if (!tile || beforeIds.has(tile.id)) {
        say('Committed board tiles must stay on the board — rearrange them into valid sets.', 'error');
        return;
      }
      const occ = state.rack[slot];
      draft[s.cell] = occ;
      state.rack[slot] = tile;
      state.selection = null;
      render();
      return;
    }
    // Board sets may return to staging exactly like staging sets go to the
    // board — same "free stretch in one row" rule. Committed tiles stay put.
    const draft = ensureDraft();
    const tiles = s.cells.map((c) => draft[c]);
    if (tiles.some((t) => !t)) {
      state.selection = null;
      render();
      return;
    }
    const beforeIds = committedIds();
    if (tiles.some((t) => t && beforeIds.has(t.id))) {
      say('Committed board tiles must stay on the board — rearrange them into valid sets.', 'error');
      return;
    }
    const moved = moveBoardSetToRack(draft, state.rack, s.cells, slot);
    if (!moved) {
      say("That set doesn't fit there — it needs a free stretch in one row.", 'error');
      return;
    }
    state.draft = moved.board;
    state.rack = moved.rack;
    state.selection = null;
    markManual();
    render();
  }

  // Tap timing for set grabs. A re-render on every tap breaks the browser's
  // native dblclick, so a quick second tap on the same tile grabs its set.
  // One shared helper serves both grids: board taps key 'b<n>', staging 'r<n>'.
  let lastTap = { key: '', time: 0 };
  const DOUBLE_TAP_MS = 450;

  function isDoubleTap(key: string): boolean {
    const now = Date.now();
    const dbl = lastTap.key === key && now - lastTap.time < DOUBLE_TAP_MS;
    lastTap = { key, time: now };
    return dbl;
  }

  function shownGrid(): Grid {
    if (myTurn()) return state.draft ?? state.board;
    return state.board;
  }

  function clickCell(cell: number) {
    if (!myTurn()) return;
    const quickSecondTap = isDoubleTap(`b${cell}`);
    const s = state.selection;
    if (s?.area === 'cell' && s.cell === cell && quickSecondTap && shownGrid()[cell]) {
      grabSet(cell);
      return;
    }
    if (!s) {
      if (shownGrid()[cell]) state.selection = { area: 'cell', cell };
      render();
      return;
    }
    handleCellTarget(cell);
  }

  function grabSet(cell: number) {
    if (!myTurn()) return;
    const cells = setForCell(ensureDraft(), cell);
    if (cells && cells.length > 1) {
      state.selection = { area: 'set', cells };
      say('Whole set grabbed — click a destination cell to place it.');
      render();
    }
  }

  function rackSetForCell(cell: number): number[] | null {
    for (const d of deriveRackSets(state.rack)) {
      if (d.cells.includes(cell)) return d.cells;
    }
    return null;
  }

  function grabRackSet(cell: number) {
    const cells = rackSetForCell(cell);
    if (cells && cells.length > 1) {
      state.selection = { area: 'rackSet', cells };
      say(myTurn()
        ? 'Whole run grabbed — click a board cell to play it, or a staging slot to move it.'
        : 'Whole run grabbed — arrange it in staging, or play it when your turn comes.');
      render();
    }
  }

  function clickRackSlot(i: number) {
    const quickSecondTap = isDoubleTap(`r${i}`);
    const s = state.selection;
    if (s?.area === 'rack' && s.index === i) {
      // A quick second tap grabs the whole run, like the board's double-tap.
      if (quickSecondTap && state.rack[i]) {
        grabRackSet(i);
        return;
      }
      state.selection = null;
      render();
      return;
    }
    if (!s) {
      if (!state.rack[i]) return;
      state.selection = { area: 'rack', index: i };
      render();
      return;
    }
    handleRackTarget(i);
  }

  // ---------- unified press-drag-drop (one path for mouse, touch, pen) ----------
  /**
   * Resolve the drag payload at press time: pressing a tile of an already
   * grabbed set carries the whole set, anything else carries one tile.
   * Identical rule on both grids.
   */
  function boardPressPayload(cell: number): DragPayload {
    const sel = state.selection;
    if (sel?.area === 'set' && sel.cells.includes(cell)) return { area: 'board', cells: [...sel.cells] };
    return { area: 'board', cells: [cell] };
  }

  function rackPressPayload(slot: number): DragPayload {
    const sel = state.selection;
    if (sel?.area === 'rackSet' && sel.cells.includes(slot)) return { area: 'rack', cells: [...sel.cells] };
    return { area: 'rack', cells: [slot] };
  }

  /** A press released in place acts as a tap on the single pressed tile. */
  function tapTile(payload: DragPayload) {
    const at = payload.cells[0];
    if (at === undefined) return;
    if (payload.area === 'board') clickCell(at);
    else clickRackSlot(at);
  }

  /**
   * Commit a completed drag. Rebuilds the equivalent tap-tap selection from
   * the press-time payload and runs it through the same target handlers, so
   * drag-and-drop and click-click can never diverge.
   */
  function commitDragMove(payload: DragPayload, dest: DragDest) {
    if (payload.cells.length === 0) return;
    if (payload.area === 'rack') {
      state.selection = payload.cells.length > 1
        ? { area: 'rackSet', cells: [...payload.cells] }
        : { area: 'rack', index: payload.cells[0] };
    } else {
      state.selection = payload.cells.length > 1
        ? { area: 'set', cells: [...payload.cells] }
        : { area: 'cell', cell: payload.cells[0] };
    }
    if (dest.area === 'board') handleCellTarget(dest.index);
    else handleRackTarget(dest.index);
  }

  // ---------- rendering ----------
  function tileEl(tile: Tile, extra = ''): HTMLElement {
    const d = el('div', `tile ${tile.kind === 'joker' ? 'joker' : tile.color} ${extra}`.trim());
    // textContent keeps peer-independent rendering XSS-safe; values are ours.
    if (tile.kind === 'joker') {
      d.innerHTML = '<span>J★</span><small>JOKER</small>';
    } else {
      const span = el('span', '', String(tile.value));
      const small = el('small', '', TILE_LABEL[tile.color]);
      d.append(span, small);
    }
    return d;
  }

  function render() {
    noteTurn();
    root.innerHTML = '';
    if (state.screen === 'lobby') renderLobby();
    else renderGame();
  }

  function paintMessage() {
    const m = root.querySelector('[data-msg]');
    if (m) {
      m.textContent = state.message;
      m.className = `message status-message ${state.messageKind}`.trim();
    }
  }

  function serverPill(): HTMLElement {
    return el('div', 'pill', state.serverOk ? '● server' : '○ reconnecting…');
  }

  function renderLobby() {
    const wrap = el('div');
    const bar = el('div', 'topbar');
    bar.append(el('div', 'brand', 'Rummikub'), serverPill());
    const brand = bar.firstChild as HTMLElement;
    brand.innerHTML = 'Rummikub<small>2–4 players · game server</small>';
    wrap.append(bar);

    const grid = el('div', 'grid2');
    const hostCard = el('div', 'card');
    hostCard.append(el('h2', '', 'Host a game'), el('p', 'muted', 'Create a room for 2–4 players. You move first.'));
    const nameH = document.createElement('input');
    nameH.placeholder = 'Your name';
    nameH.value = state.name;
    nameH.oninput = () => { state.name = nameH.value; };
    const presetRow = el('div', 'preset-row');
    const presets: BoardPresetName[] = ['small', 'classic', 'large'];
    let picked: BoardPresetName = state.preset;
    for (const p of presets) {
      const label = document.createElement('label');
      label.className = 'check';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'preset';
      radio.checked = p === picked;
      radio.onchange = () => { picked = p; };
      const dims = BOARD_PRESETS[p];
      label.append(radio, document.createTextNode(` ${p} (${dims.cols}×${dims.rows})`));
      presetRow.append(label);
    }
    const hostBtn = el('button', '', 'Create room') as HTMLButtonElement;
    hostBtn.disabled = state.busy;
    hostBtn.onclick = () => void doCreate(nameH.value, picked, privBox.checked);
    const privLabel = document.createElement('label');
    privLabel.className = 'check';
    const privBox = document.createElement('input');
    privBox.type = 'checkbox';
    privBox.checked = state.isPrivate;
    privBox.onchange = () => {
      state.isPrivate = privBox.checked;
    };
    privLabel.append(privBox, document.createTextNode(' Private — hide from the open games list'));
    hostCard.append(nameH, el('br'), el('br'), presetRow, el('br'), hostBtn, privLabel);

    const joinCard = el('div', 'card');
    joinCard.append(el('h2', '', 'Join a game'), el('p', 'muted', 'Enter the room code from your host.'));
    const nameJ = document.createElement('input');
    nameJ.placeholder = 'Your name';
    nameJ.oninput = () => { state.name = nameJ.value; };
    const codeIn = document.createElement('input');
    codeIn.placeholder = 'ROOM CODE';
    codeIn.maxLength = 8;
    const fromHash = location.hash.match(/room=([A-Za-z0-9]+)/);
    if (fromHash) codeIn.value = fromHash[1].toUpperCase();
    const joinBtn = el('button', '', 'Join room') as HTMLButtonElement;
    joinBtn.disabled = state.busy;
    joinBtn.onclick = () => void doJoin(codeIn.value, nameJ.value);
    joinCard.append(nameJ, el('br'), el('br'), codeIn, el('br'), el('br'), joinBtn);

    grid.append(hostCard, joinCard);
    wrap.append(grid);

    const openCard = el('div', 'card');
    openCard.style.marginTop = '16px';
    openCard.append(el('h2', '', 'Open games'));
    if (state.openGames.length === 0) {
      openCard.append(el('p', 'muted', state.serverOk
        ? 'No open games right now — host one above or enter a code.'
        : 'Could not reach the game server — check your connection.'));
    } else {
      const list = el('div', 'open-list');
      for (const g of state.openGames) {
        const row = el('div', 'open-row');
        row.append(
          el('div', 'open-name', `${g.name}’s game (${g.seatsTaken}/4, ${g.preset})`),
          el('div', 'pill', g.code),
        );
        const joinOpen = el('button', '', 'Join') as HTMLButtonElement;
        joinOpen.disabled = state.busy;
        joinOpen.onclick = () => void doJoin(g.code, nameJ.value || state.name);
        row.append(joinOpen);
        list.append(row);
      }
      openCard.append(list);
    }
    wrap.append(openCard);
    const rules = el('div', 'card');
    rules.style.marginTop = '16px';
    rules.innerHTML = `<h2>How it works</h2>
      <p class="muted">Rooms run on the game server for 2–4 players — no accounts, just a name and a room code.
      First meld needs 30+ points from your own rack. After that you may rearrange the whole board, as long as every
      set is valid when you end your turn. The board is a grid of slots with a gap between sets: click a tile, then click
      its destination — tap twice to grab a whole set — or drag it.</p>`;
    wrap.append(rules);
    root.append(wrap);
    paintMessage();
  }

  function renderGame() {
    const wrap = el('div', 'game');
    const bar = el('div', 'topbar');
    const brand = el('div', 'brand inline');
    brand.innerHTML = `Rummikub <small>room <span class="code">${state.code}</span> · seat ${state.seat + 1} · ${state.preset}</small>`;
    const leave = el('button', 'secondary', 'Leave') as HTMLButtonElement;
    leave.onclick = () => void doLeave();
    bar.append(brand, leave);
    wrap.append(bar);

    const status = el('div', `statusbar${myTurn() && state.winnerSeat === null ? ' my-turn' : ''}`);
    const turnPill = el('div', `pill ${myTurn() ? 'turn' : ''}`,
      state.winnerSeat !== null ? `Winner: ${seatName(state.winnerSeat)}`
        : state.phase === 'lobby' ? 'Waiting to start…'
          : myTurn() ? 'Your turn — arrange, then End Turn'
            : `${seatName(state.turnSeat)}'s turn`);
    const soundBtn = el('button', 'secondary sound-toggle', state.soundOn ? 'Sound: on' : 'Sound: off') as HTMLButtonElement;
    soundBtn.title = 'Toggle the turn alert sound';
    soundBtn.onclick = toggleSound;
    // Game feedback (waiting, dealt, errors) lives in the status bar itself.
    const statusMsg = el('div', 'message status-message');
    statusMsg.setAttribute('data-msg', '1');
    status.append(
      turnPill,
      el('div', 'pill', `Pool: ${state.poolCount}`),
      el('div', 'pill', (mySeat()?.hasMelded ?? false) ? 'Melded ✓' : 'Need 30+ meld'),
      serverPill(),
      soundBtn,
      statusMsg,
    );
    wrap.append(status);

    // Screen-reader turn announcement that takes up no space.
    if (myTurn() && state.winnerSeat === null) {
      const live = el('div', 'sr-only', 'Your turn — play tiles or draw a tile');
      live.setAttribute('role', 'status');
      wrap.append(live);
    }

    // Seats strip: every player, hand counts, turn + connection markers.
    const seatsCard = el('div', 'card');
    const seatsList = el('div', 'open-list');
    for (const s of state.seats) {
      const row = el('div', 'open-row');
      const marker = s.seat === state.turnSeat && state.phase === 'playing' ? ' ▶' : '';
      row.append(
        el('div', 'open-name', `${s.seat === state.seat ? (state.name || 'You') : s.name}${s.seat === 0 ? ' (host)' : ''}${marker}`),
        el('div', 'pill', `${s.handCount} tiles${s.connected ? '' : ' · away'}`),
      );
      seatsList.append(row);
    }
    seatsCard.append(seatsList);
    // Waiting room: host starts when 2+ seats are connected.
    if (state.phase === 'lobby') {
      const connected = state.seats.filter((s) => s.connected).length;
      if (state.seat === 0) {
        const startBtn = el('button', '', connected >= 2 ? `Start game (${connected} players)` : 'Need 2+ players to start') as HTMLButtonElement;
        startBtn.disabled = state.busy || connected < 2;
        startBtn.onclick = () => void doStart();
        seatsCard.append(startBtn);
      } else {
        seatsCard.append(el('p', 'muted', 'Waiting for the host to start…'));
      }
    }
    wrap.append(seatsCard);

    if (myTurn()) ensureDraft();
    const grid = shownGrid();
    const setOfCell = new Map<number, number>();
    deriveSets(grid, state.cols, state.rows).forEach((d, i) => d.cells.forEach((c) => setOfCell.set(c, i)));
    const invalid = findInvalidCells(grid, state.cols, state.rows);

    // One drag controller for both grids (mouse, touch, pen). The grid
    // elements are assigned as they are built; no pointer event can fire
    // before this synchronous render returns.
    let boardGridRef: HTMLElement | null = null;
    let rackGridRef: HTMLElement | null = null;
    const dragHooks: TileDragHooks = {
      root: wrap,
      get boardGrid() { return boardGridRef as HTMLElement; },
      get rackGrid() { return rackGridRef as HTMLElement; },
      onTap: (p) => tapTile(p),
      onDrop: (p, d) => commitDragMove(p, d),
    };

    const boardCard = el('div', 'card');
    boardCard.append(el('h2', '', 'Board'));
    const boardEl = el('div', 'grid-board board-grid');
    boardEl.style.setProperty('--cols', String(state.cols));
    boardGridRef = boardEl;
    for (let cell = 0; cell < state.cols * state.rows; cell++) {
      const tile = grid[cell];
      const cellEl = el('div', 'cell' + (tile ? '' : ' empty'));
      const setIdx = setOfCell.get(cell);
      if (setIdx !== undefined) cellEl.classList.add(setIdx % 2 === 0 ? 's0' : 's1');
      if (invalid.has(cell)) cellEl.classList.add('invalid');
      const sel = state.selection;
      const isSel =
        (sel?.area === 'cell' && sel.cell === cell) ||
        (sel?.area === 'set' && sel.cells.includes(cell));
      if (tile) {
        const tEl = tileEl(tile, isSel ? 'selected' : '');
        attachTileDrag(tEl, boardPressPayload(cell), dragHooks);
        cellEl.append(tEl);
      } else {
        cellEl.onclick = () => clickCell(cell);
      }
      boardEl.append(cellEl);
    }
    boardCard.append(boardEl);
    wrap.append(boardCard);

    const rack = el('div', `rack${myTurn() ? ' my-turn' : ''}`);
    rack.append(el('h3', '', `${state.name || 'You'} — staging (${myTiles().length})`));
    const rackBody = el('div', 'rack-body');
    const rackGridEl = el('div', 'grid-board rack-grid');
    rackGridEl.style.setProperty('--cols', String(RACK_COLS));
    rackGridRef = rackGridEl;

    const rackSetOfCell = new Map<number, number>();
    deriveRackSets(state.rack).forEach((d, i) => d.cells.forEach((c) => rackSetOfCell.set(c, i)));
    for (let slot = 0; slot < state.rack.length; slot++) {
      const tile = state.rack[slot];
      const cellEl = el('div', 'cell' + (tile ? '' : ' empty'));
      const setIdx = rackSetOfCell.get(slot);
      if (setIdx !== undefined) cellEl.classList.add(setIdx % 2 === 0 ? 's0' : 's1');
      const sel = state.selection;
      const isSel =
        (sel?.area === 'rack' && sel.index === slot) ||
        (sel?.area === 'rackSet' && sel.cells.includes(slot));
      if (tile) {
        const t = tile;
        const i = slot;
        const isNew = state.justDrewId !== null && t.id === state.justDrewId;
        const tEl = tileEl(t, `${isSel ? 'selected' : ''} ${isNew ? 'just-drew' : ''}`.trim());
        if (isNew) tEl.title = 'Just drawn';
        attachTileDrag(tEl, rackPressPayload(i), dragHooks);
        cellEl.append(tEl);
      } else {
        cellEl.onclick = () => clickRackSlot(slot);
      }
      rackGridEl.append(cellEl);
    }
    rackBody.append(rackGridEl);

    const toolbar = el('div', 'toolbar vertical');
    const endBtn = el('button', '', 'End Turn') as HTMLButtonElement;
    endBtn.disabled = !myTurn() || state.busy;
    endBtn.onclick = () => void doEndTurn();
    const drawBtn = el('button', 'secondary', 'Draw tile') as HTMLButtonElement;
    drawBtn.disabled = !myTurn() || state.busy;
    drawBtn.onclick = () => void doDraw();
    const sortBtn = el('button', 'secondary', SORT_LABEL[state.sortMode]) as HTMLButtonElement;
    sortBtn.title = 'Staging order — click to cycle colour, number, manual';
    sortBtn.onclick = cycleSortMode;
    const revertBtn = el('button', 'secondary', 'Revert board') as HTMLButtonElement;
    revertBtn.disabled = !myTurn() || (!draftDiffers() && !rackDiffers());
    revertBtn.title = 'Restore the board and staging grid to the turn start';
    revertBtn.onclick = doRevert;
    toolbar.append(endBtn, drawBtn, sortBtn, revertBtn);
    rackBody.append(toolbar);
    rack.append(rackBody);
    wrap.append(rack);
    root.append(wrap);
    paintMessage();
  }

  startLobbyPoll();
  render();
  return { render, state };
}
