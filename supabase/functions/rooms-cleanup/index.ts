// POST /rooms-cleanup -> 200 { deleted } — invoked on a schedule
// (Supabase scheduled functions / pg_cron) to prune idle rooms.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.4';
import { handleOptions, jsonWithCors } from '../_shared/cors.ts';
import { handleRoomsCleanup } from '../_shared/server/handlers.ts';
import { makeSupabaseDb } from '../_shared/supabase-db.ts';

serve(async (req: Request) => {
  const early = handleOptions(req);
  if (early) return early;
  if (req.method !== 'POST') return jsonWithCors({ error: 'method_not_allowed' }, 405);
  const db = makeSupabaseDb(
    createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''),
  );
  const res = await handleRoomsCleanup(db);
  return jsonWithCors(res.body, res.status);
});
