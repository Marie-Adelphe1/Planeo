// Sauvegarde et synchronisation entre appareils via un Gist secret GitHub (gratuit)
import { STORES, all, putMany, rawDelete, kvGet, kvSet, exportAll } from './db.js';
import { buildICS } from './ics.js';

const API = 'https://api.github.com';
const DATA_FILE = 'planeo-data.json';
const ICS_FILE = 'planeo.ics';

async function gh(path, token, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch { throw new Error('GitHub injoignable. Vérifiez votre réseau.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Jeton GitHub refusé. Créez-en un avec le droit « Gists ».');
  if (res.status === 404) throw new Error('Gist introuvable. Videz l’identifiant pour en créer un nouveau.');
  if (!res.ok) throw new Error(`GitHub : ${data.message || res.status}`);
  return data;
}

// Fusion "le plus récent gagne", suppressions comprises
export function merge(local, remote) {
  const tombs = { ...(remote.tombstones || {}), ...(local.tombstones || {}) };
  for (const [k, v] of Object.entries(remote.tombstones || {})) if (!tombs[k] || v > tombs[k]) tombs[k] = v;
  const out = { tombstones: tombs };
  for (const s of STORES) {
    const map = new Map();
    for (const r of [...(local[s] || []), ...(remote[s] || [])]) {
      const cur = map.get(r.id);
      if (!cur || (r.updatedAt || '') > (cur.updatedAt || '')) map.set(r.id, r);
    }
    out[s] = [...map.values()].filter(r => { const t = tombs[`${s}:${r.id}`]; return !t || (r.updatedAt || '') > t; });
  }
  return out;
}

// Remplace les données locales par l'état fusionné
export async function writeLocal(state) {
  for (const s of STORES) {
    const current = await all(s);
    const keep = new Set((state[s] || []).map(r => r.id));
    for (const r of current) if (!keep.has(r.id)) await rawDelete(s, r.id);
    await putMany(s, state[s] || [], { touch: false });
  }
  await kvSet('tombstones', state.tombstones || {});
}

export async function syncNow(settings) {
  const token = settings.ghToken;
  if (!token) throw new Error('Ajoutez un jeton GitHub dans Réglages.');
  const local = await exportAll();
  let merged = local;
  let gistId = settings.gistId;

  if (gistId) {
    const gist = await gh(`/gists/${encodeURIComponent(gistId)}`, token);
    const f = gist.files?.[DATA_FILE];
    if (f) {
      let content = f.content;
      if (f.truncated) {
        if (!/^https:\/\/gist\.githubusercontent\.com\//.test(f.raw_url || '')) throw new Error('Adresse de Gist inattendue.');
        content = await (await fetch(f.raw_url)).text();
      }
      try { merged = merge(local, sanitizeState(JSON.parse(content))); } catch { /* fichier distant illisible : on l'écrase */ }
    }
  }
  await writeLocal(merged);

  const payload = { ...merged, app: 'planeo', version: 1, exportedAt: new Date().toISOString() };
  const ics = buildICS({ tasks: merged.tasks, projects: merged.projects, name: 'Planéo' });
  const files = { [DATA_FILE]: { content: JSON.stringify(payload) }, [ICS_FILE]: { content: ics } };

  const gist = gistId
    ? await gh(`/gists/${encodeURIComponent(gistId)}`, token, { method: 'PATCH', body: JSON.stringify({ files }) })
    : await gh('/gists', token, { method: 'POST', body: JSON.stringify({ description: 'Planéo : sauvegarde privée', public: false, files }) });

  gistId = gist.id;
  const owner = gist.owner?.login;
  const icsUrl = owner ? `https://gist.githubusercontent.com/${owner}/${gistId}/raw/${ICS_FILE}` : '';
  await kvSet('lastSync', new Date().toISOString());
  return { gistId, icsUrl };
}

export const lastSync = () => kvGet('lastSync', null);

/* ---------- Contrôle strict des données externes (import, Gist) ----------
   Tout ce qui ne respecte pas le format attendu est corrigé ou rejeté,
   pour qu'aucun contenu piégé ne puisse s'exécuter dans la page. */
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const okId = v => (typeof v === 'string' && ID.test(v) ? v : null);
const iso = v => (typeof v === 'string' && v.length < 40 && !isNaN(new Date(v)) ? new Date(v).toISOString() : null);
const txt = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const list = v => (Array.isArray(v) ? v : []);
const oneOf = (v, set, d) => (set.includes(v) ? v : d);
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null; };
const stamps = r => ({ createdAt: iso(r.createdAt) || new Date(0).toISOString(), updatedAt: iso(r.updatedAt) || new Date(0).toISOString() });

function cleanProject(r) {
  const id = okId(r?.id); if (!id) return null;
  return {
    id, ...stamps(r),
    title: txt(r.title, 200) || 'Projet', summary: txt(r.summary, 5000), objective: txt(r.objective, 500),
    deadline: iso(r.deadline), status: oneOf(r.status, ['active', 'archived'], 'active'),
    successCriteria: list(r.successCriteria).map(x => txt(x, 300)).filter(Boolean).slice(0, 30),
    risks: list(r.risks).map(x => txt(x, 300)).filter(Boolean).slice(0, 30),
    milestones: list(r.milestones).map(m => okId(m?.id) && {
      id: m.id, title: txt(m.title, 200) || 'Étape', expectations: txt(m.expectations, 2000),
      deadline: iso(m.deadline), order: num(m.order, 0, 999) ?? 0,
    }).filter(Boolean).slice(0, 100),
    chat: list(r.chat).map(c => c && ['user', 'assistant'].includes(c.role) && { role: c.role, content: txt(c.content, 20000) }).filter(Boolean).slice(-200),
    replans: list(r.replans).map(x => x && { at: iso(x.at), summary: txt(x.summary, 1000) }).filter(x => x && x.at).slice(-100),
  };
}

function cleanTask(r) {
  const id = okId(r?.id); if (!id) return null;
  return {
    id, ...stamps(r),
    projectId: okId(r.projectId), milestoneId: okId(r.milestoneId),
    title: txt(r.title, 300) || 'Tâche', notes: txt(r.notes, 5000),
    due: iso(r.due), completedAt: iso(r.completedAt),
    estimateMin: num(r.estimateMin, 1, 100000),
    priority: oneOf(r.priority, ['haute', 'normale', 'basse'], 'normale'),
    status: oneOf(r.status, ['todo', 'done', 'dropped'], 'todo'),
    reminders: [...new Set(list(r.reminders).map(x => num(x, 0, 43200)).filter(x => x !== null))].slice(0, 10),
    checklist: list(r.checklist).map(c => okId(c?.id) && { id: c.id, text: txt(c.text, 300), done: c.done === true }).filter(Boolean).slice(0, 50),
  };
}

function cleanCheckin(r) {
  const id = okId(r?.id); const taskId = okId(r?.taskId);
  if (!id || !taskId) return null;
  const answers = {};
  if (r.answers && typeof r.answers === 'object') {
    for (const [k, v] of Object.entries(r.answers).slice(0, 20)) if (/^[a-zA-Z]{1,30}$/.test(k) && typeof v === 'string') answers[k] = txt(v, 2000);
  }
  return {
    id, taskId, ...stamps(r), projectId: okId(r.projectId),
    type: oneOf(r.type, ['success', 'late', 'overdue', 'skipped'], 'skipped'),
    key: txt(r.key, 100), answers, dueAt: iso(r.dueAt),
  };
}

export function sanitizeState(raw) {
  const tomb = {};
  if (raw && raw.tombstones && typeof raw.tombstones === 'object') {
    for (const [k, v] of Object.entries(raw.tombstones)) if (/^(projects|tasks|checkins):[A-Za-z0-9_-]{1,80}$/.test(k) && iso(v)) tomb[k] = iso(v);
  }
  return {
    tombstones: tomb,
    projects: list(raw?.projects).map(cleanProject).filter(Boolean),
    tasks: list(raw?.tasks).map(cleanTask).filter(Boolean),
    checkins: list(raw?.checkins).map(cleanCheckin).filter(Boolean),
  };
}
