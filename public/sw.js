// The guard app's service worker.
//
// WHY IT EXISTS. The outbox in lib/gate/client/outbox.ts is built so that a row
// recorded at the gate is never lost — nothing leaves the queue until the server
// confirms it. All of that care was undone by a simpler problem: with no service
// worker the app is an ordinary website, so a guard with no signal could not
// LOAD it at all. A blank screen at the gate records nothing, and the queue that
// would have protected the row never gets the chance to exist.
//
// SCOPE IS "/" AND THE CONFINEMENT IS IN CODE, not in the file's location.
// It was served from /scan/ first, which reads better and does not work: a
// worker scoped to "/scan/" does NOT control "/scan" — the guard app's actual
// URL, and the one every pairing link points at. Registration succeeded, the
// worker activated, and it controlled nothing. Caught only by checking
// navigator.serviceWorker.controller after a reload.
//
// So the scope is root and handled(), below, is what keeps the dashboard out.
// That boundary is load bearing: a manager served a stale cached page would be
// reading figures that look current and are not — the same "everything is
// accounted for" failure the portal was just fixed for. Dashboard DOCUMENTS are
// never cached here. Hashed build chunks and the face models are, because they
// are immutable and the guard app cannot start without them.
//
// CACHE-VERSION: bump on any change to this file. The activate handler deletes
// every cache that is not the current one, which is how a guard's phone stops
// serving a shell from three deploys ago.
const VERSION = "gate-v2";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

// The document itself. Cached on install so the very first offline open works
// even if the guard has never navigated while connected since the deploy.
const SHELL_URLS = ["/scan"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_URLS))
      // A failed precache must not block activation — the runtime handler below
      // will fill the cache on the first successful online visit instead.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // NEVER intercept anything that changes state or reads live data. A cached
  // /api/gate/sync response would be catastrophic: the phone would believe rows
  // landed that never did, and the outbox would delete them on a stale verdict.
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // The confinement. A navigation is ours only inside the guard app; assets are
  // ours when they are immutable (content-hashed build output) or static (the
  // face models, the icons). Everything else — every dashboard page — falls
  // through to the network untouched.
  const p = url.pathname;
  const isGate = p === "/scan" || p.startsWith("/scan/");
  const isImmutable = p.startsWith("/_next/static/") || p.startsWith("/models/");
  if (req.mode === "navigate" ? !isGate : !(isGate || isImmutable)) return;

  // Navigations: network first so a connected guard always gets the current
  // build, cache only as the fallback when the network genuinely fails.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/scan", copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match("/scan", { ignoreSearch: true })
          .then((hit) => hit ?? Response.error()))
    );
    return;
  }

  // Everything else same-origin — hashed build chunks, the 6.7MB of face-check
  // models under /models, the icons. Cache-first: these URLs are content-hashed
  // or static, so a hit is always correct and the face check keeps working with
  // no signal once the models have been fetched once.
  e.respondWith(
    caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
      // Opaque and error responses are not worth storing; a 404 cached here
      // would outlive the deploy that caused it.
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => undefined);
      }
      return res;
    }))
  );
});

// Lets the page trigger an immediate update after a deploy rather than waiting
// for every tab to close (see app/(gate)/sw-register.tsx).
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});
