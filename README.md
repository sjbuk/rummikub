# Rummikub — P2P

A two-player Rummikub game that runs entirely in the browser. There is no
game server: players connect directly over WebRTC (via
[Trystero](https://github.com/dmotz/trystero)), so the site is a static page.

**Play it now:** https://sjbuk.github.io/rummikub/

## How to play

- **Host a game** — enter your name and host. Your game appears in the
  public lobby, or tick private to keep it hidden and share the 5-letter
  room code directly.
- **Join a game** — pick an open game from the lobby, or enter a room code
  to join a private table.
- Standard Rummikub rules: meld 30+ points to open, then rearrange the
  board freely as long as every set is valid at the end of your turn.
  First to empty their rack wins.

Both players just open the URL — no accounts, no installs. Works best in
a modern desktop or mobile browser (WebRTC requires HTTPS, which the
hosted page provides).

## Develop

Requirements: Node.js 20+ and npm.

```sh
npm install
npm run dev      # local dev server (http://localhost:1420)
npm test         # Vitest suite
npm run build    # typecheck + production build into dist/
npm run preview  # serve the production build locally
```

The desktop wrapper lives in `src-tauri/` ([Tauri](https://tauri.app)):

```sh
npm run tauri dev
npm run tauri build
```

## Project layout

- `src/game/` — rules, board model, tile types (+ tests)
- `src/net/` — P2P room handling and the serverless lobby (+ tests)
- `src/ui/` — game UI
- `src-tauri/` — Tauri desktop shell
- `docs/game-server.md` — planned Supabase game server (design + contract, not yet implemented)
- `.github/workflows/deploy.yml` — builds and deploys to GitHub Pages

## Hosting

Pushes to `master` are automatically built and deployed to GitHub Pages
via the `Deploy to GitHub Pages` workflow. No backend is needed — the
multiplayer signaling uses Trystero's default public trackers.

## Game server (implemented, client still P2P)

A Supabase-backed authoritative server (2–4 players, preset board sizes,
persisted rooms + live game state, no auth) is implemented in `server/` +
`supabase/` with full unit tests. The web client is unchanged (still P2P).
See [docs/game-server.md](docs/game-server.md) for the design and contract,
and [server/README.md](server/README.md) for setup and deployment.
