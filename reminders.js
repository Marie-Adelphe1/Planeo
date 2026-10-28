// Rappels : notifications du navigateur + push gratuit via ntfy
import { kvGet, kvSet } from './db.js';
import { fmtDue, reminderLabel } from './util.js';

const appUrl = () => location.href.split('#')[0];

// Toutes les occurrences de rappel des tâches non terminées
export function occurrences(tasks) {
  const out = [];
  for (const t of tasks) {
    if (t.status !== 'todo' || !t.due) continue;
    const due = new Date(t.due).getTime();
    const offs = new Set([...(t.reminders || []), 0]);
    for (const off of offs) {
      out.push({ key: `${t.id}|${t.due}|${off}`, at: due - off * 60000, off, task: t });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const textFor = o => ({
  title: o.off === 0 ? `Échéance : ${o.task.title}` : `Rappel : ${o.task.title}`,
  body: o.off === 0
    ? 'C’est l’heure prévue. Terminez-la ou faites le point dans Planéo.'
    : `${reminderLabel(o.off).replace(' avant', '')} avant l’échéance (${fmtDue(o.task.due)}).`,
});

export async function notificationsState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function askPermission() {
  if (!('Notification' in window)) return 'unsupported';
  const p = await Notification.requestPermission();
  if (p === 'granted') await registerPeriodic();
  return p;
}

async function show(title, body, url, tag) {
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, icon: './icon-192.png', badge: './icon-192.png', data: { url } });
    return true;
  }
  return false;
}

// Vérifie les rappels échus (appelé quand l'app est ouverte)
export async function checkDue(tasks, onInApp) {
  const fired = await kvGet('fired', {});
  const now = Date.now();
  let changed = false;
  for (const o of occurrences(tasks)) {
    if (o.at > now || now - o.at > 6 * 3600000 || fired[o.key]) continue;
    const { title, body } = textFor(o);
    const ok = await show(title, body, `${appUrl()}#/tache/${o.task.id}`, o.key);
    if (!ok && onInApp) onInApp(`${title} — ${body}`);
    fired[o.key] = now; changed = true;
  }
  // Nettoyage des entrées de plus de 30 jours
  for (const k of Object.keys(fired)) if (now - fired[k] > 30 * 86400000) { delete fired[k]; changed = true; }
  if (changed) await kvSet('fired', fired);
}

// Programme les rappels proches sur ntfy (push sur le téléphone, même app fermée)
export async function scheduleNtfy(settings, tasks) {
  if (!settings.ntfyTopic) return 0;
  const server = (settings.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '');
  const windowMs = Math.min(72, Math.max(1, Number(settings.ntfyWindowH) || 24)) * 3600000;
  const sent = await kvGet('ntfySent', {});
  const now = Date.now();
  let count = 0;
  for (const o of occurrences(tasks)) {
    if (o.at < now + 30000 || o.at > now + windowMs || sent[o.key]) continue;
    const { title, body } = textFor(o);
    try {
      const res = await fetch(server, {
        method: 'POST',
        body: JSON.stringify({
          topic: settings.ntfyTopic,
          title, message: body,
          delay: String(Math.floor(o.at / 1000)),
          tags: [o.off === 0 ? 'triangular_flag_on_post' : 'alarm_clock'],
          priority: o.off === 0 ? 4 : 3,
          click: `${appUrl()}#/tache/${o.task.id}`,
        }),
      });
      if (res.ok) { sent[o.key] = now; count++; }
    } catch { break; }
  }
  for (const k of Object.keys(sent)) if (now - sent[k] > 10 * 86400000) delete sent[k];
  await kvSet('ntfySent', sent);
  return count;
}

export async function testNtfy(settings) {
  const server = (settings.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '');
  const res = await fetch(server, {
    method: 'POST',
    body: JSON.stringify({ topic: settings.ntfyTopic, title: 'Planéo est connecté', message: 'Vos rappels arriveront ici.', tags: ['white_check_mark'] }),
  });
  if (!res.ok) throw new Error(`ntfy a répondu ${res.status}`);
}

export function randomTopic() {
  const a = new Uint8Array(9); crypto.getRandomValues(a);
  return 'planeo-' + [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

// Synchro périodique en arrière-plan (Chrome Android, app installée) : best effort
export async function registerPeriodic() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return false;
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return false;
    await reg.periodicSync.register('planeo-rappels', { minInterval: 60 * 60 * 1000 });
    return true;
  } catch { return false; }
}
