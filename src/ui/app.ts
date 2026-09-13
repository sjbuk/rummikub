import { buildDeck, shuffle, validateTurn, HAND_SIZE } from '../game/rules';
import {
  GRID_COLS,
  GRID_ROWS,
  deriveSets,
  emptyGrid,
  findInvalidCells,
  moveSet,
  moveTile,
  sortTiles,
  type Grid,
  type SortMode,
} from '../game/board';
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
  hand: Tile[];
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
    hand: [],
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

  /** Fire the turn alert once per false→true edge while a game is live. */
  function noteTurn() {
    const mine = myTurn();
    const becameMine = mine && !wasMyTurn && state.screen === 'game' && state.dealt && !state.winner;
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
    state.hand = state.role === 'host' ? hostHand : guestHand;
    state.sortMode = 'color';
    sortHand();
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
          state.hand = msg.hand;
          state.sortMode = 'color';
          sortHand();
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
          state.hand.push(msg.tile);
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
    net?.send({ t: 'drawBoard', by: state.role, handCount: state.hand.length, poolCount: state.poolCount, turn: state.turn });
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

  /** Sorts the rack in the current mode; the button label always names this same mode. */
  function sortHand() {
    // Manual keeps the player's arrangement; drawn tiles were pushed to the right end.
    state.hand = sortTiles(state.hand, state.sortMode);
  }

  const SORT_LABEL: Record<SortMode, string> = {
    color: 'Sort: colour',
    number: 'Sort: number',
    manual: 'Sort: manual',
  };

  function cycleSortMode() {
    state.sortMode = state.sortMode === 'color' ? 'number' : state.sortMode === 'number' ? 'manual' : 'color';
    sortHand();
    if (state.sortMode === 'manual') say('Manual rack order — drag tiles to rearrange; new tiles join the right end.');
    render();
  }

  /** Move a rack tile from one slot to another, keeping the player's manual order. */
  function moveRack(from: number, to: number) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from < 0 || from >= state.hand.length || to < 0 || to > state.hand.length) return;
    if (from === to) return;
    const [t] = state.hand.splice(from, 1);
    state.hand.splice(to, 0, t);
    state.selection = null;
    // A hand-arranged rack is manual from here on — auto-sort would undo it.
    if (state.sortMode !== 'manual') {
      state.sortMode = 'manual';
      say('Manual rack order — your arrangement is kept; new tiles join the right end.');
    }
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
      state.hand.push(tile);
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
    state.hand = state.hand.filter((t) => !placedSet.has(t.id));
    if (state.justDrewId && !state.hand.some((t) => t.id === state.justDrewId)) state.justDrewId = null;
    // Commit the grid as arranged — positions are preserved for both players.
    state.board = [...grid];
    state.draft = null;
    state.melded = true;
    state.selection = null;
    const won = state.hand.length === 0;
    const next: Role = state.role === 'host' ? 'guest' : 'host';
    state.turn = won ? state.role : next;
    if (won) state.winner = state.role;
    net?.send({
      t: 'commit',
      board: [...grid],
      by: state.role,
      melded: true,
      handCount: state.hand.length,
      poolCount: state.poolCount,
      turn: state.turn,
      ...(won ? { winnerId: state.role } : {}),
    });
    say(won ? 'Rummikub! You win!' : 'Nice play! Opponent\'s turn.', 'ok');
    render();
  }

  function doRevert() {
    const beforeIds = committedIds();
    for (const t of state.draft ?? []) {
      if (t && !beforeIds.has(t.id)) state.hand.push(t);
    }
    sortHand();
    state.draft = null;
    state.selection = null;
    // Spectator sees the reset too.
    if (myTurn()) net?.send({ t: 'draft', board: [...state.board], by: state.role });
    say('Board reverted.');
    render();
  }
  // ---------- selection & placement on the slot grid ----------
  function setForCell(grid: Grid, cell: number): number[] | null {
    for (const d of deriveSets(grid)) {
      if (d.cells.includes(cell)) return d.cells;
    }
    return null;
  }

  /** Click (or drop) on a grid cell with the current selection. */
  function handleCellTarget(cell: number) {
    const s = state.selection;
    if (!s || !myTurn()) return;
    const draft = ensureDraft();
    if (s.area === 'rack') {
      const [t] = state.hand.splice(s.index, 1);
      if (!t) return;
      const occ = draft[cell];
      draft[cell] = t;
      if (occ) state.hand.splice(s.index, 0, occ); // swap with occupant
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

  // Tap timing for set grabs. A re-render on every tap breaks the browser's
  // native dblclick, so a quick second tap on the same tile grabs its set.
  let lastTap = { cell: -1, time: 0 };
  const DOUBLE_TAP_MS = 450;

  function clickCell(cell: number) {
    if (!myTurn()) return;
    const now = Date.now();
    const quickSecondTap = lastTap.cell === cell && now - lastTap.time < DOUBLE_TAP_MS;
    lastTap = { cell, time: now };
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

  function clickRackTile(i: number) {
    const s = state.selection;
    if (s?.area === 'rack' && s.index === i) {
      state.selection = null;
      render();
      return;
    }
    if (s?.area === 'cell' && myTurn()) {
      // Return a rack-origin tile from the board to the rack.
      const beforeIds = committedIds();
      const tile = ensureDraft()[s.cell];
      if (!tile || beforeIds.has(tile.id)) {
        say('Committed board tiles must stay on the board — rearrange them into valid sets.', 'error');
        return;
      }
      ensureDraft()[s.cell] = null;
      state.hand.splice(i, 0, tile);
      state.selection = null;
      scheduleDraftBroadcast();
      render();
      return;
    }
    if (s?.area === 'rack') {
      // Tap two rack tiles to reorder — the rack becomes manual so the order sticks.
      moveRack(s.index, i);
      render();
      return;
    }
    if (s?.area === 'set') {
      say("Sets live on the board — click a board cell to place it, or pick a single tile.", 'error');
      return;
    }
    state.selection = { area: 'rack', index: i };
    render();
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
      m.className = `message ${state.messageKind}`;
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
    const wrap = el('div');
    const bar = el('div', 'topbar');
    const brand = el('div', 'brand');
    brand.innerHTML = `Rummikub P2P<small>room <span class="code">${state.code}</span></small>`;
    const leave = el('button', 'secondary', 'Leave') as HTMLButtonElement;
    leave.onclick = () => {
      net?.leave();
      net = null;
      stopAnnounce();
      Object.assign(state, {
        screen: 'lobby', hand: [], board: emptyGrid(), draft: null, peerView: null, pool: [],
        winner: null, dealt: false, connected: false, message: '', justDrewId: null,
      } as Partial<UiState>);
      wasMyTurn = false;
      startLobbyWatch();
      render();
    };
    bar.append(brand, leave);
    wrap.append(bar);

    const status = el('div', 'statusbar');
    const turnPill = el('div', `pill ${myTurn() ? 'turn' : ''}`,
      state.winner ? `Winner: ${state.winner === state.role ? state.name || 'You' : state.peerName}`
        : myTurn() ? 'Your turn — arrange, then End Turn'
          : state.peerView ? `${state.peerName} is arranging…` : `${state.peerName}'s turn`);
    const soundBtn = el('button', 'secondary sound-toggle', state.soundOn ? 'Sound: on' : 'Sound: off') as HTMLButtonElement;
    soundBtn.title = 'Toggle the turn alert sound';
    soundBtn.onclick = toggleSound;
    status.append(
      turnPill,
      el('div', 'pill', `Pool: ${state.role === 'host' ? state.pool.length : state.poolCount}`),
      el('div', 'pill', `${state.peerName}: ${state.role === 'host' ? state.peerHandCount : '—'} tiles`),
      el('div', 'pill', state.melded ? 'Melded ✓' : 'Need 30+ meld'),
      el('div', 'pill', state.connected ? '● live' : '○ waiting…'),
      soundBtn,
    );
    wrap.append(status);

    if (myTurn() && !state.winner) {
      const banner = el('div', 'turn-banner', 'Your turn — play tiles or draw a tile');
      banner.setAttribute('role', 'status');
      wrap.append(banner);
    }

    if (myTurn()) ensureDraft();
    const grid = shownGrid();
    const setOfCell = new Map<number, number>();
    deriveSets(grid).forEach((d, i) => d.cells.forEach((c) => setOfCell.set(c, i)));
    const invalid = findInvalidCells(grid);

    const boardCard = el('div', 'card');
    boardCard.append(el('h2', '', 'Board'));
    const boardEl = el('div', 'grid-board');
    boardEl.style.setProperty('--cols', String(GRID_COLS));
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
        tEl.setAttribute('draggable', myTurn() ? 'true' : 'false');
        tEl.onclick = () => clickCell(cell);
        tEl.ondragstart = (e) => {
          if (!myTurn()) { e.preventDefault(); return; }
          const sel = state.selection;
          // Dragging a tile of a grabbed set moves the whole set; otherwise just the tile.
          if (sel?.area === 'set' && sel.cells.includes(cell)) {
            e.dataTransfer?.setData('text/setmove', String(cell));
          } else {
            e.dataTransfer?.setData('text/cell', String(cell));
          }
        };
        cellEl.append(tEl);
      } else {
        cellEl.onclick = () => clickCell(cell);
      }
      cellEl.ondragover = (e) => { e.preventDefault(); cellEl.classList.add('drop-target'); };
      cellEl.ondragleave = () => cellEl.classList.remove('drop-target');
      cellEl.ondrop = (e) => {
        e.preventDefault();
        cellEl.classList.remove('drop-target');
        const mv = e.dataTransfer?.getData('text/setmove');
        const c = e.dataTransfer?.getData('text/cell');
        const r = e.dataTransfer?.getData('text/rack');
        if (mv !== undefined && mv !== '') {
          const cells = setForCell(ensureDraft(), Number(mv));
          if (!cells) return;
          if (cells.length <= 1) {
            state.selection = { area: 'cell', cell: Number(mv) };
          } else {
            state.selection = { area: 'set', cells };
          }
        } else if (c !== undefined && c !== '') state.selection = { area: 'cell', cell: Number(c) };
        else if (r !== undefined && r !== '') state.selection = { area: 'rack', index: Number(r) };
        else return;
        handleCellTarget(cell);
      };
      boardEl.append(cellEl);
    }
    boardCard.append(boardEl);
    boardCard.append(el('p', 'muted', 'Drag a tile to move it (drop on another tile to swap). Tap a tile twice to grab its whole set, then click or drag it to a destination cell — a set needs a free stretch in one row. Your opponent watches live as you arrange.'));
    wrap.append(boardCard);

    const rack = el('div', `rack${myTurn() ? ' my-turn' : ''}`);
    const rackTiles = el('div', 'tiles');
    state.hand.forEach((t, i) => {
      const sel = state.selection?.area === 'rack' && state.selection.index === i;
      const isNew = state.justDrewId !== null && t.id === state.justDrewId;
      const tEl = tileEl(t, `${sel ? 'selected' : ''} ${isNew ? 'just-drew' : ''}`.trim());
      if (isNew) tEl.title = 'Just drawn';
      tEl.setAttribute('draggable', 'true');
      tEl.onclick = () => clickRackTile(i);
      tEl.ondragstart = (e) => {
        e.dataTransfer?.setData('text/rack', String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      };
      // Drop a dragged rack tile onto another to reorder the rack.
      tEl.ondragover = (e) => {
        if (!e.dataTransfer?.types.includes('text/rack')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tEl.classList.add('drop-before');
      };
      tEl.ondragleave = () => tEl.classList.remove('drop-before');
      tEl.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        tEl.classList.remove('drop-before');
        const raw = e.dataTransfer?.getData('text/rack');
        if (raw === undefined || raw === '') return;
        moveRack(Number(raw), i);
        render();
      };
      rackTiles.append(tEl);
    });
    rackTiles.onclick = (e) => {
      if ((e.target as HTMLElement).closest('.tile')) return;
      if (state.selection?.area === 'cell') {
        // Clicked empty rack space with a board tile selected → try return to rack.
        const beforeIds = committedIds();
        const s = state.selection;
        const tile = s.area === 'cell' ? ensureDraft()[s.cell] : null;
        if (tile && !beforeIds.has(tile.id) && myTurn()) {
          ensureDraft()[s.cell] = null;
          state.hand.push(tile);
          state.selection = null;
          scheduleDraftBroadcast();
          render();
        }
      }
    };
    rackTiles.ondragover = (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('text/rack')) e.dataTransfer.dropEffect = 'move';
    };
    rackTiles.ondrop = (e) => {
      // Tile-level drops stop propagation; reaching here means empty rack space → move to the end.
      if ((e.target as HTMLElement).closest('.tile')) return;
      const raw = e.dataTransfer?.getData('text/rack');
      if (raw === undefined || raw === '') return;
      e.preventDefault();
      moveRack(Number(raw), state.hand.length);
      render();
    };
    rack.append(el('h3', '', `${state.name || 'You'} — your rack (${state.hand.length})`));
    rack.append(el('p', 'muted rack-hint',
      state.sortMode === 'manual'
        ? 'Manual order — drag tiles to rearrange; new tiles join the right end.'
        : 'Tip: drag a rack tile onto another to arrange it yourself (switches to manual).'));
    rack.append(rackTiles);

    const toolbar = el('div', 'toolbar');
    const endBtn = el('button', '', 'End Turn') as HTMLButtonElement;
    endBtn.disabled = !myTurn();
    endBtn.onclick = doEndTurn;
    const drawBtn = el('button', 'secondary', 'Draw tile') as HTMLButtonElement;
    drawBtn.disabled = !myTurn();
    drawBtn.onclick = doDraw;
    const sortBtn = el('button', 'secondary', SORT_LABEL[state.sortMode]) as HTMLButtonElement;
    sortBtn.title = 'Rack order — click to cycle colour, number, manual';
    sortBtn.onclick = cycleSortMode;
    const revertBtn = el('button', 'secondary', 'Revert board') as HTMLButtonElement;
    revertBtn.disabled = !myTurn() || !draftDiffers();
    revertBtn.onclick = doRevert;
    toolbar.append(endBtn, drawBtn, sortBtn, revertBtn);
    rack.append(toolbar);
    rack.append(Object.assign(el('div', 'message'), { textContent: '' }));
    wrap.append(rack);
    root.append(wrap);
    paintMessage();
    const msgSlot = wrap.querySelector('.rack .message');
    if (msgSlot) {
      msgSlot.textContent = state.message;
      msgSlot.className = `message ${state.messageKind}`;
      msgSlot.setAttribute('data-msg', '1');
    }
  }

  startLobbyWatch();
  render();
  return { render, state };
}
