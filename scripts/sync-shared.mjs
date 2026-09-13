// Copies the tested server core into the Edge Functions bundle so the
// deployed code is byte-identical to what Vitest covers.
//
// Layout is preserved repo-relative: server/*.ts -> _shared/server/*.ts and
// src/game/{rules,types}.ts -> _shared/src/game/*.ts, so the core's relative
// imports (e.g. '../src/game/rules.ts') resolve unchanged inside the bundle.
//
// Handwritten Deno-only files in _shared/ (cors.ts, supabase-db.ts) are left
// untouched. Test files are never copied.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shared = join(root, 'supabase', 'functions', '_shared');

const serverDest = join(shared, 'server');
const gameDest = join(shared, 'src', 'game');
rmSync(serverDest, { recursive: true, force: true });
rmSync(join(shared, 'src'), { recursive: true, force: true });
mkdirSync(serverDest, { recursive: true });
mkdirSync(gameDest, { recursive: true });

for (const f of ['types.ts', 'presets.ts', 'rooms.ts', 'game.ts', 'handlers.ts', 'fake-db.ts', 'index.ts']) {
  cpSync(join(root, 'server', f), join(serverDest, f));
}
for (const f of ['rules.ts', 'types.ts']) {
  cpSync(join(root, 'src', 'game', f), join(gameDest, f));
}

console.log('synced server core -> supabase/functions/_shared/{server,src}');
