// Service worker de Planéo : fonctionnement hors ligne et rappels
const CACHE = 'planeo-v1.2.0';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './styles.css',
  './app.js', './db.js', './ai.js', './prompts.js', './plan.js',
  './surveys.js', './reminders.js', './ics.js', './sync.js', './util.js',
  './icon-192.png', './montserrat-400.woff2', './montserrat-500.woff2', './montserrat-600.woff2', './montserrat-700.woff2', './montserrat-800.woff2', './icon-512.png', './icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Fichiers de l'app : cache d'abord, mise à jour en arrière-plan. API externes : réseau direct.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => cached);
      return cached || network;
    }));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) { c.navigate ? c.navigate(url).catch(() => {}) : null; return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});

// Synchro périodique (Chrome Android, app installée) : vérifie les rappels échus
self.addEventListener('periodicsync', e => {
  if (e.tag === 'planeo-rappels') e.waitUntil(checkReminders());
});

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('planeo', 1);
    r.onupgradeneeded = () => { r.transaction.abort(); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function checkReminders() {
  let db;
  try { db = await idb(); } catch { return; }
  const tasks = await rq(db.transaction('tasks').objectStore('tasks').getAll());
  const firedRec = await rq(db.transaction('kv').objectStore('kv').get('fired'));
  const fired = firedRec ? firedRec.value : {};
  const now = Date.now();
  const base = self.registration.scope;
  for (const t of tasks) {
    if (t.status !== 'todo' || !t.due) continue;
    const due = new Date(t.due).getTime();
    for (const off of new Set([...(t.reminders || []), 0])) {
      const at = due - off * 60000;
      const key = `${t.id}|${t.due}|${off}`;
      if (at > now || now - at > 6 * 3600000 || fired[key]) continue;
      await self.registration.showNotification(off === 0 ? `Échéance : ${t.title}` : `Rappel : ${t.title}`, {
        body: off === 0 ? 'C’est l’heure prévue. Terminez-la ou faites le point dans Planéo.' : 'Échéance proche.',
        tag: key, icon: './icon-192.png', data: { url: `${base}#/tache/${t.id}` },
      });
      fired[key] = now;
    }
  }
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ key: 'fired', value: fired });
}
