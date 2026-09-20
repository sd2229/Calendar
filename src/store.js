/* =============================================================================
 * src/store.js — the ONE persistence seam.
 *
 * Nothing outside this file knows where the data lives. The rest of the app
 * talks to `window.HouseStore` and never to IndexedDB or Supabase directly.
 *
 * Public interface (identical for both backends):
 *
 *   HouseStore.mode                 -> 'local' | 'remote'
 *   HouseStore.subscribe(cb)        -> unsubscribe        // cb(eventsArray)
 *   HouseStore.put(event)           -> Promise
 *   HouseStore.remove(id)           -> Promise
 *   HouseStore.auth                 -> { status, user, canWrite,
 *                                        signIn(), signOut(), onChange(cb) }
 *
 * auth.status is one of:
 *   'loading'     first snapshot / session not resolved yet
 *   'signed-out'  remote backend, nobody signed in (calendar is members-only)
 *   'not-allowed' signed in with a Google account that is not on the allowlist
 *   'ready'       good to read; canWrite says whether writes will be accepted
 *
 * Backend selection: if window.HOUSE_CONFIG has a real Supabase url + anon key
 * we use the remote (shared) backend; otherwise we fall back to a local
 * IndexedDB backend so the app runs with no server at all.
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

  /* ---- a tiny event emitter used by both backends -------------------------*/
  function emitter() {
    var subs = [];
    return {
      add: function (cb) {
        subs.push(cb);
        return function () { subs = subs.filter(function (s) { return s !== cb; }); };
      },
      emit: function (payload) {
        subs.slice().forEach(function (cb) { try { cb(payload); } catch (e) { /* one bad subscriber shouldn't break the rest */ } });
      }
    };
  }

  /* =========================================================================
   * LOCAL BACKEND — IndexedDB, cross-tab sync via BroadcastChannel.
   * Seeds itself from events.json on first run if the browser can fetch it.
   * =======================================================================*/
  function LocalStore() {
    var DB_NAME = 'house-calendar', STORE = 'events', VERSION = 1;
    var dataSubs = emitter();
    var dbp = null;

    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }

    function tx(mode) {
      return open().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
    }

    function readAll() {
      return tx('readonly').then(function (os) {
        return new Promise(function (resolve, reject) {
          var req = os.getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }

    function seedIfEmpty() {
      return readAll().then(function (rows) {
        if (rows.length) return rows;
        // Nothing stored yet — try to load the seed. This works over http(s);
        // opening the file straight from disk may block the fetch, in which
        // case we simply start empty (the loading state resolves to empty).
        return fetch('events.json')
          .then(function (r) { return r.ok ? r.json() : []; })
          .then(function (seed) {
            if (!seed.length) return [];
            return open().then(function (db) {
              return new Promise(function (resolve) {
                var t = db.transaction(STORE, 'readwrite'), os = t.objectStore(STORE);
                seed.forEach(function (e) { os.put(e); });
                t.oncomplete = function () { resolve(seed); };
                t.onerror = function () { resolve(seed); };
              });
            });
          })
          .catch(function () { return []; });
      });
    }

    var channel = null;
    try { channel = new BroadcastChannel('house-calendar'); } catch (e) { channel = null; }

    function broadcast() {
      readAll().then(function (rows) {
        dataSubs.emit(rows);
        if (channel) { try { channel.postMessage('changed'); } catch (e) {} }
      });
    }
    if (channel) channel.onmessage = function () { readAll().then(function (rows) { dataSubs.emit(rows); }); };

    return {
      mode: 'local',
      subscribe: function (cb) {
        var off = dataSubs.add(cb);
        seedIfEmpty().then(function (rows) { cb(rows); });
        return off;
      },
      put: function (event) {
        return tx('readwrite').then(function (os) {
          return new Promise(function (resolve, reject) {
            var req = os.put(event);
            req.onsuccess = function () { broadcast(); resolve(); };
            req.onerror = function () { reject(req.error); };
          });
        });
      },
      remove: function (id) {
        return tx('readwrite').then(function (os) {
          return new Promise(function (resolve, reject) {
            var req = os.delete(id);
            req.onsuccess = function () { broadcast(); resolve(); };
            req.onerror = function () { reject(req.error); };
          });
        });
      },
      auth: {
        status: 'ready',
        user: null,
        canWrite: true,
        signIn: function () { return Promise.resolve(); },
        signOut: function () { return Promise.resolve(); },
        onChange: function (cb) { cb(this); return function () {}; }
      }
    };
  }

  /* =========================================================================
   * REMOTE BACKEND — Supabase (Postgres + realtime + Google OAuth).
   * The calendar is members-only: RLS lets allow-listed, signed-in users read
   * and write, and nobody else do anything. The public projection is the
   * separate token-gated .ics feed, not this table.
   * =======================================================================*/
  function RemoteStore() {
    var TABLE = 'events';
    var dataSubs = emitter();
    var authSubs = emitter();
    var client = null;
    var latest = [];

    var auth = {
      status: 'loading',
      user: null,
      canWrite: false,
      signIn: function (password) {
        return ready.then(function () {
          return client.auth.signInWithPassword({
            email: CFG.houseEmail || 'house@calendar.local',
            password: password
          }).then(function (res) { if (res.error) throw res.error; });
        });
      },
      signOut: function () {
        return ready.then(function () { return client.auth.signOut(); });
      },
      onChange: function (cb) {
        var off = authSubs.add(cb);
        cb(auth); // fire immediately with the current state
        return off;
      }
    };

    function setAuth(patch) {
      for (var k in patch) auth[k] = patch[k];
      authSubs.emit(auth);
    }

    // Load the Supabase UMD build from a CDN (keeps the app build-step-free).
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

    function refetch() {
      return client.from(TABLE).select('*').then(function (res) {
        if (res.error) throw res.error;
        latest = res.data || [];
        dataSubs.emit(latest);
        return latest;
      });
    }

    // Any authenticated session means the house password was entered correctly;
    // row-level security only lets authenticated users read or write.
    function onSession(session) {
      if (!session) {
        latest = [];
        setAuth({ status: 'signed-out', user: null, canWrite: false });
        dataSubs.emit(latest);
        return;
      }
      setAuth({ status: 'ready', user: { email: session.user && session.user.email }, canWrite: true });
      refetch().catch(function () {});
      subscribeRealtime();
    }

    var realtimeChannel = null;
    function subscribeRealtime() {
      if (realtimeChannel) return;
      realtimeChannel = client
        .channel('public:events')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, function () { refetch().catch(function () {}); })
        .subscribe();
    }

    var ready = loadLib().then(function (lib) {
      client = lib.createClient(CFG.supabaseUrl, CFG.anonKey);
      return client.auth.getSession().then(function (res) {
        onSession(res.data ? res.data.session : null);
        client.auth.onAuthStateChange(function (_evt, session) { onSession(session); });
      });
    }).catch(function (err) {
      setAuth({ status: 'signed-out', user: null, canWrite: false });
      throw err;
    });

    function requireWrite() {
      if (!auth.canWrite) {
        var e = new Error('Enter the house password to make changes.');
        e.code = 'not_allowed';
        return Promise.reject(e);
      }
      return ready;
    }

    return {
      mode: 'remote',
      subscribe: function (cb) {
        var off = dataSubs.add(cb);
        // Give the new subscriber whatever we already have; the auth flow will
        // push the first real snapshot once the session resolves.
        cb(latest);
        return off;
      },
      put: function (event) {
        return requireWrite().then(function () {
          return client.from(TABLE).upsert(event).then(function (res) {
            if (res.error) throw res.error;
          });
        });
      },
      remove: function (id) {
        return requireWrite().then(function () {
          return client.from(TABLE).delete().eq('id', id).then(function (res) {
            if (res.error) throw res.error;
          });
        });
      },
      auth: auth
    };
  }

  window.HouseStore = HAS_SUPABASE ? RemoteStore() : LocalStore();
})();
