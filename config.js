/* config.js — front-end backend selection.
 *
 * Leave these blank to run entirely locally (IndexedDB, no server needed).
 * Fill both in to use the shared Supabase backend. The anon key and URL are
 * safe to commit and to ship to the browser: row-level security is what
 * protects the data, not the secrecy of these values.
 *
 * Find them in the Supabase dashboard under Project Settings -> API.
 */
window.HOUSE_CONFIG = {
  supabaseUrl: '',   // e.g. 'https://abcd1234.supabase.co'
  anonKey: '',       // the "anon / public" key

  // Everyone shares ONE login. This is just its username — not a secret, safe to
  // commit. Create a user with this exact email (and your house password) in the
  // Supabase dashboard. The password is never stored in the repo.
  houseEmail: 'house@calendar.local'
};
