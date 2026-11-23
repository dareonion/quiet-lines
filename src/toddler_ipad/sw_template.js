const RELEASE = __RELEASE__;
const scope = self.registration.scope;
const scopePath = new URL(scope).pathname;
const prefix = `toddler:${scopePath}:`;
const cacheName = `${prefix}release-${RELEASE.id}`;

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Install the whole release or nothing. Every file must match the hash this worker was stamped
// with (and /release.json must carry this release's id): if a recording is kept or code changes
// while the iPad is downloading, the install fails, the old release keeps running, and the next
// update check brings a worker for the new release.
const COMPLETE = new URL('__release_complete__', scope);
const PARALLEL = 6;   // downloads in flight at once: hundreds of small files, one by one, took minutes

// Earlier releases' caches of this scope (at '/', also the first version's "release-*" names).
async function earlierCaches() {
  const names = (await caches.keys()).filter(name => name !== cacheName &&
    (name.startsWith(prefix) || (scopePath === '/' && name.startsWith('release-'))));
  return Promise.all(names.map(name => caches.open(name)));
}

// A file an earlier release already holds byte for byte (same SHA-256, checked here, not trusted)
// is copied instead of downloaded, so an update that changes one line downloads one file.
async function reusable(earlier, url, hash) {
  for (const old of earlier) {
    try {
      const hit = await old.match(url);
      if (hit && (await sha256(await hit.clone().arrayBuffer())) === hash) return hit;
    } catch { /* an unreadable entry is a miss: download the file instead */ }
  }
  return null;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // A rollback can bring back a worker for a release whose cache is already complete (it may
    // even be the active one). Reuse it; and never delete a cache this install didn't create.
    const existed = await caches.has(cacheName);
    const cache = await caches.open(cacheName);
    if (existed && await cache.match(COMPLETE)) return;
    try {
      const earlier = await earlierCaches();
      let next = 0, failure = null;
      const installOne = async key => {
        const url = new URL(key, scope);
        if (key !== 'release.json') {
          const kept = await reusable(earlier, url, RELEASE.hashes[key]);
          if (kept) return cache.put(url, kept);
        }
        if (failure) return;           // another download already failed: start no new ones
        const response = await fetch(url, {cache: 'reload'});
        if (!response.ok) throw new Error(`Could not install ${url}: ${response.status}`);
        const body = await response.clone().arrayBuffer();
        if (key === 'release.json') {
          const id = JSON.parse(new TextDecoder().decode(body)).id;
          if (id !== RELEASE.id) throw new Error(`release changed during install: ${id}`);
        } else if ((await sha256(body)) !== RELEASE.hashes[key]) {
          throw new Error(`changed during install: ${url}`);
        }
        await cache.put(url, response);
      };
      // A few downloads at a time. The first failure stops new ones, and the install fails.
      const lane = async () => {
        while (!failure && next < RELEASE.files.length) {
          const key = RELEASE.files[next++];
          try { await installOne(key); } catch (error) { failure ??= error; }
        }
      };
      await Promise.all(Array.from({length: PARALLEL}, lane));
      if (failure) throw failure;
      await cache.put(COMPLETE, new Response('ok'));
    } catch (error) {
      if (!existed) await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name !== cacheName &&
      (name.startsWith(prefix) || (scopePath === '/' && name.startsWith('release-'))))
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(scopePath)) return;
  const key = url.pathname.slice(scopePath.length);
  if (key === 'sw.js' || key === 'record' || key.startsWith('recorder/') || key.startsWith('api/')) return;

  event.respondWith((async () => {
    const home = request.mode === 'navigate' && (key === '' || key === 'index.html');
    const file = home ? '' : key;
    if (RELEASE.files.includes(file)) {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(new URL(file, scope));
      if (hit) return hit;
    }
    try {
      return await fetch(request);
    } catch {
      return new Response('Offline', {status: 504});
    }
  })());
});
