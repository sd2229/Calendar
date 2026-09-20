#!/usr/bin/env node
/* =============================================================================
 * supabase/seed.mjs — load events.json into Supabase.
 *
 * Optional: most people just paste supabase/seed.sql into the Supabase SQL
 * editor instead (no Node needed). This script does the same thing from Node.
 * No dependencies: uses Node's built-in fetch (Node 18+) against PostgREST with
 * the secret (service-role) key, which bypasses row-level security.
 *
 * Env (from the shell or a .env file next to this repo's root):
 *   SUPABASE_URL                 https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    the secret / service_role key (server-side only)
 *
 * Usage:
 *   node supabase/seed.mjs                # upsert everything from events.json
 *   node supabase/seed.mjs --reset        # delete all rows first, then load
 * ===========================================================================*/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadDotEnv() {
  try {
    const txt = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].replace(/^['"]|['"]$/g, '');
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch { /* no .env file — rely on the real environment */ }
}

await loadDotEnv();

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. See .env.example.');
  process.exit(1);
}

const reset = process.argv.includes('--reset');

function rest(path, init = {}) {
  return fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function main() {
  const events = JSON.parse(await readFile(join(ROOT, 'events.json'), 'utf8'));
  console.log(`Loaded ${events.length} events from events.json`);

  if (reset) {
    const del = await rest('events?id=neq.___never___', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) throw new Error(`reset failed: ${del.status} ${await del.text()}`);
    console.log('Cleared existing events');
  }

  // Upsert in chunks so a single large request never trips a body limit.
  const CHUNK = 200;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const res = await rest('events', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(slice)
    });
    if (!res.ok) throw new Error(`upsert failed at ${i}: ${res.status} ${await res.text()}`);
    console.log(`Upserted ${Math.min(i + CHUNK, events.length)}/${events.length}`);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
