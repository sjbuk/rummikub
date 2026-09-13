import { buildDeck, shuffle, validateTurn, HAND_SIZE } from '../game/rules';
import {
  GRID_COLS,
  GRID_ROWS,
  RACK_COLS,
  deriveRackSets,
  deriveSets,
  emptyGrid,
  emptyRack,
  findInvalidCells,
  firstEmptyRackSlot,
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
import { attachTileDrag, type DragDest, type DragPayload, type TileDragHooks } from './drag';
import type { Tile } from '../game/types';
import { makeLobbyRoom, makeRoom, randomCode, type LobbyHandle, type NetHandle, type NetMessage } from '../net/p2p';
import {
  ANNOUNCE_MS,
  isLobbyMessage,
  pruneGames,
  upsertGame,
  type OpenGame,
} from '../net/lobby';

type Role = 'host' | 'guest';
type Selection =
  | { area: 'rack'; index: number }
  | { area: 'rackSet'; cells: number[] }
  | { area: 'cell'; cell: number }
  | { area: 'set'; cells: number[] }
  | null;

interface UiState {
  screen: 'lobby' | 'game';
  role: Role;
  code: string;
  name: string;
  peerName: string;
  /** Hide my hosted game from the public lobby list. */
  isPrivate: boolean;
  /** Open public games seen via lobby announcements. */
  openGames: OpenGame[];
  /** Staging grid (2×16 slots): the player's tiles, arranged freely between rounds. */
  rack: Grid;
  /** Rack arrangement when this turn started — Revert restores it alongside the board. */
  turnStartRack: Grid | null;
  board: Grid;
  draft: Grid | null;
  /** Live view of the opponent's in-progress turn. Cleared on commit/draw. */
  peerView: Grid | null;
  pool: Tile[]; // host only
  poolCount: number;
  turn: Role;
  melded: boolean;
  peerMelded: boolean;
  peerHandCount: number;
  /** Id of the most recently drawn rack tile, for the "new tile" marker. */
  justDrewId: string | null;
  winner: Role | null;
  selection: Selection;
  sortMode: SortMode;
  /** Turn chime + banner enabled. Persisted in localStorage. */
  soundOn: boolean;
  message: string;
  messageKind: '' | 'error' | 'ok';
  connected: boolean;
  dealt: boolean;
}

const el = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const TILE_LABEL: Record<string, string> = { red: 'R', blue: 'B', black: 'K', yellow: 'Y' };

export function createApp() {
  const appRoot = document.getElementById('app');
  if (!appRoot) throw new Error('#app not found');
  const root: HTMLElement = appRoot;
  let net: NetHandle | null = null;
  const state: UiState = {
    screen: 'lobby',
    role: 'host',
    code: '',
    name: '',
    peerName: 'Opponent',
    isPrivate: false,
    openGames: [],
    rack: emptyRack(),
    turnStartRack: null,
    board: emptyGrid(),
    draft: null,
    peerView: null,
    pool: [],
    poolCount: 0,
    turn: 'host',
    melded: false,
    peerMelded: false,
    peerHandCount: HAND_SIZE,
    justDrewId: null,
    winner: null,
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
    connected: false,
    dealt: false,
  };

  const myTurn = () => state.screen === 'game' && !state.winner && state.turn === state.role;
  /** Grid shown: live draft on my turn, the opponent's live draft on theirs. */
  const shownGrid = (): Grid => {
    if (myTurn()) return state.draft ?? state.board;
    return state.peerView ?? state.board;
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
    const becameMine = mine && !wasMyTurn && state.screen === 'game' && state.dealt && !state.winner;
    if (becameMine) snapshotTurnStart();
    wasMyTurn = mine;
    document.title = mine && state.screen === 'game' && !state.winner
      ? 'Your turn! — Rummikub P2P'
      : 'Rummikub — P2P';
    if (becameMine) playTurnChime();
  }

  // Live spectator sync: stream the draft while arranging (debounced).
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleDraftBroadcast() {
    if (!myTurn() || !state.draft) return;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      if (myTurn() && state.draft) {
        net?.send({ t: 'draft', board: [...state.draft], by: state.role });
      }
    }, 120);
  }
  // ---------- open-game discovery (serverless lobby) ----------
  // One lobby room for the life of the home page: leaving and instantly
  // rejoining the same room races with Trystero's async leave, so the host
  // keeps this room and only toggles its heartbeat.
  let lobby: LobbyHandle | null = null;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let announcing = false;
  let announceTimer: ReturnType<typeof setInterval> | null = null;
  let announceBursts: ReturnType<typeof setTimeout>[] = [];
  let lastLobbyPeers = -1;

  const lobbySignature = (): string => state.openGames.map((g) => `${g.code}=${g.name}`).join('|');
  const lobbyPeerCount = (): number => lobby?.peerCount() ?? 0;

  /** Re-render the home page only when something visible changed. */
  function maybeRenderLobby(before: string) {
    if (state.screen !== 'lobby') return;
    const peers = lobbyPeerCount();
    if (lobbySignature() !== before || peers !== lastLobbyPeers) {
      lastLobbyPeers = peers;
      render();
    }
  }

  function onLobby(data: unknown) {
    if (!isLobbyMessage(data)) return;
    const before = lobbySignature();
    state.openGames = upsertGame(state.openGames, data, Date.now());
    maybeRenderLobby(before);
  }

  /** Join the lobby room; prune quiet listings and refresh peer state. */
  function startLobbyWatch() {
    if (!lobby) {
      lobby = makeLobbyRoom(onLobby);
      lastLobbyPeers = -1;
    }
    if (!watchTimer) {
      watchTimer = setInterval(() => {
        const before = lobbySignature();
        state.openGames = pruneGames(state.openGames, Date.now());
        maybeRenderLobby(before);
      }, 5000);
    }
  }

  function stopLobbyWatch() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (lobby) {
      lobby.leave();
      lobby = null;
    }
    lastLobbyPeers = -1;
  }

  /** Public hosts heartbeat their game until a guest joins. */
  function startAnnounce() {
    if (state.isPrivate || announcing) return;
    if (!lobby) startLobbyWatch();
    announcing = true;
    const code = state.code;
    const beat = () => {
      if (announcing && state.code === code) lobby?.send({ t: 'hosting', code, name: state.name });
    };
    // Burst the first beats: early ones are lost while relays connect.
    beat();
    announceBursts.push(setTimeout(beat, 2000), setTimeout(beat, 5000));
    announceTimer = setInterval(beat, ANNOUNCE_MS);
  }

  function stopAnnounce() {
    if (announceTimer) {
      clearInterval(announceTimer);
      announceTimer = null;
    }
    for (const t of announceBursts) clearTimeout(t);
    announceBursts = [];
    // Only the announcer withdraws; guests must never close someone's listing.
    if (announcing && lobby && state.code) lobby.send({ t: 'closed', code: state.code });
    announcing = false;
  }

  function joinGame(code: string, name: string) {
    state.name = name.trim() || 'Guest';
    state.role = 'guest';
    state.code = code;
    state.screen = 'game';
    stopLobbyWatch();
    connect(code, 'guest');
    render();
    say('Connecting… waiting for host to deal.');
  }

  const committedTiles = (): Tile[] => (state.board.filter(Boolean) as Tile[]);
  const committedIds = (): Set<string> => new Set(committedTiles().map((t) => t.id));

  function say(msg: string, kind: UiState['messageKind'] = '') {
    state.message = msg;
    state.messageKind = kind;
    paintMessage();
  }

  // ---------- networking ----------
  function connect(code: string, role: Role) {
    net?.leave();
    net = makeRoom(code, onNet);
    net.onPeerJoin(() => {
      state.connected = true;
      if (state.role === 'host' && !state.dealt && state.screen === 'game') deal();
      else render();
    });
    net.onPeerLeave(() => {
      state.connected = false;
      if (state.screen === 'game' && !state.winner) say('Opponent disconnected. They can rejoin with the same code (host redeals).', 'error');
      render();
    });
    setTimeout(() => net?.send({ t: 'hello', from: state.role, name: state.name }), 800);
  }

  function deal() {
    stopAnnounce();
    const deck = shuffle(buildDeck());
    const hostHand = deck.slice(0, HAND_SIZE);
    const guestHand = deck.slice(HAND_SIZE, HAND_SIZE * 2);
    state.pool = deck.slice(HAND_SIZE * 2);
    state.sortMode = 'color';
    state.rack = rackFromTiles(sortTiles(state.role === 'host' ? hostHand : guestHand, 'color'));
    state.turnStartRack = null;
    wasMyTurn = false;
    state.board = emptyGrid();
    state.draft = null;
    state.peerView = null;
    state.poolCount = state.pool.length;
    state.turn = 'host';
    state.melded = false;
    state.peerMelded = false;
    state.peerHandCount = HAND_SIZE;
    state.justDrewId = null;
    state.winner = null;
    state.dealt = true;
    net?.send({
      t: 'deal',
      to: 'guest',
      hand: state.role === 'host' ? guestHand : hostHand,
      poolCount: state.pool.length,
      turn: 'host',
      board: emptyGrid(),
      names: { host: state.role === 'host' ? state.name : state.peerName },
    });
    say(state.turn === state.role ? 'Dealt! You start — meld 30+ or draw.' : 'Dealt! Opponent starts.', 'ok');
    render();
  }

  function onNet(msg: NetMessage) {
    switch (msg.t) {
      case 'hello':
        if (msg.from !== state.role) {
          state.peerName = msg.name || 'Opponent';
          state.connected = true;
          render();
        }
        break;
      case 'deal':
        if (msg.to === state.role) {
          state.sortMode = 'color';
          state.rack = rackFromTiles(sortTiles(msg.hand, 'color'));
          state.turnStartRack = null;
          wasMyTurn = false;
          state.poolCount = msg.poolCount;
          state.board = msg.board;
          state.draft = null;
          state.peerView = null;
          state.turn = msg.turn as Role;
          state.peerHandCount = HAND_SIZE;
          state.justDrewId = null;
          state.winner = null;
          say(state.turn === state.role ? 'Dealt! You start — meld 30+ or draw.' : `${state.peerName} starts.`, 'ok');
          render();
        }
        break;
      case 'draft':
        // Live view of the opponent's arranging. Stale messages (not their turn) are ignored.
        if (msg.by !== state.role && state.turn === msg.by && !state.winner) {
          state.peerView = msg.board;
          render();
        }
        break;
      case 'commit':
        state.board = msg.board;
        state.draft = null;
        state.peerView = null;
        state.poolCount = msg.poolCount;
        if (msg.by !== state.role) state.peerMelded = msg.melded;
        else state.melded = msg.melded;
        if (msg.by !== state.role) state.peerHandCount = msg.handCount;
        state.turn = msg.turn as Role;
        state.selection = null;
        if (msg.winnerId) {
          state.winner = msg.winnerId as Role;
          say(state.winner === state.role ? 'Rummikub! You win!' : `${state.peerName} wins.`, state.winner === state.role ? 'ok' : 'error');
        } else {
          say(state.turn === state.role ? 'Your turn.' : `${state.peerName}'s turn.`);
        }
        render();
        break;
      case 'drawRequest':
        if (state.role === 'host') {
          const tile = state.pool.pop();
          if (!tile) return;
          state.poolCount = state.pool.length;
          state.turn = 'host';
          net?.send({ t: 'drawGrant', to: 'guest', tile, poolCount: state.pool.length, turn: 'host' });
          broadcastDrawBoard();
          say('Your turn.');
          render();
        }
        break;
      case 'drawGrant':
        if (msg.to === state.role) {
          state.rack[firstEmptyRackSlot(state.rack)] = msg.tile;
          state.justDrewId = msg.tile.id;
          sortHand();
          state.poolCount = msg.poolCount;
          state.turn = msg.turn as Role;
          state.draft = null;
          state.peerView = null;
          say('Drew a tile. Opponent\'s turn.');
          render();
        }
        break;
      case 'drawBoard':
        if (msg.by !== state.role) {
          state.peerHandCount = msg.handCount;
          state.poolCount = msg.poolCount;
          state.turn = msg.turn as Role;
          state.peerView = null;
          say('Your turn.');
          render();
        }
        break;
    }
  }

  function broadcastDrawBoard() {
    net?.send({ t: 'drawBoard', by: state.role, handCount: rackTiles(state.rack).length, poolCount: state.poolCount, turn: state.turn });
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

  function doDraw() {
    if (!myTurn()) return;
    if (state.draft && draftDiffers()) {
      say('You moved tiles — End Turn or Revert before drawing.', 'error');
      return;
    }
    if (state.role === 'host') {
      const tile = state.pool.pop();
      if (!tile) {
        say('Pool is empty.', 'error');
        return;
      }
      state.rack[firstEmptyRackSlot(state.rack)] = tile;
      state.justDrewId = tile.id;
      sortHand();
      state.poolCount = state.pool.length;
      state.turn = 'guest';
      state.draft = null;
      broadcastDrawBoard();
      say('Drew a tile. Opponent\'s turn.');
      render();
    } else {
      say('Requesting a tile from host…');
      net?.send({ t: 'drawRequest', by: 'guest' });
    }
  }

  function doEndTurn() {
    if (!myTurn()) return;
    const grid = ensureDraft();
    const sets = deriveSets(grid).map((d) => d.tiles);
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
    const beforeSets = deriveSets(state.board).map((d) => d.tiles);
    const check = validateTurn({ beforeBoard: beforeSets, afterBoard: sets, placedIds, hasMelded: state.melded });
    if (!check.ok) {
      say(check.reason ?? 'Invalid turn.', 'error');
      return;
    }
    const placedSet = new Set(placedIds);
    // Played tiles already left the staging grid when placed; drop any stragglers.
    state.rack = state.rack.map((t) => (t && placedSet.has(t.id) ? null : t));
    if (state.justDrewId && placedSet.has(state.justDrewId)) state.justDrewId = null;
    // Commit the grid as arranged — positions are preserved for both players.
    state.board = [...grid];
    state.draft = null;
    state.melded = true;
    state.selection = null;
    const won = myTiles().length === 0;
    const next: Role = state.role === 'host' ? 'guest' : 'host';
    state.turn = won ? state.role : next;
    if (won) state.winner = state.role;
    net?.send({
      t: 'commit',
      board: [...grid],
      by: state.role,
      melded: true,
      handCount: myTiles().length,
      poolCount: state.poolCount,
      turn: state.turn,
      ...(won ? { winnerId: state.role } : {}),
    });
    say(won ? 'Rummikub! You win!' : 'Nice play! Opponent\'s turn.', 'ok');
    render();
  }

  function doRevert() {
    // Restore both grids to the turn start — no sorting, the snapshot keeps the prep.
    if (state.turnStartRack) state.rack = [...state.turnStartRack];
    state.draft = null;
    state.selection = null;
    // Spectator sees the reset too.
    if (myTurn()) net?.send({ t: 'draft', board: [...state.board], by: state.role });
    say('Board and staging area reverted.');
    render();
  }
  // ---------- selection & placement on the slot grid ----------
  function setForCell(grid: Grid, cell: number): number[] | null {
    for (const d of deriveSets(grid)) {
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
      const moved = moveRackSetToBoard(state.rack, draft, s.cells, cell);
      if (!moved) {
        say("That set doesn't fit there — it needs a free stretch in one row.", 'error');
        return;
      }
      state.rack = moved.rack;
      state.draft = moved.board;
    } else if (s.area === 'cell') {
      state.draft = moveTile(draft, s.cell, cell);
    } else {
      const moved = moveSet(draft, s.cells, cell);
      if (!moved) {
        say("That set doesn't fit there — it needs a free stretch in one row.", 'error');
        return;
      }
      state.draft = moved;
    }
    state.selection = null;
    scheduleDraftBroadcast();
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
      scheduleDraftBroadcast();
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
    scheduleDraftBroadcast();
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
    if (tile.kind === 'joker') {
      d.innerHTML = '<span>J★</span><small>JOKER</small>';
    } else {
      d.innerHTML = `<span>${tile.value}</span><small>${TILE_LABEL[tile.color]}</small>`;
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

  function renderLobby() {
    const wrap = el('div');
    const bar = el('div', 'topbar');
    bar.append(el('div', 'brand', 'Rummikub P2P'), el('div', 'pill', 'no server · WebRTC'));
    const brand = bar.firstChild as HTMLElement;
    brand.innerHTML = 'Rummikub P2P<small>peer-to-peer · no game server</small>';
    wrap.append(bar);

    const grid = el('div', 'grid2');
    const hostCard = el('div', 'card');
    hostCard.append(el('h2', '', 'Host a game'), el('p', 'muted', 'Create a room and share the code. You deal first.'));
    const nameH = document.createElement('input');
    nameH.placeholder = 'Your name';
    nameH.value = state.name;
    nameH.oninput = () => { state.name = nameH.value; };
    const hostBtn = el('button', '', 'Create room') as HTMLButtonElement;
    hostBtn.onclick = () => {
      state.name = nameH.value.trim() || 'Host';
      state.role = 'host';
      state.code = randomCode();
      state.screen = 'game';
      state.dealt = false;
      connect(state.code, 'host');
      startAnnounce();
      history.replaceState(null, '', `#room=${state.code}`);
      render();
      say(state.isPrivate ? 'Share the code — waiting for opponent…' : 'Listed as an open game — waiting for opponent…');
    };
    const privLabel = document.createElement('label');
    privLabel.className = 'check';
    const privBox = document.createElement('input');
    privBox.type = 'checkbox';
    privBox.checked = state.isPrivate;
    privBox.onchange = () => {
      state.isPrivate = privBox.checked;
    };
    privLabel.append(privBox, document.createTextNode(' Private — hide from the open games list'));
    hostCard.append(nameH, el('br'), el('br'), hostBtn, privLabel);

    const joinCard = el('div', 'card');
    joinCard.append(el('h2', '', 'Join a game'), el('p', 'muted', 'Enter the room code from your opponent.'));
    const nameJ = document.createElement('input');
    nameJ.placeholder = 'Your name';
    nameJ.oninput = () => { state.name = nameJ.value; };
    const codeIn = document.createElement('input');
    codeIn.placeholder = 'ROOM CODE';
    codeIn.maxLength = 8;
    const fromHash = location.hash.match(/room=([A-Za-z0-9]+)/);
    if (fromHash) codeIn.value = fromHash[1].toUpperCase();
    const joinBtn = el('button', '', 'Join room') as HTMLButtonElement;
    joinBtn.onclick = () => {
      const code = codeIn.value.trim().toUpperCase();
      if (!code) return;
      joinGame(code, nameJ.value);
    };
    joinCard.append(nameJ, el('br'), el('br'), codeIn, el('br'), el('br'), joinBtn);

    grid.append(hostCard, joinCard);
    wrap.append(grid);

    const openCard = el('div', 'card');
    openCard.style.marginTop = '16px';
    openCard.append(el('h2', '', 'Open games'));
    if (state.openGames.length === 0) {
      openCard.append(el('p', 'muted', 'No open games right now — host one above or enter a code.'));
    } else {
      const list = el('div', 'open-list');
      for (const g of state.openGames) {
        const row = el('div', 'open-row');
        row.append(el('div', 'open-name', `${g.name}’s game`), el('div', 'pill', g.code));
        const joinOpen = el('button', '', 'Join') as HTMLButtonElement;
        joinOpen.onclick = () => joinGame(g.code, nameJ.value);
        row.append(joinOpen);
        list.append(row);
      }
      openCard.append(list);
    }
    const peers = lobbyPeerCount();
    openCard.append(
      el('p', 'muted', peers > 0
        ? `Lobby live — ${peers} peer${peers === 1 ? '' : 's'} nearby.`
        : 'Connecting to the lobby… listings appear once connected.'),
    );
    wrap.append(openCard);
    const rules = el('div', 'card');
    rules.style.marginTop = '16px';
    rules.innerHTML = `<h2>How it works</h2>
      <p class="muted">Tiles sync directly between your two browsers over WebRTC (Trystero matchmaking — no game server stores state).
      First meld needs 30+ points from your own rack. After that you may rearrange the whole board, as long as every
      set is valid when you end your turn. The board is a grid of slots with a gap between sets: click a tile, then click
      its destination — tap twice to grab a whole set — or drag it.</p>`;
    wrap.append(rules);
    root.append(wrap);
  }
  function renderGame() {
    const wrap = el('div', 'game');
    const bar = el('div', 'topbar');
    const brand = el('div', 'brand inline');
    brand.innerHTML = `Rummikub P2P <small>room <span class="code">${state.code}</span></small>`;
    const leave = el('button', 'secondary', 'Leave') as HTMLButtonElement;
    leave.onclick = () => {
      net?.leave();
      net = null;
      stopAnnounce();
      Object.assign(state, {
        screen: 'lobby', rack: emptyRack(), turnStartRack: null, board: emptyGrid(), draft: null, peerView: null, pool: [],
        winner: null, dealt: false, connected: false, message: '', justDrewId: null,
      } as Partial<UiState>);
      wasMyTurn = false;
      startLobbyWatch();
      render();
    };
    bar.append(brand, leave);
    wrap.append(bar);

    const status = el('div', `statusbar${myTurn() && !state.winner ? ' my-turn' : ''}`);
    const turnPill = el('div', `pill ${myTurn() ? 'turn' : ''}`,
      state.winner ? `Winner: ${state.winner === state.role ? state.name || 'You' : state.peerName}`
        : myTurn() ? 'Your turn — arrange, then End Turn'
          : state.peerView ? `${state.peerName} is arranging…` : `${state.peerName}'s turn`);
    const soundBtn = el('button', 'secondary sound-toggle', state.soundOn ? 'Sound: on' : 'Sound: off') as HTMLButtonElement;
    soundBtn.title = 'Toggle the turn alert sound';
    soundBtn.onclick = toggleSound;
    // Game feedback (waiting, dealt, errors) lives in the status bar itself.
    const statusMsg = el('div', 'message status-message');
    statusMsg.setAttribute('data-msg', '1');
    status.append(
      turnPill,
      el('div', 'pill', `Pool: ${state.role === 'host' ? state.pool.length : state.poolCount}`),
      el('div', 'pill', `${state.peerName}: ${state.role === 'host' ? state.peerHandCount : '—'} tiles`),
      el('div', 'pill', state.melded ? 'Melded ✓' : 'Need 30+ meld'),
      el('div', 'pill', state.connected ? '● live' : '○ waiting…'),
      soundBtn,
      statusMsg,
    );
    wrap.append(status);

    // Screen-reader turn announcement that takes up no space.
    if (myTurn() && !state.winner) {
      const live = el('div', 'sr-only', 'Your turn — play tiles or draw a tile');
      live.setAttribute('role', 'status');
      wrap.append(live);
    }

    if (myTurn()) ensureDraft();
    const grid = shownGrid();
    const setOfCell = new Map<number, number>();
    deriveSets(grid).forEach((d, i) => d.cells.forEach((c) => setOfCell.set(c, i)));
    const invalid = findInvalidCells(grid);

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
    boardEl.style.setProperty('--cols', String(GRID_COLS));
    boardGridRef = boardEl;
    for (let cell = 0; cell < GRID_COLS * GRID_ROWS; cell++) {
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
    boardCard.append(el('p', 'muted', 'Press and drag a tile to move it (drop on another tile to swap) — same gesture with mouse, touch, or pen. Tap a tile twice to grab its whole set, then tap or drag it to a destination; a set needs a free stretch in one row. Sets move both ways between board and staging. Your opponent watches live as you arrange.'));
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
    endBtn.disabled = !myTurn();
    endBtn.onclick = doEndTurn;
    const drawBtn = el('button', 'secondary', 'Draw tile') as HTMLButtonElement;
    drawBtn.disabled = !myTurn();
    drawBtn.onclick = doDraw;
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

  startLobbyWatch();
  render();
  return { render, state };
}
