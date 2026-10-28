// Utilitaires partagés
export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pad = n => String(n).padStart(2, '0');

// ISO -> valeur pour <input type="datetime-local">
export function toInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Valeur d'input (heure locale) -> ISO
export function fromInput(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

// Dates venant de l'IA : "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", ou ISO complet
export function parseLooseDate(v) {
  if (!v || typeof v !== 'string') return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T18:00';
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

// Format local lisible pour l'IA : "2026-10-26T14:30"
export const localStamp = (iso = new Date().toISOString()) => toInput(iso);

const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fullFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const dayDiff = (iso) => Math.round((startOfDay(new Date(iso)) - startOfDay()) / 86400000);

export function fmtDue(iso) {
  if (!iso) return 'Sans échéance';
  const d = new Date(iso);
  const diff = dayDiff(iso);
  const t = timeFmt.format(d);
  if (diff === 0) return `Aujourd’hui, ${t}`;
  if (diff === 1) return `Demain, ${t}`;
  if (diff === -1) return `Hier, ${t}`;
  if (diff > 1 && diff < 7) return `${dayFmt.format(d)}, ${t}`;
  return `${dayFmt.format(d)} ${d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() : ''}`.trim();
}

export const fmtLong = iso => (iso ? fullFmt.format(new Date(iso)) : '');
export const fmtDay = iso => (iso ? dayFmt.format(new Date(iso)) : '');

export function fmtDuration(min) {
  if (!min) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}

export function reminderLabel(off) {
  if (off === 0) return 'À l’échéance';
  if (off % 1440 === 0) return `${off / 1440} j avant`;
  if (off % 60 === 0) return `${off / 60} h avant`;
  return `${off} min avant`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

// Petit rendu markdown sûr pour les réponses de l'IA
export function miniMarkdown(text = '') {
  const lines = esc(text).split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const hd = line.match(/^#{1,4}\s+(.*)$/);
    if (hd) html += `<p><strong>${hd[1]}</strong></p>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}
