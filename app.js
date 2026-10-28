import * as db from './db.js';
import { PROVIDERS, chat, listModels, extractJSON, modelFor } from './ai.js';
import { coachSystem, planInstruction, manualStarter, replanPrompt, discussSystem } from './prompts.js';
import { normalizePlan, materialize, makeTask, snapshot, localShift, previewFromAI, previewIsEmpty, applyPreview } from './plan.js';
import { SURVEYS, pendingSurveys, insights } from './surveys.js';
import { checkDue, scheduleNtfy, testNtfy, randomTopic, askPermission, notificationsState, registerPeriodic } from './reminders.js';
import { buildICS } from './ics.js';
import { syncNow, lastSync, merge, writeLocal, sanitizeState } from './sync.js';
import {
  uid, esc, $, $$, toInput, fromInput, fmtDue, fmtLong, fmtDay, fmtDuration, reminderLabel,
  dayDiff, debounce, toast, download, copyText, miniMarkdown,
} from './util.js';

const VERSION = '1.6.0';
const AUTHOR_URL = 'https://www.linkedin.com/in/marie-adelphe-aguessy-a04689275/';
const LOGO = `<svg aria-hidden="true" class="logo" viewBox="0 0 512 512"><defs><linearGradient id="plg-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6E1B26"/><stop offset="1" stop-color="#3A0A10"/></linearGradient><radialGradient id="plg-glow" cx="390" cy="130" r="280" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3965c" stop-opacity=".38"/><stop offset="1" stop-color="#f3965c" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" rx="116" fill="url(#plg-bg)"/><rect width="512" height="512" rx="116" fill="url(#plg-glow)"/><g transform="translate(256 256) scale(1.0) translate(-256 -256)"><path d="M150 436 V 264 C 150 170, 294 152, 310 238 C 320 294, 252 320, 198 302" fill="none" stroke="#f3965c" stroke-width="22" stroke-linecap="round" stroke-dasharray="1 38"/><circle cx="150" cy="436" r="19" fill="#FFE2CF"/><circle cx="150" cy="360" r="14" fill="#FFE2CF"/><g transform="translate(244 54) scale(.54)"><polygon points="430,98 92,238 236,292" fill="#FFE2CF"/><polygon points="430,98 236,292 300,428" fill="#f3965c"/><polygon points="236,292 300,428 252,350" fill="#b26c4d"/><polygon points="236,292 252,350 214,380" fill="#8A3F33"/></g></g></svg>`;
const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3L15 6.5"/></svg>';

// Anneau de progression
function ring(pct, label, cls = '') {
  const c = 2 * Math.PI * 26;
  return `<div class="ring ${cls}" role="img" aria-label="${pct} % terminé"><svg viewBox="0 0 64 64"><circle class="ring-bg" cx="32" cy="32" r="26"/><circle class="ring-fg" cx="32" cy="32" r="26" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}"/></svg><span class="ring-label">${label}</span></div>`;
}
const h2 = (title, n) => `<h2>${title}${n ? `<span class="count">${n}</span>` : ''}</h2>`;
const DEFAULTS = {
  provider: 'manual', keys: {}, models: {},
  ntfyServer: 'https://ntfy.sh', ntfyTopic: '', ntfyWindowH: 24,
  ghToken: '', gistId: '', icsUrl: '', autoSync: false,
  defaultReminders: [1440, 60],
};
const REMINDER_CHOICES = [[10080, '1 semaine avant'], [1440, 'La veille'], [180, '3 h avant'], [60, '1 h avant'], [15, '15 min avant']];
const S = { projects: [], tasks: [], checkins: [], settings: { ...DEFAULTS }, studio: null, draft: '', taskFilter: 'todo', installEvt: null, busy: false };

/* ---------------- Données ---------------- */
async function load() {
  const [projects, tasks, checkins] = await Promise.all(db.STORES.map(s => db.all(s)));
  Object.assign(S, { projects, tasks, checkins });
  S.settings = cleanSettings({ ...DEFAULTS, ...(await db.kvGet('settings', {})) });
  S.studio = S.studio || (await db.kvGet('studio', null)) || freshStudio();
}
function cleanSettings(st) {
  if (!PROVIDERS[st.provider]) st.provider = 'manual';
  st.ntfyWindowH = [12, 24, 48, 72].includes(Number(st.ntfyWindowH)) ? Number(st.ntfyWindowH) : 24;
  st.defaultReminders = (Array.isArray(st.defaultReminders) ? st.defaultReminders : []).map(Number).filter(n => REMINDER_CHOICES.some(([m]) => m === n));
  if (typeof st.ntfyTopic !== 'string' || !/^[\w-]{0,64}$/.test(st.ntfyTopic)) st.ntfyTopic = '';
  if (typeof st.gistId !== 'string' || !/^[a-f0-9]{0,64}$/i.test(st.gistId)) st.gistId = '';
  for (const k of ['keys', 'models']) if (!st[k] || typeof st[k] !== 'object') st[k] = {};
  return st;
}
const freshStudio = (kind = 'project', projectId = null) => ({ kind, projectId, messages: [] });
const saveStudio = () => db.kvSet('studio', S.studio);
async function saveSettings(patch) { Object.assign(S.settings, patch); await db.kvSet('settings', S.settings); }

const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
const project = id => S.projects.find(p => p.id === id);
const task = id => S.tasks.find(t => t.id === id);
const liveTasks = pid => S.tasks.filter(t => t.projectId === pid && t.status !== 'dropped');
const isOverdue = t => t.status === 'todo' && t.due && new Date(t.due) < Date.now();
const ins = () => insights(S.tasks, S.checkins);
const aiReady = () => S.settings.provider !== 'manual';

/* ---------------- Rendu ---------------- */
const view = () => $('#view');
const parts = () => (location.hash.slice(1) || '/').split('/').filter(Boolean);

function render() {
  const [r, id] = parts();
  const map = { projets: viewProjects, projet: () => viewProject(id), taches: viewTasks, tache: viewTasks, atelier: () => viewStudio(id), reglages: viewSettings };
  const fn = map[r] || viewToday;
  view().innerHTML = fn();
  $$('#nav a').forEach(a => {
    const target = a.getAttribute('href').slice(2).split('/')[0];
    const active = target === (r === 'projet' ? 'projets' : r === 'tache' ? 'taches' : (r || ''));
    a.toggleAttribute('aria-current', active);
    if (active) a.setAttribute('aria-current', 'page');
  });
  const pend = pendingSurveys(S.tasks, S.checkins).length;
  const badge = $('#nav-badge');
  if (badge) { badge.textContent = pend; badge.hidden = !pend; }
  afterRender(r, id);
}

function afterRender(r, id) {
  if (r === 'tache' && id && task(id) && !$('#modal').open) taskModal(task(id));
  if (r === 'atelier') {
    const log = $('.chat-log'); if (log) log.scrollTop = log.scrollHeight;
    const ta = $('#composer'); if (ta) { ta.value = S.draft; ta.addEventListener('input', () => { S.draft = ta.value; }); }
  }
  if (r === 'reglages') bindSettings();
}

const emptyLogo = (title, text, action = '') => `<div class="empty empty-logo">${LOGO}<p class="empty-title">${title}</p><p>${text}</p>${action}</div>`;
const empty = (title, text, action = '') => `<div class="empty"><p class="empty-title">${title}</p><p>${text}</p>${action}</div>`;

function taskRow(t, { showProject = true } = {}) {
  const p = showProject && t.projectId ? project(t.projectId) : null;
  const cl = t.checklist || [];
  const doneCl = cl.filter(c => c.done).length;
  const cls = ['task', ['todo', 'done', 'dropped'].includes(t.status) ? t.status : '', isOverdue(t) ? 'overdue' : '', t.priority === 'haute' ? 'prio-high' : ''].join(' ');
  return `<li class="${cls}">
    <button class="tick" data-action="toggle-task" data-id="${esc(t.id)}" aria-pressed="${t.status === 'done'}" aria-label="${t.status === 'done' ? 'Rouvrir' : 'Terminer'} : ${esc(t.title)}">${CHECK}</button>
    <button class="task-main" data-action="open-task" data-id="${esc(t.id)}">
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-meta">
        <span class="${isOverdue(t) ? 'is-late' : ''}">${fmtDue(t.due)}</span>
        ${t.estimateMin ? `<span>${fmtDuration(t.estimateMin)}</span>` : ''}
        ${cl.length ? `<span>${doneCl}/${cl.length} étapes</span>` : ''}
        ${t.priority === 'haute' && t.status !== 'done' ? '<span class="prio">Prioritaire</span>' : ''}
        ${p ? `<span class="tag">${esc(p.title)}</span>` : ''}
      </span>
    </button>
  </li>`;
}
const taskList = (ts, o) => `<ul class="tasks">${ts.map(t => taskRow(t, o)).join('')}</ul>`;

function projCard(p) {
  const pr = progressOf(p.id);
  const next = [...(p.milestones || [])].sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''))
    .find(m => liveTasks(p.id).some(t => t.milestoneId === m.id && t.status !== 'done'));
  const left = p.deadline ? dayDiff(p.deadline) : null;
  return `<li><a class="proj" href="#/projet/${esc(p.id)}">
    <span class="proj-text">
      <span class="proj-title">${esc(p.title)}</span>
      ${p.objective ? `<span class="proj-obj">${esc(p.objective)}</span>` : ''}
      <span class="proj-chips">
        ${next ? `<span class="pill">Étape : ${esc(next.title)}</span>` : ''}
        ${left !== null ? `<span class="pill ${left < 0 ? 'pill-late' : ''}">${left < 0 ? 'Échéance dépassée' : left === 0 ? 'Fin aujourd’hui' : `J-${left}`}</span>` : ''}
      </span>
    </span>
    ${ring(pr.pct, `<strong>${pr.pct}%</strong>`, 'ring-sm')}
  </a></li>`;
}

function progressOf(pid) {
  const ts = liveTasks(pid);
  const d = ts.filter(t => t.status === 'done').length;
  return { total: ts.length, done: d, pct: ts.length ? Math.round((d / ts.length) * 100) : 0 };
}

/* ---------- Aujourd'hui ---------- */
function viewToday() {
  const live = S.tasks.filter(t => t.status === 'todo');
  const overdue = live.filter(isOverdue).sort(byDue);
  const today = live.filter(t => t.due && !isOverdue(t) && dayDiff(t.due) === 0).sort(byDue);
  const soon = live.filter(t => t.due && dayDiff(t.due) >= 1 && dayDiff(t.due) <= 7).sort(byDue);
  const undated = live.filter(t => !t.due);
  const pend = pendingSurveys(S.tasks, S.checkins);
  const active = S.projects.filter(p => p.status === 'active');
  const h = new Date().getHours();
  const hello = h < 5 ? 'Bonne nuit' : h < 18 ? 'Bonjour' : 'Bonsoir';
  const { stats, text } = ins();

  const nothing = !S.tasks.length && !S.projects.length;
  const todayAll = S.tasks.filter(t => t.status !== 'dropped' && ((t.due && dayDiff(t.due) === 0) || (t.completedAt && dayDiff(t.completedAt) === 0)));
  const todayDone = todayAll.filter(t => t.status === 'done').length;
  const pct = todayAll.length ? Math.round((todayDone / todayAll.length) * 100) : 0;
  return `
  <header class="hero">
    <div class="hero-text">
    <p class="kicker">${fmtLong(new Date().toISOString())}</p>
    <h1>${hello}</h1>
    <p class="lede">${nothing ? 'Décrivez une idée, Planéo vous aide à l’affiner puis la transforme en plan.'
      : overdue.length ? `${overdue.length} tâche${overdue.length > 1 ? 's' : ''} en retard. On fait le point ?`
      : today.length ? `${today.length} tâche${today.length > 1 ? 's' : ''} prévue${today.length > 1 ? 's' : ''} aujourd’hui.`
      : 'Rien d’urgent aujourd’hui.'}</p>
    </div>
    ${todayAll.length ? ring(pct, `<strong>${todayDone}/${todayAll.length}</strong><small>aujourd’hui</small>`) : ''}
  </header>

  <form class="quick" data-form="quick">
    <label class="sr-only" for="quick-title">Nouvelle tâche</label>
    <input id="quick-title" name="title" placeholder="Ajouter une tâche rapide…" autocomplete="off" required>
    <button class="btn">Ajouter</button>
  </form>

  <div class="cols"><div class="col-main">
  ${nothing ? emptyLogo('Commencez par une idée', 'L’atelier vous pose les bonnes questions, puis crée la feuille de route, les tâches, les checklists et les rappels.', '<a class="btn btn-primary" href="#/atelier">Ouvrir l’atelier</a>') : ''}

  ${pend.length ? `<section class="block block-followup">
    ${h2('Faire le point', pend.length)}
    <p class="muted">Quelques questions rapides pour ajuster vos prochains plans.</p>
    <ul class="followups">${pend.slice(0, 6).map(x => `<li>
      <span class="fu-type fu-${x.type}">${x.type === 'success' ? 'Fait à temps' : x.type === 'late' ? 'Fait en retard' : 'Échéance dépassée'}</span>
      <span class="fu-title">${esc(x.task.title)}</span>
      <button class="btn btn-small" data-action="survey" data-id="${esc(x.task.id)}" data-type="${x.type}" data-key="${esc(x.key)}">Répondre</button>
    </li>`).join('')}</ul>
  </section>` : ''}

  ${overdue.length ? `<section class="block">${h2('En retard', overdue.length)}${taskList(overdue)}</section>` : ''}
  ${today.length ? `<section class="block">${h2('Aujourd’hui', today.length)}${taskList(today)}</section>` : ''}
  ${soon.length ? `<section class="block">${h2('Les 7 prochains jours', soon.length)}${taskList(soon)}</section>` : ''}
  ${undated.length ? `<section class="block">${h2('Sans échéance', undated.length)}${taskList(undated.slice(0, 8))}</section>` : ''}

  </div><aside class="col-side">
  ${active.length ? `<section class="block">${h2('Projets en cours', active.length)}<ul class="projects">${active.map(projCard).join('')}</ul></section>` : ''}

  ${stats.done || stats.followUps ? `<section class="block"><h2>Vos habitudes</h2>
    <dl class="stats">
      <div><dt>À temps</dt><dd>${stats.onTimeRate ?? '–'}${stats.onTimeRate !== null ? ' %' : ''}</dd></div>
      <div><dt>Satisfaction</dt><dd>${stats.avgSatisfaction ?? '–'}${stats.avgSatisfaction ? '/5' : ''}</dd></div>
      <div><dt>Tâches faites</dt><dd>${stats.done}</dd></div>
    </dl>
    <p class="muted">${esc(text) || 'Répondez à quelques suivis : Planéo apprendra vos habitudes et ajustera les prochains plans.'}</p>
  </section>` : ''}
  </aside></div>`;
}

/* ---------- Projets ---------- */
function viewProjects() {
  const act = S.projects.filter(p => p.status !== 'archived');
  const arch = S.projects.filter(p => p.status === 'archived');
  const card = projCard;

  return `
  <header class="page-head">
    <h1>Projets</h1><p class="lede">Chaque projet a sa feuille de route, ses étapes et ses échéances.</p>
  </header>
  <div class="actions">
    <a class="btn btn-primary" href="#/atelier" data-action="new-studio" data-kind="project">Nouveau projet avec l’IA</a>
    <button class="btn" data-action="new-project">Créer à la main</button>
  </div>
  ${act.length ? `<ul class="projects projects-grid">${act.map(card).join('')}</ul>`
    : emptyLogo('Aucun projet', 'Lancez l’atelier : décrivez votre idée, l’IA vous aide à l’optimiser puis génère la feuille de route.')}
  ${arch.length ? `<details class="block"><summary>Projets archivés (${arch.length})</summary><ul class="projects">${arch.map(card).join('')}</ul></details>` : ''}`;
}

function viewProject(id) {
  const p = project(id);
  if (!p) return empty('Projet introuvable', 'Il a peut-être été supprimé.', '<a class="btn" href="#/projets">Voir les projets</a>');
  const pr = progressOf(p.id);
  const ts = liveTasks(p.id);
  const dropped = S.tasks.filter(t => t.projectId === p.id && t.status === 'dropped');
  const ms = [...(p.milestones || [])].sort((a, b) => (a.deadline || '9').localeCompare(b.deadline || '9') || (a.order || 0) - (b.order || 0));
  const now = Date.now();
  let currentFound = false, hereDone = false;
  const items = [];
  const here = `<li class="here" aria-label="Aujourd’hui"><span class="here-pin"></span><span>Vous êtes ici, ${fmtDay(new Date().toISOString())}</span></li>`;
  for (const m of ms) {
    if (!hereDone && m.deadline && new Date(m.deadline) > now) { items.push(here); hereDone = true; }
    const mt = ts.filter(t => t.milestoneId === m.id).sort(byDue);
    const allDone = mt.length && mt.every(t => t.status === 'done');
    let state = allDone ? 'done' : (m.deadline && new Date(m.deadline) < now ? 'late' : 'upcoming');
    if (!allDone && !currentFound) { currentFound = true; if (state !== 'late') state = 'current'; }
    const left = m.deadline ? dayDiff(m.deadline) : null;
    items.push(`<li class="stop stop-${state}">
      <span class="node" aria-hidden="true">${state === 'done' ? CHECK : ''}</span>
      <div class="stop-body">
        <div class="stop-head">
          <h3>${esc(m.title)}</h3>
          <button class="link" data-action="edit-milestone" data-pid="${esc(p.id)}" data-id="${esc(m.id)}">Modifier</button>
        </div>
        <p class="stop-when">${m.deadline ? `${fmtLong(m.deadline)}${state === 'late' ? ', dépassée' : left !== null && left >= 0 && !allDone ? `, dans ${left} j` : ''}` : 'Sans date'}${allDone ? ', terminée' : ''}</p>
        ${m.expectations ? `<p class="stop-exp"><strong>Attendu :</strong> ${esc(m.expectations)}</p>` : ''}
        ${mt.length ? taskList(mt, { showProject: false }) : '<p class="muted">Aucune tâche pour cette étape.</p>'}
        <button class="link" data-action="new-task" data-pid="${esc(p.id)}" data-mid="${esc(m.id)}">Ajouter une tâche</button>
      </div>
    </li>`);
  }
  if (!hereDone) items.push(here);
  const loose = ts.filter(t => !t.milestoneId || !ms.some(m => m.id === t.milestoneId)).sort(byDue);
  const left = p.deadline ? dayDiff(p.deadline) : null;

  return `
  <a class="back" href="#/projets">Projets</a>
  <header class="hero">
    <div class="hero-text">
      <h1>${esc(p.title)}</h1>
      ${p.objective ? `<p class="lede">${esc(p.objective)}</p>` : ''}
      <p class="hero-chips">
        <span class="pill">${pr.done}/${pr.total} tâches</span>
        ${p.deadline ? `<span class="pill">${left !== null && left < 0 ? 'Échéance dépassée' : `Fin le ${fmtDay(p.deadline)}${left !== null ? `, J-${left}` : ''}`}</span>` : ''}
      </p>
    </div>
    ${ring(pr.pct, `<strong>${pr.pct}%</strong><small>fait</small>`)}
  </header>

  <div class="actions">
    <button class="btn btn-primary" data-action="replan-ai" data-pid="${esc(p.id)}">Replanifier avec l’IA</button>
    <button class="btn" data-action="discuss" data-pid="${esc(p.id)}">Discuter du projet</button>
    <button class="btn" data-action="new-task" data-pid="${esc(p.id)}">Ajouter une tâche</button>
    <details class="menu"><summary class="btn">Plus</summary><div class="menu-list">
      <button data-action="new-milestone" data-pid="${esc(p.id)}">Ajouter une étape</button>
      <button data-action="shift-project" data-pid="${esc(p.id)}">Décaler tout le projet</button>
      <button data-action="ics-project" data-pid="${esc(p.id)}">Exporter vers mon agenda (.ics)</button>
      <button data-action="edit-project" data-pid="${esc(p.id)}">Modifier le projet</button>
      <button data-action="archive-project" data-pid="${esc(p.id)}">${p.status === 'archived' ? 'Réactiver' : 'Archiver'}</button>
      <button class="danger" data-action="delete-project" data-pid="${esc(p.id)}">Supprimer</button>
    </div></details>
  </div>

  <div class="cols"><div class="col-main">
  <section class="block">
    ${h2('Feuille de route')}
    ${ms.length ? `<ol class="trail">${items.join('')}</ol>` : empty('Pas encore d’étapes', 'Ajoutez des étapes pour structurer le projet, ou laissez l’IA les proposer.', `<button class="btn" data-action="new-milestone" data-pid="${esc(p.id)}">Ajouter une étape</button>`)}
  </section>

  ${loose.length ? `<section class="block"><h2>Hors étape</h2>${taskList(loose, { showProject: false })}</section>` : ''}
  </div><aside class="col-side">
  ${(p.summary || p.successCriteria?.length || p.risks?.length) ? `<details class="block synth" open>
    <summary>Synthèse du projet</summary>
    ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
    ${p.successCriteria?.length ? `<h3>Critères de réussite</h3><ul>${p.successCriteria.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${p.risks?.length ? `<h3>Risques et parades</h3><ul>${p.risks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  </details>` : ''}

  ${dropped.length ? `<details class="block"><summary>Tâches abandonnées (${dropped.length})</summary><ul class="plain">${dropped.map(t => `<li>${esc(t.title)} <button class="link" data-action="restore-task" data-id="${esc(t.id)}">Restaurer</button></li>`).join('')}</ul></details>` : ''}
  ${p.replans?.length ? `<details class="block"><summary>Historique des replanifications (${p.replans.length})</summary><ul class="plain">${p.replans.slice().reverse().map(r => `<li><strong>${fmtDay(r.at)}</strong> : ${esc(r.summary || 'Mise à jour du plan')}</li>`).join('')}</ul></details>` : ''}
  </aside></div>`;
}

/* ---------- Tâches ---------- */
function viewTasks() {
  const f = S.taskFilter;
  let ts = S.tasks.filter(t => t.status !== 'dropped');
  if (f === 'todo') ts = ts.filter(t => t.status === 'todo');
  if (f === 'late') ts = ts.filter(isOverdue);
  if (f === 'done') ts = ts.filter(t => t.status === 'done').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  else ts.sort(byDue);
  const groups = [];
  if (f === 'done') groups.push(['Terminées', ts]);
  else {
    const g = { 'En retard': [], 'Aujourd’hui': [], 'Demain': [], 'Cette semaine': [], 'Plus tard': [], 'Sans échéance': [] };
    for (const t of ts) {
      if (!t.due) g['Sans échéance'].push(t);
      else if (isOverdue(t)) g['En retard'].push(t);
      else { const d = dayDiff(t.due); g[d <= 0 ? 'Aujourd’hui' : d === 1 ? 'Demain' : d <= 7 ? 'Cette semaine' : 'Plus tard'].push(t); }
    }
    for (const [k, v] of Object.entries(g)) if (v.length) groups.push([k, v]);
  }
  const chip = (k, l) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${f === k}">${l}</button>`;
  return `
  <header class="page-head"><h1>Tâches</h1></header>
  <div class="actions">
    <button class="btn btn-primary" data-action="new-task">Nouvelle tâche</button>
    <a class="btn" href="#/atelier" data-action="new-studio" data-kind="task">Préparer une tâche avec l’IA</a>
  </div>
  <div class="chips filters" role="group" aria-label="Filtrer">${chip('todo', 'À faire')}${chip('late', 'En retard')}${chip('done', 'Terminées')}${chip('all', 'Toutes')}</div>
  ${groups.length ? `<div class="task-groups">${groups.map(([k, v]) => `<section class="block">${h2(k, v.length)}${taskList(v)}</section>`).join('')}</div>`
    : empty(f === 'late' ? 'Aucun retard' : 'Rien ici', f === 'late' ? 'Tout est dans les temps.' : 'Ajoutez une tâche ou préparez-en une avec l’IA.')}`;
}

/* ---------- Atelier IA ---------- */
function viewStudio(pidFromRoute) {
  if (pidFromRoute && S.studio.projectId !== pidFromRoute && project(pidFromRoute)) {
    S.studio = freshStudio('project', pidFromRoute); saveStudio();
  }
  const st = S.studio;
  const bound = st.projectId ? project(st.projectId) : null;
  const prov = PROVIDERS[S.settings.provider];
  const head = `
  <header class="page-head">
    <h1>Atelier</h1>
    <p class="lede">${bound ? `Discussion sur le projet « ${esc(bound.title)} ».` : 'Décrivez votre idée. L’IA la challenge, l’optimise, puis la découpe en plan d’action.'}</p>
  </header>
  <div class="studio-bar">
    ${bound ? `<button class="chip" data-action="unbind-studio">Nouvelle idée</button>` : `<div class="seg" role="group" aria-label="Type">
      <button class="chip" data-action="studio-kind" data-kind="project" aria-pressed="${st.kind === 'project'}">Projet</button>
      <button class="chip" data-action="studio-kind" data-kind="task" aria-pressed="${st.kind === 'task'}">Tâche</button>
    </div>`}
    <a class="provider" href="#/reglages">${aiReady() ? `${esc(prov.label.split(' (')[0])}, ${esc(modelFor(S.settings))}` : 'Mode manuel'}</a>
  </div>`;

  if (!aiReady()) return head + manualPanel(bound);

  const msgs = st.messages;
  const ideas = st.kind === 'task'
    ? ['Préparer mon entretien de jeudi', 'Faire ma déclaration d’impôts', 'Trier et vendre mes vieux vêtements']
    : ['Lancer un podcast sur la cuisine', 'Préparer un déménagement en décembre', 'Apprendre l’espagnol pour un voyage en mai'];
  return head + `
  <section class="chat">
    <div class="chat-log" aria-live="polite">
      ${msgs.length ? msgs.map(m => `<div class="msg msg-${m.role === 'assistant' ? 'assistant' : 'user'}">${m.role === 'assistant' ? miniMarkdown(m.content) : `<p>${esc(m.content).replace(/\n/g, '<br>')}</p>`}</div>`).join('')
        : `<div class="chat-empty">${LOGO}<p class="chat-empty-title">De quoi avez-vous envie de vous occuper ?</p><p>Une idée floue suffit. Par exemple :</p><div class="chips">${ideas.map(i => `<button class="chip" data-action="idea" data-text="${esc(i)}">${esc(i)}</button>`).join('')}</div></div>`}
      ${S.busy ? '<div class="msg msg-assistant typing" aria-label="Réponse en cours"><span></span><span></span><span></span></div>' : ''}
    </div>
    <form class="composer" data-form="chat">
      <label class="sr-only" for="composer">Votre message</label>
      <textarea id="composer" rows="3" placeholder="${msgs.length ? 'Répondez ou précisez…' : 'Décrivez votre idée, même floue…'}" ${S.busy ? 'disabled' : ''}></textarea>
      <button class="btn btn-primary" ${S.busy ? 'disabled' : ''}>Envoyer</button>
    </form>
    <div class="actions">
      <button class="btn btn-accent" data-action="${bound ? 'studio-update' : 'studio-plan'}" ${S.busy || !msgs.length ? 'disabled' : ''}>${bound ? 'Proposer une mise à jour' : 'Générer le plan'}</button>
      ${msgs.length ? '<button class="btn" data-action="studio-reset">Recommencer</button>' : ''}
    </div>
    <details class="block"><summary>Coller un plan JSON obtenu ailleurs</summary>${pasteBox(bound)}</details>
  </section>`;
}

function pasteBox(bound) {
  return `<form data-form="paste" data-mode="${bound ? 'replan' : 'plan'}" data-pid="${bound ? esc(bound.id) : ''}" class="paste">
    <label for="paste-json">Réponse de l’assistant (JSON)</label>
    <textarea id="paste-json" rows="6" placeholder='{ "kind": "project", "title": … }' required></textarea>
    <button class="btn btn-primary">${bound ? 'Analyser la mise à jour' : 'Créer à partir de ce plan'}</button>
  </form>`;
}

function manualPanel(bound) {
  const links = `<p class="links"><a href="https://chatgpt.com/" target="_blank" rel="noopener">ChatGPT</a><a href="https://claude.ai/new" target="_blank" rel="noopener">Claude</a><a href="https://gemini.google.com/app" target="_blank" rel="noopener">Gemini</a></p>`;
  if (bound) {
    return `<ol class="steps">
      <li><h3>Dites ce que vous voulez changer</h3>
        <label class="sr-only" for="manual-req">Votre demande</label>
        <textarea id="manual-req" rows="3" placeholder="Ex. : je n’ai que 3 h par semaine en novembre, décale ce qu’il faut."></textarea>
        <button class="btn" data-action="copy-replan" data-pid="${esc(bound.id)}">Copier la demande complète</button></li>
      <li><h3>Collez-la dans votre assistant</h3>${links}</li>
      <li><h3>Collez sa réponse ici</h3>${pasteBox(bound)}</li>
    </ol>`;
  }
  return `<ol class="steps">
    <li><h3>Copiez la consigne de départ</h3><p>Elle transforme votre assistant en coach de planification, avec le format de plan attendu par Planéo.</p>
      <button class="btn btn-primary" data-action="copy-starter">Copier la consigne</button></li>
    <li><h3>Discutez dans votre assistant gratuit</h3><p>Collez la consigne, décrivez l’idée, répondez à ses questions. Quand c’est clair, écrivez <strong>PLAN</strong>.</p>${links}</li>
    <li><h3>Collez le plan ici</h3>${pasteBox(null)}</li>
  </ol>
  <p class="muted">Pour discuter directement dans Planéo, choisissez un service IA gratuit dans <a href="#/reglages">Réglages</a>.</p>`;
}

/* ---------- Réglages ---------- */
function viewSettings() {
  const st = S.settings;
  const p = PROVIDERS[st.provider];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `
  <header class="page-head"><h1>Réglages</h1><p class="lede">Tout est enregistré sur cet appareil. Vos clés ne quittent jamais votre navigateur, sauf vers le service concerné.</p></header>
  <div class="settings-grid">

  <section class="block settings">
    <h2>Assistant IA</h2>
    <label for="s-provider">Service</label>
    <select id="s-provider" data-setting="provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === st.provider ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
    <p class="hint">${esc(p.note)}</p>
    ${st.provider !== 'manual' ? `
      <label for="s-key">Clé API</label>
      <input id="s-key" type="password" autocomplete="off" data-setting="keys.${st.provider}" value="${esc(st.keys[st.provider] || '')}" placeholder="Collez votre clé">
      <p class="hint"><a href="${p.keyUrl}" target="_blank" rel="noopener">Obtenir une clé</a></p>
      <label for="s-model">Modèle</label>
      <div class="inline">
        <input id="s-model" list="models" data-setting="models.${st.provider}" value="${esc(modelFor(st))}" placeholder="Nom du modèle">
        <datalist id="models"></datalist>
        <button class="btn" data-action="load-models">Charger les modèles</button>
      </div>
      <button class="btn" data-action="test-ai">Tester la connexion</button>` : ''}
  </section>

  <section class="block settings">
    <h2>Rappels</h2>
    <h3>Notifications de l’appareil</h3>
    <p class="hint" id="notif-state">Vérification…</p>
    <button class="btn" data-action="ask-notif">Activer les notifications</button>
    ${isIOS && !standalone ? '<p class="hint">Sur iPhone, ajoutez d’abord Planéo à l’écran d’accueil (Partager, puis « Sur l’écran d’accueil ») : les notifications ne fonctionnent que dans l’app installée.</p>' : ''}
    <p class="hint">Ces notifications s’affichent quand Planéo est ouvert, ou en arrière-plan sur Android (de façon irrégulière). Pour des rappels fiables app fermée, utilisez ntfy ou le calendrier ci-dessous.</p>

    <h3>Push sur téléphone avec ntfy (gratuit)</h3>
    <ol class="mini-steps">
      <li>Installez l’app ntfy (Android ou iPhone).</li>
      <li>Générez un sujet ci-dessous, puis abonnez-vous à ce sujet dans l’app.</li>
      <li>Ouvrez Planéo de temps en temps : les rappels à venir sont programmés jusqu’à ${Number(st.ntfyWindowH) || 24} h à l’avance.</li>
    </ol>
    <label for="s-topic">Sujet ntfy (gardez-le secret, c’est votre adresse)</label>
    <div class="inline">
      <input id="s-topic" data-setting="ntfyTopic" value="${esc(st.ntfyTopic)}" placeholder="planeo-…">
      <button class="btn" data-action="gen-topic">Générer</button>
      <button class="btn" data-action="test-ntfy" ${st.ntfyTopic ? '' : 'disabled'}>Tester</button>
    </div>
    <label for="s-window">Programmer les rappels à l’avance sur</label>
    <select id="s-window" data-setting="ntfyWindowH">${[12, 24, 48, 72].map(h => `<option value="${h}" ${Number(st.ntfyWindowH) === h ? 'selected' : ''}>${h} heures</option>`).join('')}</select>
    <p class="hint">Limite : un rappel déjà programmé sera envoyé même si la tâche est terminée entre-temps.</p>

    <h3>Rappels par défaut des nouvelles tâches</h3>
    <div class="chips">${REMINDER_CHOICES.map(([m, l]) => `<label class="chip"><input type="checkbox" data-action="default-rem" value="${m}" ${st.defaultReminders.includes(m) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
  </section>

  <section class="block settings">
    <h2>Agenda</h2>
    <p>Exportez vos tâches et étapes avec leurs alarmes vers Google Agenda, Apple Calendrier ou Outlook.</p>
    <button class="btn" data-action="ics-all">Télécharger le calendrier (.ics)</button>
    ${st.icsUrl ? `<h3>Abonnement automatique</h3>
      <p class="hint">Abonnez votre agenda à cette adresse : il se met à jour à chaque synchronisation (Google Agenda : « Autres agendas », puis « À partir de l’URL »). Ne la partagez pas.</p>
      <div class="inline"><input readonly value="${esc(st.icsUrl)}" aria-label="Adresse d’abonnement"><button class="btn" data-action="copy" data-text="${esc(st.icsUrl)}">Copier</button></div>` : '<p class="hint">Activez la synchronisation GitHub ci-dessous pour obtenir une adresse d’abonnement qui se met à jour toute seule.</p>'}
  </section>

  <section class="block settings">
    <h2>Sauvegarde et synchronisation GitHub</h2>
    <p>Vos données sont copiées dans un Gist secret de votre compte GitHub. Utile pour retrouver vos projets sur un autre appareil.</p>
    <ol class="mini-steps">
      <li>Créez un jeton sur <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub</a> avec la permission de compte « Gists » en lecture et écriture.</li>
      <li>Collez-le ci-dessous, puis appuyez sur « Synchroniser ».</li>
      <li>Sur un autre appareil, saisissez le même jeton et le même identifiant de Gist.</li>
    </ol>
    <label for="s-gh">Jeton GitHub</label>
    <input id="s-gh" type="password" autocomplete="off" data-setting="ghToken" value="${esc(st.ghToken)}">
    <label for="s-gist">Identifiant du Gist (rempli automatiquement)</label>
    <input id="s-gist" data-setting="gistId" value="${esc(st.gistId)}">
    <label class="check"><input type="checkbox" data-setting="autoSync" ${st.autoSync ? 'checked' : ''}> Synchroniser automatiquement après chaque modification</label>
    <button class="btn btn-primary" data-action="sync">Synchroniser</button>
    <p class="hint" id="last-sync"></p>
  </section>

  <section class="block settings">
    <h2>Données</h2>
    <div class="actions">
      <button class="btn" data-action="export-json">Exporter (JSON)</button>
      <label class="btn">Importer (JSON)<input type="file" accept="application/json,.json" data-action="import-json" hidden></label>
      <button class="btn btn-danger" data-action="wipe">Tout effacer</button>
    </div>
  </section>

  <section class="block settings">
    <h2>Installer l’application</h2>
    ${standalone ? '<p>Planéo est installée sur cet appareil.</p>'
      : S.installEvt ? '<button class="btn btn-primary" data-action="install">Installer Planéo</button>'
      : `<p class="hint">${isIOS ? 'Dans Safari : bouton Partager, puis « Sur l’écran d’accueil ».' : 'Dans le menu du navigateur : « Installer l’application » ou « Ajouter à l’écran d’accueil ».'}</p>`}
  </section>

  <section class="block settings about">
    <h2>À propos</h2>
    <div class="about-row">${LOGO}<div><p class="about-name">Planéo</p><p class="hint">Version ${VERSION}</p></div></div>
    <p class="credit">© ${new Date().getFullYear()} Copyright, ceci est un mini projet de <a href="${AUTHOR_URL}" target="_blank" rel="noopener">Marie-Adelphe A</a></p>
  </section>
  </div>`;
}

async function bindSettings() {
  const s = await notificationsState();
  const el = $('#notif-state');
  if (el) el.textContent = { granted: 'Activées sur cet appareil.', denied: 'Bloquées. Autorisez-les dans les réglages du navigateur.', default: 'Pas encore activées.', unsupported: 'Non prises en charge par ce navigateur.' }[s];
  const ls = await lastSync();
  const l = $('#last-sync'); if (l && ls) l.textContent = `Dernière synchronisation : ${fmtDue(ls)}`;
}

/* ---------------- Modale ---------------- */
function openModal(html, { wide = false } = {}) {
  const d = $('#modal');
  d.className = wide ? 'wide' : '';
  d.innerHTML = `<div class="modal-inner">${html}</div>`;
  if (!d.open) d.showModal();
  const first = d.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select');
  if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  return d;
}
function closeModal() {
  const d = $('#modal');
  if (d.open) d.close();
  if (parts()[0] === 'tache') history.replaceState(null, '', '#/taches');
}

const modalHead = title => `<div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-action="close" aria-label="Fermer">✕</button></div>`;

/* ---------- Formulaire de tâche ---------- */
function taskModal(t, defaults = {}) {
  const isNew = !t;
  t = t || makeTask({ reminders: [...S.settings.defaultReminders], ...defaults });
  const projOpts = S.projects.filter(p => p.status !== 'archived' || p.id === t.projectId);
  const p = project(t.projectId);
  const pending = !isNew && (isOverdue(t) || (t.status === 'done'));
  openModal(`${modalHead(isNew ? 'Nouvelle tâche' : 'Tâche')}
  <form data-form="task" data-id="${esc(t.id)}" data-new="${isNew}" class="form">
    <label for="t-title">Intitulé</label>
    <input id="t-title" name="title" value="${esc(t.title)}" required placeholder="Commencez par un verbe : appeler, écrire, choisir…">
    <div class="grid2">
      <div><label for="t-due">Échéance</label><input id="t-due" type="datetime-local" name="due" value="${toInput(t.due)}"></div>
      <div><label for="t-est">Durée estimée (min)</label><input id="t-est" type="number" min="0" step="5" name="estimateMin" value="${t.estimateMin || ''}"></div>
    </div>
    <div class="grid2">
      <div><label for="t-proj">Projet</label><select id="t-proj" name="projectId"><option value="">Aucun</option>${projOpts.map(x => `<option value="${esc(x.id)}" ${x.id === t.projectId ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></div>
      <div><label for="t-ms">Étape</label><select id="t-ms" name="milestoneId">${milestoneOptions(p, t.milestoneId)}</select></div>
    </div>
    <label for="t-prio">Priorité</label>
    <select id="t-prio" name="priority">${['haute', 'normale', 'basse'].map(x => `<option ${x === t.priority ? 'selected' : ''}>${x}</option>`).join('')}</select>

    <fieldset><legend>Checklist</legend>
      <ul class="checklist" id="t-cl">${(t.checklist || []).map(clRow).join('')}</ul>
      <button type="button" class="link" data-action="cl-add">Ajouter un élément</button>
    </fieldset>

    <fieldset><legend>Rappels</legend>
      <div class="chips">${REMINDER_CHOICES.map(([m, l]) => `<label class="chip"><input type="checkbox" name="rem" value="${m}" ${(t.reminders || []).includes(m) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      <p class="hint">Un rappel est aussi envoyé à l’échéance.</p>
    </fieldset>

    <label for="t-notes">Notes</label>
    <textarea id="t-notes" name="notes" rows="3">${esc(t.notes)}</textarea>

    <div class="modal-actions">
      <button class="btn btn-primary">${isNew ? 'Créer la tâche' : 'Enregistrer'}</button>
      ${!isNew && pending ? `<button type="button" class="btn" data-action="survey-now" data-id="${esc(t.id)}">Faire le point</button>` : ''}
      ${!isNew && t.status === 'todo' ? `<button type="button" class="btn" data-action="replan-task" data-id="${esc(t.id)}">Replanifier</button>` : ''}
      ${!isNew ? `<button type="button" class="btn btn-danger" data-action="delete-task" data-id="${esc(t.id)}">Supprimer</button>` : ''}
    </div>
  </form>`);
}
const clRow = c => `<li data-cid="${esc(c.id)}"><input type="checkbox" ${c.done ? 'checked' : ''} aria-label="Fait"><input class="cl-text" value="${esc(c.text)}" aria-label="Élément"><button type="button" class="icon-btn" data-action="cl-del" aria-label="Retirer">✕</button></li>`;
function milestoneOptions(p, sel) {
  if (!p) return '<option value="">—</option>';
  return `<option value="">Hors étape</option>` + (p.milestones || []).map(m => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.title)}</option>`).join('');
}

async function saveTaskForm(form) {
  const id = form.dataset.id;
  const isNew = form.dataset.new === 'true';
  const fd = new FormData(form);
  const base = isNew ? makeTask() : { ...task(id) };
  base.id = id;
  base.title = fd.get('title').trim();
  base.due = fromInput(fd.get('due'));
  base.estimateMin = Number(fd.get('estimateMin')) || null;
  base.projectId = fd.get('projectId') || null;
  base.milestoneId = base.projectId ? (fd.get('milestoneId') || null) : null;
  base.priority = fd.get('priority');
  base.notes = fd.get('notes').trim();
  base.reminders = fd.getAll('rem').map(Number);
  base.checklist = $$('#t-cl li', form).map(li => ({ id: li.dataset.cid, text: $('.cl-text', li).value.trim(), done: $('input[type=checkbox]', li).checked })).filter(c => c.text);
  if (isNew) base.status = 'todo';
  await db.put('tasks', base);
  closeModal();
  toast(isNew ? 'Tâche créée.' : 'Tâche enregistrée.');
}

/* ---------- Projet et étapes ---------- */
function projectModal(p) {
  const isNew = !p;
  p = p || { id: uid(), title: '', objective: '', summary: '', deadline: null, milestones: [], status: 'active' };
  openModal(`${modalHead(isNew ? 'Nouveau projet' : 'Modifier le projet')}
  <form data-form="project" data-id="${esc(p.id)}" data-new="${isNew}" class="form">
    <label for="p-title">Nom</label><input id="p-title" name="title" value="${esc(p.title)}" required>
    <label for="p-obj">Objectif mesurable</label><input id="p-obj" name="objective" value="${esc(p.objective)}" placeholder="Ex. : publier 4 épisodes avant le 31 janvier">
    <label for="p-dl">Échéance finale</label><input id="p-dl" type="datetime-local" name="deadline" value="${toInput(p.deadline)}">
    <label for="p-sum">Synthèse</label><textarea id="p-sum" name="summary" rows="4">${esc(p.summary)}</textarea>
    <div class="modal-actions"><button class="btn btn-primary">${isNew ? 'Créer le projet' : 'Enregistrer'}</button></div>
  </form>`);
}

function milestoneModal(p, m) {
  const isNew = !m;
  m = m || { id: uid(), title: '', expectations: '', deadline: null, order: (p.milestones || []).length };
  openModal(`${modalHead(isNew ? 'Nouvelle étape' : 'Modifier l’étape')}
  <form data-form="milestone" data-pid="${esc(p.id)}" data-id="${esc(m.id)}" class="form">
    <label for="m-title">Nom de l’étape</label><input id="m-title" name="title" value="${esc(m.title)}" required>
    <label for="m-exp">Attentes (ce qui doit exister à la fin)</label><textarea id="m-exp" name="expectations" rows="3">${esc(m.expectations)}</textarea>
    <label for="m-dl">Date limite</label><input id="m-dl" type="datetime-local" name="deadline" value="${toInput(m.deadline)}">
    <div class="modal-actions">
      <button class="btn btn-primary">${isNew ? 'Ajouter l’étape' : 'Enregistrer'}</button>
      ${!isNew ? `<button type="button" class="btn btn-danger" data-action="delete-milestone" data-pid="${esc(p.id)}" data-id="${esc(m.id)}">Supprimer l’étape</button>` : ''}
    </div>
  </form>`);
}

/* ---------- Suivi ---------- */
function surveyModal(t, type, key) {
  const def = SURVEYS[type];
  const q = x => {
    if (x.type === 'scale') return `<fieldset class="q"><legend>${x.label}</legend><div class="scale">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="${x.id}" value="${n}" ${x.optional ? '' : 'required'}><span>${n}</span></label>`).join('')}</div><p class="scale-ends"><span>${x.low}</span><span>${x.high}</span></p></fieldset>`;
    if (x.type === 'choice') return `<fieldset class="q"><legend>${x.label}</legend><div class="chips">${x.options.map(o => `<label class="chip"><input type="radio" name="${x.id}" value="${esc(o)}" ${x.optional ? '' : 'required'}> ${esc(o)}</label>`).join('')}</div></fieldset>`;
    if (x.type === 'datetime') return `<div class="q"><label for="q-${x.id}">${x.label}</label><input id="q-${x.id}" type="datetime-local" name="${x.id}"></div>`;
    return `<div class="q"><label for="q-${x.id}">${x.label}${x.optional ? ' (facultatif)' : ''}</label><textarea id="q-${x.id}" name="${x.id}" rows="2"></textarea></div>`;
  };
  openModal(`${modalHead(def.title)}
  <p class="survey-task">${esc(t.title)}</p>
  <p class="muted">${def.intro}</p>
  <form data-form="survey" data-id="${esc(t.id)}" data-type="${type}" data-key="${esc(key)}" class="form">
    ${def.questions.map(q).join('')}
    <div class="modal-actions">
      <button class="btn btn-primary">Enregistrer mes réponses</button>
      <button type="button" class="btn" data-action="close">Plus tard</button>
      <button type="button" class="link" data-action="skip-survey" data-id="${esc(t.id)}" data-key="${esc(key)}">Ne pas faire ce suivi</button>
    </div>
  </form>`);
}

async function saveSurvey(form) {
  const t = task(form.dataset.id);
  const type = form.dataset.type;
  const fd = new FormData(form);
  const answers = {};
  for (const [k, v] of fd.entries()) if (String(v).trim()) answers[k] = k === 'newDue' ? fromInput(v) : String(v).trim();
  await db.put('checkins', { id: uid(), taskId: t.id, projectId: t.projectId, type, key: form.dataset.key, answers, dueAt: t.due });
  if (type !== 'overdue') { closeModal(); toast('Merci, c’est noté. Planéo en tiendra compte.'); return; }
  decisionModal(task(t.id), answers);
}

function decisionModal(t, answers) {
  const drop = answers.need === 'L’abandonner' || answers.state === 'Plus utile';
  const p = project(t.projectId);
  openModal(`${modalHead('Que fait-on ?')}
  <p class="survey-task">${esc(t.title)}</p>
  <div class="decisions">
    ${drop ? `<button class="decision" data-action="drop-task" data-id="${esc(t.id)}"><strong>Abandonner la tâche</strong><span>Elle sort du plan mais reste visible dans le projet.</span></button>` : ''}
    ${answers.newDue ? `<button class="decision" data-action="shift-task" data-id="${esc(t.id)}" data-due="${esc(answers.newDue)}"><strong>Reporter au ${fmtDue(answers.newDue)}</strong><span>${p ? 'Les tâches suivantes du projet sont décalées d’autant. Vous validez avant.' : 'Seule cette tâche change.'}</span></button>` : ''}
    <button class="decision" data-action="replan-task-ai" data-id="${esc(t.id)}" data-req="${esc(`Suivi : état « ${answers.state || '?'} », cause « ${answers.cause || '?'} », besoin « ${answers.need || '?'} ». ${answers.comment || ''}`)}"><strong>${aiReady() ? 'Recalculer avec l’IA' : 'Recalculer avec votre assistant IA'}</strong><span>${p ? 'Nouvelles dates réalistes pour la suite du projet' : 'Nouvelle date'}${answers.need === 'La découper' ? ', avec la tâche découpée en plus petites' : ''}. Vous validez avant.</span></button>
    <div class="decision decision-form">
      <strong>Choisir une autre date</strong>
      <div class="inline"><input type="datetime-local" id="dec-date" aria-label="Nouvelle date"><button class="btn" data-action="shift-task-input" data-id="${esc(t.id)}">Reporter</button></div>
    </div>
  </div>`);
}

/* ---------- Aperçus ---------- */
function planPreviewModal(plan) {
  S.pendingPlan = plan;
  const tRow = t => `<li><span>${esc(t.title)}</span><span class="muted">${fmtDue(t.due)}${t.estimateMin ? `, ${fmtDuration(t.estimateMin)}` : ''}${t.checklist.length ? `, ${t.checklist.length} étapes` : ''}</span></li>`;
  openModal(`${modalHead('Votre plan')}
  <h3 class="plan-title">${esc(plan.title)}</h3>
  ${plan.objective ? `<p><strong>Objectif :</strong> ${esc(plan.objective)}</p>` : ''}
  ${plan.summary ? `<p>${esc(plan.summary)}</p>` : ''}
  ${plan.deadline ? `<p><strong>Échéance :</strong> ${fmtLong(plan.deadline)}</p>` : ''}
  ${plan.milestones.length ? `<ol class="trail trail-compact">${plan.milestones.map(m => `<li class="stop stop-upcoming"><span class="node" aria-hidden="true"></span><div class="stop-body">
      <h3>${esc(m.title)}</h3><p class="stop-when">${m.deadline ? fmtLong(m.deadline) : ''}</p>
      ${m.expectations ? `<p class="stop-exp"><strong>Attendu :</strong> ${esc(m.expectations)}</p>` : ''}
      <ul class="plain">${m.tasks.map(tRow).join('')}</ul></div></li>`).join('')}</ol>` : ''}
  ${plan.tasks.length ? `<ul class="plain">${plan.tasks.map(tRow).join('')}</ul>` : ''}
  ${plan.risks.length ? `<details><summary>Risques identifiés (${plan.risks.length})</summary><ul>${plan.risks.map(r => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
  <div class="modal-actions">
    <button class="btn btn-primary" data-action="create-plan">${plan.kind === 'task' && !plan.milestones.length ? 'Créer les tâches' : 'Créer le projet'}</button>
    <button class="btn" data-action="close">Revenir à la discussion</button>
  </div>`, { wide: true });
}

function replanPreviewModal(pv) {
  S.pendingPreview = pv;
  const date = d => (d ? fmtDue(d) : 'sans date');
  openModal(`${modalHead('Changements proposés')}
  ${pv.summary ? `<p>${esc(pv.summary)}</p>` : ''}
  ${pv.advice ? `<p class="advice"><strong>Conseil :</strong> ${esc(pv.advice)}</p>` : ''}
  ${pv.taskChanges.length ? `<h3>Tâches modifiées</h3><ul class="diff">${pv.taskChanges.map(({ task: t, patch }) => `<li><strong>${esc(patch.title || t.title)}</strong>
      ${patch.due ? `<span><del>${date(t.due)}</del> <ins>${date(patch.due)}</ins></span>` : ''}
      ${patch.title ? `<span class="muted">Renommée (avant : ${esc(t.title)})</span>` : ''}
      ${patch.checklist ? `<span class="muted">Nouvelle checklist de ${patch.checklist.length} éléments</span>` : ''}</li>`).join('')}</ul>` : ''}
  ${pv.newTasks.length ? `<h3>Nouvelles tâches</h3><ul class="diff">${pv.newTasks.map(t => `<li><ins>${esc(t.title)}</ins><span>${date(t.due)}</span></li>`).join('')}</ul>` : ''}
  ${pv.dropped.length ? `<h3>Tâches abandonnées</h3><ul class="diff">${pv.dropped.map(t => `<li><del>${esc(t.title)}</del></li>`).join('')}</ul>` : ''}
  ${pv.milestoneChanges.length ? `<h3>Étapes</h3><ul class="diff">${pv.milestoneChanges.map(({ milestone: m, patch }) => `<li><strong>${esc(m.title)}</strong>${patch.deadline ? `<span><del>${date(m.deadline)}</del> <ins>${date(patch.deadline)}</ins></span>` : ''}${patch.expectations ? '<span class="muted">Attentes mises à jour</span>' : ''}</li>`).join('')}</ul>` : ''}
  ${pv.projectPatch?.deadline ? `<h3>Échéance du projet</h3><ul class="diff"><li><span><del>${date(pv.project.deadline)}</del> <ins>${date(pv.projectPatch.deadline)}</ins></span></li></ul>` : ''}
  <div class="modal-actions">
    <button class="btn btn-primary" data-action="apply-preview">Appliquer les changements</button>
    <button class="btn" data-action="close">Annuler</button>
  </div>`, { wide: true });
}

function manualReplanModal(prompt, pid, tids) {
  S.manualCtx = { pid, tids };
  openModal(`${modalHead('Recalcul avec votre assistant')}
  <ol class="steps">
    <li><h3>Copiez la demande</h3><button class="btn btn-primary" data-action="copy" data-text="${esc(prompt)}">Copier la demande</button></li>
    <li><h3>Collez-la dans votre assistant</h3><p class="links"><a href="https://chatgpt.com/" target="_blank" rel="noopener">ChatGPT</a><a href="https://claude.ai/new" target="_blank" rel="noopener">Claude</a><a href="https://gemini.google.com/app" target="_blank" rel="noopener">Gemini</a></p></li>
    <li><h3>Collez sa réponse</h3>
      <form data-form="manual-replan" class="paste"><label for="mr-json" class="sr-only">Réponse JSON</label><textarea id="mr-json" rows="6" required placeholder='{ "summary": … }'></textarea><button class="btn btn-primary">Voir les changements</button></form></li>
  </ol>`, { wide: true });
}

/* ---------------- Actions IA ---------------- */
async function withBusy(fn) {
  S.busy = true; document.body.classList.add('is-busy'); render();
  try { await fn(); }
  catch (e) { console.error(e); toast(e.message || 'Une erreur est survenue.', 'error'); }
  finally { S.busy = false; document.body.classList.remove('is-busy'); render(); }
}

async function studioSend(text) {
  const st = S.studio;
  st.messages.push({ role: 'user', content: text });
  S.draft = '';
  await saveStudio();
  await withBusy(async () => {
    const bound = st.projectId ? project(st.projectId) : null;
    const system = bound
      ? discussSystem(snapshot(bound, liveTasks(bound.id), S.checkins), ins().text)
      : coachSystem(st.kind, ins().text);
    const reply = await chat(S.settings, { system, messages: st.messages });
    st.messages.push({ role: 'assistant', content: reply });
    await saveStudio();
  });
}

async function studioPlan() {
  const st = S.studio;
  await withBusy(async () => {
    const text = await chat(S.settings, {
      system: 'Tu es un planificateur. Tu réponds uniquement avec du JSON valide.',
      messages: [...st.messages, { role: 'user', content: planInstruction(st.kind, ins().text) }],
      json: true,
    });
    const plan = normalizePlan(extractJSON(text));
    setTimeout(() => planPreviewModal(plan), 0);
  });
}

function replanContext(pid, tids) {
  const p = pid ? project(pid) : null;
  const ts = p ? liveTasks(p.id) : tids.map(task).filter(Boolean);
  return { p, ts };
}

async function aiReplan({ pid = null, tids = [], request = '', withChat = false }) {
  const { p, ts } = replanContext(pid, tids);
  const prompt = replanPrompt(snapshot(p, ts, S.checkins), ins().text, request);
  if (!aiReady()) { manualReplanModal(prompt, pid, tids); return; }
  closeModal();
  await withBusy(async () => {
    const messages = withChat ? [...S.studio.messages, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    const text = await chat(S.settings, { system: 'Tu es un planificateur. Tu réponds uniquement avec du JSON valide.', messages, json: true });
    const pv = previewFromAI(extractJSON(text), p, ts);
    if (previewIsEmpty(pv)) { toast(pv.summary || 'L’IA ne propose aucun changement.'); return; }
    setTimeout(() => replanPreviewModal(pv), 0);
  });
}

async function createPlan() {
  const plan = S.pendingPlan; if (!plan) return;
  const { project: p, tasks } = materialize(plan, S.studio.messages);
  if (p) await db.put('projects', p, { silent: true });
  await db.putMany('tasks', tasks);
  S.studio = freshStudio(S.studio.kind); await saveStudio();
  S.pendingPlan = null;
  closeModal();
  toast(p ? 'Projet créé avec sa feuille de route.' : `${tasks.length} tâche${tasks.length > 1 ? 's' : ''} créée${tasks.length > 1 ? 's' : ''}.`);
  location.hash = p ? `#/projet/${esc(p.id)}` : '#/taches';
}

/* ---------------- Événements ---------------- */
const actions = {
  'close': () => closeModal(),
  'toggle-task': async el => {
    const t = { ...task(el.dataset.id) };
    if (t.status === 'done') { t.status = 'todo'; t.completedAt = null; await db.put('tasks', t); return; }
    t.status = 'done'; t.completedAt = new Date().toISOString();
    await db.put('tasks', t);
    const type = t.due && new Date(t.completedAt) > new Date(t.due) ? 'late' : 'success';
    surveyModal(t, type, `done:${t.completedAt}`);
  },
  'open-task': el => taskModal(task(el.dataset.id)),
  'new-task': el => taskModal(null, { projectId: el.dataset.pid || null, milestoneId: el.dataset.mid || null }),
  'delete-task': async el => { if (confirm('Supprimer cette tâche ?')) { await db.del('tasks', el.dataset.id); closeModal(); toast('Tâche supprimée.'); } },
  'restore-task': async el => { await db.put('tasks', { ...task(el.dataset.id), status: 'todo' }); },
  'drop-task': async el => { await db.put('tasks', { ...task(el.dataset.id), status: 'dropped' }); closeModal(); toast('Tâche abandonnée.'); },
  'survey': el => surveyModal(task(el.dataset.id), el.dataset.type, el.dataset.key),
  'survey-now': el => {
    const t = task(el.dataset.id);
    const type = t.status === 'done' ? (t.due && new Date(t.completedAt) > new Date(t.due) ? 'late' : 'success') : 'overdue';
    surveyModal(t, type, t.status === 'done' ? `done:${t.completedAt}` : `due:${t.due}`);
  },
  'skip-survey': async el => {
    const t = task(el.dataset.id);
    await db.put('checkins', { id: uid(), taskId: t.id, projectId: t.projectId, type: 'skipped', key: el.dataset.key, answers: {} });
    closeModal();
  },
  'shift-task': el => {
    const t = task(el.dataset.id);
    replanPreviewModal(localShift({ task: t, newDue: el.dataset.due, project: project(t.projectId), tasks: S.tasks }));
  },
  'shift-task-input': el => {
    const v = fromInput($('#dec-date').value);
    if (!v) { toast('Choisissez une date.', 'error'); return; }
    const t = task(el.dataset.id);
    replanPreviewModal(localShift({ task: t, newDue: v, project: project(t.projectId), tasks: S.tasks }));
  },
  'replan-task': el => { const t = task(el.dataset.id); decisionModal(t, {}); },
  'replan-task-ai': el => {
    const t = task(el.dataset.id);
    aiReplan({ pid: t.projectId, tids: [t.id], request: `La tâche « ${t.title} » (id ${esc(t.id)}) n’a pas été faite à temps. ${el.dataset.req || ''}` });
  },
  'replan-ai': el => aiReplan({ pid: el.dataset.pid, request: 'Remets le plan à jour en tenant compte des retards et des suivis.' }),
  'apply-preview': async () => {
    const pv = S.pendingPreview; if (!pv) return;
    await applyPreview(pv, { put: db.put, putMany: db.putMany });
    S.pendingPreview = null; closeModal(); toast('Plan mis à jour.');
  },
  'shift-project': el => {
    const p = project(el.dataset.pid);
    openModal(`${modalHead('Décaler tout le projet')}<form data-form="shift-project" data-pid="${esc(p.id)}" class="form">
      <label for="sp-days">Nombre de jours</label><input id="sp-days" type="number" name="days" value="7" required>
      <p class="hint">Les tâches non terminées, les étapes à venir et l’échéance sont décalées d’autant. Les tâches en retard sont replacées à partir d’aujourd’hui.</p>
      <div class="modal-actions"><button class="btn btn-primary">Voir les changements</button></div></form>`);
  },
  'discuss': el => { S.studio = freshStudio('project', el.dataset.pid); saveStudio(); location.hash = `#/atelier/${el.dataset.pid}`; },
  'new-studio': (el, ev) => { if (S.studio.projectId || S.studio.kind !== el.dataset.kind) { S.studio = freshStudio(el.dataset.kind); saveStudio(); } if (location.hash === '#/atelier') { ev.preventDefault(); render(); } },
  'studio-kind': el => { S.studio.kind = el.dataset.kind; saveStudio(); render(); },
  'unbind-studio': () => { S.studio = freshStudio(); saveStudio(); location.hash = '#/atelier'; },
  'studio-reset': () => { if (confirm('Effacer cette discussion ?')) { S.studio = freshStudio(S.studio.kind, S.studio.projectId); saveStudio(); render(); } },
  'studio-plan': () => studioPlan(),
  'studio-update': () => aiReplan({ pid: S.studio.projectId, request: 'Applique ce dont nous avons convenu dans la conversation.', withChat: true }),
  'idea': el => { S.draft = el.dataset.text; const c = $('#composer'); if (c) { c.value = S.draft; c.focus(); } },
  'create-plan': () => createPlan(),
  'copy-starter': async () => { await copyText(manualStarter(S.studio.kind, ins().text)); toast('Consigne copiée. Collez-la dans votre assistant.'); },
  'copy-replan': async el => {
    const p = project(el.dataset.pid);
    await copyText(replanPrompt(snapshot(p, liveTasks(p.id), S.checkins), ins().text, $('#manual-req')?.value || ''));
    toast('Demande copiée.');
  },
  'copy': async el => { await copyText(el.dataset.text); toast('Copié.'); },
  'filter': el => { S.taskFilter = el.dataset.f; render(); },
  'new-project': () => projectModal(null),
  'edit-project': el => projectModal(project(el.dataset.pid)),
  'archive-project': async el => { const p = project(el.dataset.pid); await db.put('projects', { ...p, status: p.status === 'archived' ? 'active' : 'archived' }); },
  'delete-project': async el => {
    const p = project(el.dataset.pid);
    if (!confirm(`Supprimer « ${p.title} » et toutes ses tâches ?`)) return;
    for (const t of S.tasks.filter(x => x.projectId === p.id)) await db.del('tasks', t.id);
    await db.del('projects', p.id);
    location.hash = '#/projets'; toast('Projet supprimé.');
  },
  'new-milestone': el => milestoneModal(project(el.dataset.pid), null),
  'edit-milestone': el => { const p = project(el.dataset.pid); milestoneModal(p, p.milestones.find(m => m.id === el.dataset.id)); },
  'delete-milestone': async el => {
    const p = project(el.dataset.pid);
    if (!confirm('Supprimer cette étape ? Ses tâches restent dans le projet, hors étape.')) return;
    await db.putMany('tasks', S.tasks.filter(t => t.milestoneId === el.dataset.id).map(t => ({ ...t, milestoneId: null })));
    await db.put('projects', { ...p, milestones: p.milestones.filter(m => m.id !== el.dataset.id) });
    closeModal();
  },
  'ics-project': el => { const p = project(el.dataset.pid); download(`${p.title.replace(/[^\w-]+/g, '_')}.ics`, buildICS({ tasks: liveTasks(p.id), projects: [p], name: p.title }), 'text/calendar'); },
  'ics-all': () => download('planeo.ics', buildICS({ tasks: S.tasks, projects: S.projects }), 'text/calendar'),
  'cl-add': () => { const ul = $('#t-cl'); ul.insertAdjacentHTML('beforeend', clRow({ id: uid(), text: '', done: false })); $('li:last-child .cl-text', ul).focus(); },
  'cl-del': el => el.closest('li').remove(),
  'load-models': async () => {
    try {
      const ms = await listModels(S.settings);
      $('#models').innerHTML = ms.map(m => `<option value="${esc(m)}">`).join('');
      toast(ms.length ? `${ms.length} modèles disponibles. Touchez le champ pour choisir.` : 'Aucun modèle trouvé.');
    } catch (e) { toast(e.message, 'error'); }
  },
  'test-ai': async () => {
    try { const r = await chat(S.settings, { system: 'Réponds en une phrase courte.', messages: [{ role: 'user', content: 'Dis bonjour en français.' }] }); toast(`Connexion réussie : ${r.slice(0, 80)}`); }
    catch (e) { toast(e.message, 'error'); }
  },
  'ask-notif': async () => { const r = await askPermission(); toast(r === 'granted' ? 'Notifications activées.' : 'Notifications non autorisées.'); bindSettings(); },
  'gen-topic': async () => { await saveSettings({ ntfyTopic: randomTopic() }); render(); },
  'test-ntfy': async () => { try { await testNtfy(S.settings); toast('Message de test envoyé à ntfy.'); } catch (e) { toast(e.message, 'error'); } },
  'sync': () => runSync(true),
  'export-json': async () => download(`planeo-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await db.exportAll(), null, 1), 'application/json'),
  'wipe': async () => {
    if (!confirm('Effacer toutes les données et réglages de cet appareil ?')) return;
    await db.clearAll(); S.studio = freshStudio(); await load(); render(); toast('Données effacées.');
  },
  'install': async () => { if (S.installEvt) { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; render(); } },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName !== 'A') e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.action === 'import-json') {
    const file = el.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'planeo') throw new Error('Ce fichier ne vient pas de Planéo.');
      await writeLocal(merge(await db.exportAll(), sanitizeState(data)));
      await refresh(); toast('Import terminé.');
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (el.dataset.action === 'default-rem') {
    const vals = $$('[data-action=default-rem]').filter(x => x.checked).map(x => Number(x.value));
    await saveSettings({ defaultReminders: vals }); return;
  }
  if (el.dataset.setting) {
    const path = el.dataset.setting.split('.');
    const value = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (path.length === 2) await saveSettings({ [path[0]]: { ...S.settings[path[0]], [path[1]]: value } });
    else if (path[0] === 'ntfyTopic' && value && !/^[\w-]{1,64}$/.test(value)) { toast('Sujet ntfy : lettres, chiffres, « - » et « _ » uniquement.', 'error'); return; }
    else if (path[0] === 'gistId' && value && !/^[a-f0-9]{1,64}$/i.test(value)) { toast('Identifiant de Gist invalide.', 'error'); return; }
    else await saveSettings({ [path[0]]: path[0] === 'ntfyWindowH' ? Number(value) : value });
    if (['provider', 'ntfyTopic', 'ntfyWindowH'].includes(path[0])) render();
    if (path[0] === 'ntfyTopic' || path[0] === 'ntfyWindowH') scheduleSoon();
    return;
  }
  // Checklist dans la fiche d'une tâche existante : enregistrement immédiat
  const li = el.closest('#t-cl li');
  if (li && el.type === 'checkbox') {
    const form = el.closest('form');
    if (form.dataset.new === 'true') return;
    const t = { ...task(form.dataset.id) };
    t.checklist = (t.checklist || []).map(c => (c.id === li.dataset.cid ? { ...c, done: el.checked } : c));
    await db.put('tasks', t);
  }
  if (el.id === 't-proj') $('#t-ms').innerHTML = milestoneOptions(project(el.value), null);
});

document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  try {
    if (kind === 'quick') {
      const title = f.elements.title.value.trim(); if (!title) return;
      await db.put('tasks', makeTask({ title, reminders: [...S.settings.defaultReminders] }));
      toast('Tâche ajoutée. Touchez-la pour fixer une échéance.');
    }
    if (kind === 'task') await saveTaskForm(f);
    if (kind === 'chat') {
      const text = $('#composer').value.trim(); if (!text || S.busy) return;
      await studioSend(text);
    }
    if (kind === 'paste') {
      const raw = extractJSON($('#paste-json').value);
      if (f.dataset.mode === 'replan') {
        const p = project(f.dataset.pid);
        const pv = previewFromAI(raw, p, liveTasks(p.id));
        if (previewIsEmpty(pv)) toast('Aucun changement trouvé dans cette réponse.'); else replanPreviewModal(pv);
      } else planPreviewModal(normalizePlan(raw));
    }
    if (kind === 'manual-replan') {
      const { p, ts } = replanContext(S.manualCtx.pid, S.manualCtx.tids);
      const pv = previewFromAI(extractJSON($('#mr-json').value), p, ts);
      if (previewIsEmpty(pv)) toast('Aucun changement trouvé dans cette réponse.'); else replanPreviewModal(pv);
    }
    if (kind === 'survey') await saveSurvey(f);
    if (kind === 'project') {
      const isNew = f.dataset.new === 'true';
      const p = isNew ? { id: f.dataset.id, milestones: [], status: 'active' } : { ...project(f.dataset.id) };
      Object.assign(p, { title: f.elements.title.value.trim(), objective: f.elements.objective.value.trim(), summary: f.elements.summary.value.trim(), deadline: fromInput(f.elements.deadline.value) });
      await db.put('projects', p);
      closeModal();
      if (isNew) location.hash = `#/projet/${esc(p.id)}`;
    }
    if (kind === 'milestone') {
      const p = { ...project(f.dataset.pid) };
      const m = { id: f.dataset.id, title: f.elements.title.value.trim(), expectations: f.elements.expectations.value.trim(), deadline: fromInput(f.elements.deadline.value) };
      const i = p.milestones.findIndex(x => x.id === m.id);
      if (i >= 0) p.milestones = p.milestones.map(x => (x.id === m.id ? { ...x, ...m } : x));
      else p.milestones = [...p.milestones, { ...m, order: p.milestones.length }];
      await db.put('projects', p);
      closeModal();
    }
    if (kind === 'shift-project') {
      const p = project(f.dataset.pid);
      const days = Number(f.elements.days.value) || 0;
      const delta = days * 86400000;
      const now = Date.now();
      const pv = { summary: `Décalage de ${days} jour${Math.abs(days) > 1 ? 's' : ''} du projet.`, advice: '', taskChanges: [], newTasks: [], dropped: [], milestoneChanges: [], projectPatch: null, project: p };
      for (const t of liveTasks(p.id)) {
        if (t.status !== 'todo' || !t.due) continue;
        const base = Math.max(new Date(t.due).getTime(), isOverdue(t) ? now : 0);
        pv.taskChanges.push({ task: t, patch: { due: new Date(base + delta).toISOString() } });
      }
      for (const m of p.milestones || []) if (m.deadline && new Date(m.deadline) > now) pv.milestoneChanges.push({ milestone: m, patch: { deadline: new Date(new Date(m.deadline).getTime() + delta).toISOString() } });
      if (p.deadline) pv.projectPatch = { deadline: new Date(new Date(p.deadline).getTime() + delta).toISOString() };
      replanPreviewModal(pv);
    }
  } catch (err) { console.error(err); toast(err.message || 'Une erreur est survenue.', 'error'); }
});

$('#modal')?.addEventListener('close', () => { if (parts()[0] === 'tache') history.replaceState(null, '', '#/taches'); });
$('#modal')?.addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* ---------------- Synchro, rappels, démarrage ---------------- */
async function runSync(manual = false) {
  if (!S.settings.ghToken) { if (manual) toast('Ajoutez un jeton GitHub.', 'error'); return; }
  try {
    S.syncing = true;
    const { gistId, icsUrl } = await syncNow(S.settings);
    await saveSettings({ gistId, icsUrl });
    S.syncing = false;
    await refresh();
    if (manual) toast('Synchronisation terminée.');
  } catch (e) { S.syncing = false; if (manual) toast(e.message, 'error'); else console.warn(e); }
}
const autoSync = debounce(() => { if (S.settings.autoSync && !S.syncing) runSync(false); }, 8000);
const scheduleSoon = debounce(async () => {
  try { await scheduleNtfy(S.settings, S.tasks); } catch (e) { console.warn(e); }
}, 3000);

async function refresh() {
  await load();
  render();
}

db.onChange(async () => {
  await load();
  render();
  scheduleSoon();
  if (!S.syncing) autoSync();
});

window.addEventListener('hashchange', () => { if ($('#modal').open && parts()[0] !== 'tache') $('#modal').close(); render(); view().focus({ preventScroll: true }); window.scrollTo(0, 0); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; });

async function tick() {
  await checkDue(S.tasks, msg => toast(msg));
  const focused = document.activeElement && view().contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (!focused && !$('#modal').open && !S.busy) render();
}

async function start() {
  if (window.top !== window.self && !window.PLANEO_PREVIEW) {
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Pour votre sécurité, Planéo ne s’affiche pas dans une autre page. <a href="' + location.href.replace(/"/g, '') + '" target="_top">Ouvrir Planéo</a></p>';
    return;
  }
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('SW', e); }
  }
  try { await navigator.storage?.persist?.(); } catch { /* facultatif */ }
  await load();
  render();
  await tick();
  setInterval(tick, 60000);
  scheduleSoon();
  setInterval(() => scheduleNtfy(S.settings, S.tasks).catch(() => {}), 15 * 60000);
  if (S.settings.autoSync && S.settings.ghToken) runSync(false);
  if ((await notificationsState()) === 'granted') registerPeriodic();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tick(); scheduleSoon(); } });
}

start();
