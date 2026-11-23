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

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // A rollback can bring back a worker for a release whose cache is already complete (it may
    // even be the active one). Reuse it; and never delete a cache this install didn't create.
    const existed = await caches.has(cacheName);
    const cache = await caches.open(cacheName);
    if (existed && await cache.match(COMPLETE)) return;
    try {
      for (const key of RELEASE.files) {
        const url = new URL(key, scope);
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
      }
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
