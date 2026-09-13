import { joinRoom } from 'trystero';
import type { JsonValue } from '@trystero-p2p/core';
import type { Tile } from '../game/types';
import type { Grid } from '../game/board';
import { LOBBY_CODE, type LobbyMessage } from './lobby';

export const APP_ID = 'rumikub-p2p-v1';

export type NetMessage =
  | { t: 'hello'; from: string; name: string }
  | { t: 'deal'; to: string; hand: Tile[]; poolCount: number; turn: string; board: Grid; names: Record<string, string> }
  | { t: 'commit'; board: Grid; by: string; melded: boolean; handCount: number; poolCount: number; turn: string; winnerId?: string }
  | { t: 'drawRequest'; by: string }
  | { t: 'drawGrant'; to: string; tile: Tile; poolCount: number; turn: string }
  | { t: 'drawBoard'; by: string; handCount: number; poolCount: number; turn: string }
  | { t: 'draft'; board: Grid; by: string };

export interface NetHandle {
  send: (msg: NetMessage) => void;
  leave: () => void;
  onPeerJoin: (cb: (id: string) => void) => void;
  onPeerLeave: (cb: (id: string) => void) => void;
}

export function makeRoom(code: string, onMessage: (msg: NetMessage, peerId: string) => void): NetHandle {
  const room = joinRoom({ appId: APP_ID }, code);
  const action = room.makeAction('game');
  action.onMessage = (data, context) => {
    onMessage(data as unknown as NetMessage, context.peerId);
  };
  return {
    send: (msg) => void action.send(msg as unknown as JsonValue),
    leave: () => void room.leave(),
    onPeerJoin: (cb) => { room.onPeerJoin = cb; },
    onPeerLeave: (cb) => { room.onPeerLeave = cb; },
  };
}

export interface LobbyHandle {
  send: (msg: LobbyMessage) => void;
  leave: () => void;
  /** WebRTC peers currently connected in the lobby room. */
  peerCount: () => number;
}

/** Join the well-known lobby room used for open-game announcements. */
export function makeLobbyRoom(onMessage: (msg: LobbyMessage) => void): LobbyHandle {
  const room = joinRoom({ appId: APP_ID }, LOBBY_CODE);
  const action = room.makeAction('lobby');
  action.onMessage = (data) => {
    onMessage(data as unknown as LobbyMessage);
  };
  return {
    send: (msg) => void action.send(msg as unknown as JsonValue),
    leave: () => void room.leave(),
    peerCount: () => Object.keys(room.getPeers()).length,
  };
}

export function randomCode(length = 5): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
  return out;
}
