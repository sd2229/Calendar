/* =============================================================================
 * src/store.js — the ONE persistence seam.
 *
 * Nothing outside this file knows where the data lives. The rest of the app
 * talks to `window.HouseStore` and never to IndexedDB or Supabase directly.
 *
 * The store holds several collections, each with the same tiny interface:
 *
 *   HouseStore.events   HouseStore.forms   HouseStore.guests
 *     .subscribe(cb)  -> unsubscribe        // cb(rowsArray)
 *     .put(row)       -> Promise            // insert or update
 *     .remove(id)     -> Promise
 *
 *   HouseStore.mode   -> 'local' | 'remote'
 *   HouseStore.auth   -> { status, user, canWrite, signIn(), signOut(), onChange(cb) }
 *
 * auth.status is one of:
 *   'loading'     first snapshot / session not resolved yet
 *   'signed-out'  remote backend, house password not entered yet
 *   'ready'       signed in; canWrite says whether writes will be accepted
 *
 * Backend selection: if window.HOUSE_CONFIG has a real Supabase url + anon key
 * we use the remote (shared) backend; otherwise a local IndexedDB backend so
 * the app runs with no server at all.
 * ===========================================================================*/
(function () {
  'use strict';

  var CFG = window.HOUSE_CONFIG || {};
  var HAS_SUPABASE =
    typeof CFG.supabaseUrl === 'string' &&
    typeof CFG.anonKey === 'string' &&
    /^https?:\/\//.test(CFG.supabaseUrl) &&
    CFG.anonKey.length > 20 &&
    CFG.supabaseUrl.indexOf('YOUR-PROJECT') === -1;

  var COLLECTIONS = ['events', 'forms', 'guests'];
  var SEEDS = { events: 'events.json', forms: 'forms.json' }; // guests starts empty

  function emitter() {
    var subs = [];
    return {
      add: function (cb) { subs.push(cb); return function () { subs = subs.filter(function (s) { return s !== cb; }); }; },
      emit: function (payload) { subs.slice().forEach(function (cb) { try { cb(payload); } catch (e) {} }); }
    };
  }

  /* =========================================================================
   * LOCAL BACKEND — IndexedDB, one object store per collection, cross-tab sync.
   * =======================================================================*/
  function LocalBackend() {
    var DB_NAME = 'house-calendar', VERSION = 2;
    var dbp = null;
    var subs = {}; COLLECTIONS.forEach(function (n) { subs[n] = emitter(); });

    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          COLLECTIONS.forEach(function (n) {
            if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: 'id' });
          });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function tx(name, mode) { return open().then(function (db) { return db.transaction(name, mode).objectStore(name); }); }
    function readAll(name) {
      return tx(name, 'readonly').then(function (os) {
        return new Promise(function (resolve, reject) {
          var r = os.getAll(); r.onsuccess = function () { resolve(r.result || []); }; r.onerror = function () { reject(r.error); };
        });
      });
    }
    function seedIfEmpty(name) {
      return readAll(name).then(function (rows) {
        if (rows.length || !SEEDS[name]) return rows;
        return fetch(SEEDS[name]).then(function (r) { return r.ok ? r.json() : []; }).then(function (seed) {
          if (!seed.length) return [];
          return open().then(function (db) {
            return new Promise(function (resolve) {
              var t = db.transaction(name, 'readwrite'), os = t.objectStore(name);
              seed.forEach(function (e) { os.put(e); });
              t.oncomplete = function () { resolve(seed); };
              t.onerror = function () { resolve(seed); };
            });
          });
        }).catch(function () { return []; });
      });
    }

    var channel = null;
    try { channel = new BroadcastChannel('house-calendar'); } catch (e) { channel = null; }
    if (channel) channel.onmessage = function (e) { var n = e.data; if (subs[n]) readAll(n).then(function (rows) { subs[n].emit(rows); }); };
    function broadcast(name) {
      readAll(name).then(function (rows) { subs[name].emit(rows); if (channel) { try { channel.postMessage(name); } catch (e) {} } });
    }

    function collection(name) {
      return {
        subscribe: function (cb) { var off = subs[name].add(cb); seedIfEmpty(name).then(function (rows) { cb(rows); }); return off; },
        put: function (row) {
          return tx(name, 'readwrite').then(function (os) {
            return new Promise(function (resolve, reject) { var r = os.put(row); r.onsuccess = function () { broadcast(name); resolve(); }; r.onerror = function () { reject(r.error); }; });
          });
        },
        remove: function (id) {
          return tx(name, 'readwrite').then(function (os) {
            return new Promise(function (resolve, reject) { var r = os.delete(id); r.onsuccess = function () { broadcast(name); resolve(); }; r.onerror = function () { reject(r.error); }; });
          });
        }
      };
    }

    return {
      mode: 'local', collection: collection,
      auth: { status: 'ready', user: null, canWrite: true, signIn: function () { return Promise.resolve(); }, signOut: function () { return Promise.resolve(); }, onChange: function (cb) { cb(this); return function () {}; } }
    };
  }

  /* =========================================================================
   * REMOTE BACKEND — Supabase (Postgres + realtime + shared-password login).
   * Everyone shares one login; RLS lets any signed-in user read and write, and
   * nobody else do anything. The public projection is the separate token-gated
   * .ics feed, not these tables.
   * =======================================================================*/
  function RemoteBackend() {
    var client = null;
    var authSubs = emitter();
    var registry = []; // per-collection { refetch, subscribeRealtime, clear }

    var auth = {
      status: 'loading', user: null, canWrite: false,
      signIn: function (password) {
        return ready.then(function () {
          return client.auth.signInWithPassword({ email: CFG.houseEmail || 'house@calendar.local', password: password })
            .then(function (res) { if (res.error) throw res.error; });
        });
      },
      signOut: function () { return ready.then(function () { return client.auth.signOut(); }); },
      onChange: function (cb) { var off = authSubs.add(cb); cb(auth); return off; }
    };
    function setAuth(patch) { for (var k in patch) auth[k] = patch[k]; authSubs.emit(auth); }

    function loadLib() {
      if (window.supabase && window.supabase.createClient) return Promise.resolve(window.supabase);
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        s.onload = function () { resolve(window.supabase); };
        s.onerror = function () { reject(new Error('Could not load Supabase client')); };
        document.head.appendChild(s);
      });
    }

    function onSession(session) {
      if (!session) {
        setAuth({ status: 'signed-out', user: null, canWrite: false });
        registry.forEach(function (c) { c.clear(); });
        return;
      }
      setAuth({ status: 'ready', user: { email: session.user && session.user.email }, canWrite: true });
      registry.forEach(function (c) { c.refetch(); c.subscribeRealtime(); });
    }

    var ready = loadLib().then(function (lib) {
      client = lib.createClient(CFG.supabaseUrl, CFG.anonKey);
      return client.auth.getSession().then(function (res) {
        onSession(res.data ? res.data.session : null);
        client.auth.onAuthStateChange(function (_e, session) { onSession(session); });
      });
    }).catch(function (err) { setAuth({ status: 'signed-out', user: null, canWrite: false }); throw err; });

    function requireWrite() {
      if (!auth.canWrite) { var e = new Error('Enter the house password to make changes.'); e.code = 'not_allowed'; return Promise.reject(e); }
      return ready;
    }

    function collection(name) {
      var subs = emitter(), latest = [], channel = null;
      function refetch() {
        return ready.then(function () {
          return client.from(name).select('*').then(function (res) { if (res.error) throw res.error; latest = res.data || []; subs.emit(latest); });
        });
      }
      function subscribeRealtime() {
        if (channel) return;
        channel = client.channel('public:' + name).on('postgres_changes', { event: '*', schema: 'public', table: name }, function () { refetch().catch(function () {}); }).subscribe();
      }
      function clear() { latest = []; subs.emit(latest); }
      registry.push({ refetch: refetch, subscribeRealtime: subscribeRealtime, clear: clear });
      // If auth already resolved before this collection registered, catch up.
      if (auth.status === 'ready') { refetch().catch(function () {}); subscribeRealtime(); }
      return {
        subscribe: function (cb) { var off = subs.add(cb); cb(latest); return off; },
        put: function (row) { return requireWrite().then(function () { return client.from(name).upsert(row).then(function (res) { if (res.error) throw res.error; }); }); },
        remove: function (id) { return requireWrite().then(function () { return client.from(name).delete().eq('id', id).then(function (res) { if (res.error) throw res.error; }); }); }
      };
    }

    return { mode: 'remote', collection: collection, auth: auth };
  }

  var backend = HAS_SUPABASE ? RemoteBackend() : LocalBackend();
  var store = { mode: backend.mode, auth: backend.auth };
  COLLECTIONS.forEach(function (n) { store[n] = backend.collection(n); });
  window.HouseStore = store;
})();
