/* Service worker: lets the app OPEN with no signal (the metro). It caches only the app shell.
   Trip data is NOT cached here: app.js keeps the last good /api/state itself, and /api/* and /files/*
   always go to the network, so a locked or signed-out device can never be shown cached data by this worker.

   - navigation ("/"): network first, 4 s timeout, then the cached copy. Stale-while-revalidate would show a
     new deploy only on the second launch and make a working deploy look like it failed.
   - /static/*: cache first (URLs carry ?v=<hash>, so a changed file is a new URL).
   - skipWaiting + clients.claim: a new worker takes over at once; old caches are deleted on activate.
   __V__ is replaced by the server with the static-files hash, so every deploy gets a new cache name. */
var V = "__V__";
var SHELL = "tc-shell-" + V;
var PRECACHE = ["/", "/static/app.css?v=" + V, "/static/app.js?v=" + V,
  "/static/apple-touch-icon.png?v=" + V, "/static/icon-192.png", "/static/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      return Promise.all(PRECACHE.map(function (u) {
        // a missing optional file must not fail the whole install
        return fetch(u, { cache: "reload" }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k.indexOf("tc-shell-") === 0 && k !== SHELL; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function timeout(ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, ms); }); }

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var p = url.pathname;

  if (req.mode === "navigate" && p === "/") {
    e.respondWith(
      Promise.race([fetch(req), timeout(4000)]).then(function (r) {
        if (r && r.ok) {
          var copy = r.clone();
          caches.open(SHELL).then(function (c) { c.put("/", copy); });
          return r;
        }
        return caches.match("/").then(function (m) { return m || r; });
      }).catch(function () {
        return caches.match("/").then(function (m) { return m || Response.error(); });
      })
    );
    return;
  }

  if (p.indexOf("/static/") === 0) {
    e.respondWith(
      caches.match(req).then(function (m) {
        if (m) return m;
        return fetch(req).then(function (r) {
          if (r && r.ok) { var copy = r.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }); }
          return r;
        });
      })
    );
  }
  // everything else (/api/*, /files/*, manifest): untouched, straight to the network
});
