// Transformation des plans IA en données, et replanification
import { uid, parseLooseDate } from './util.js';

const PRIOS = ['haute', 'normale', 'basse'];
const arr = v => (Array.isArray(v) ? v : []);
const str = v => (typeof v === 'string' ? v.trim().slice(0, 5000) : '');

function normTask(t, fallbackDue) {
  const reminders = arr(t.reminders).map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 43200);
  return {
    title: str(t.title) || 'Tâche sans titre',
    notes: str(t.notes),
    due: parseLooseDate(t.due) || fallbackDue || null,
    estimateMin: Math.max(0, Math.round(Number(t.estimateMin) || 0)) || null,
    priority: PRIOS.includes(t.priority) ? t.priority : 'normale',
    checklist: arr(t.checklist).map(str).filter(Boolean).slice(0, 12),
    reminders: reminders.length ? [...new Set(reminders)] : [1440, 60],
  };
}

export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Plan invalide.');
  const milestones = arr(raw.milestones).map(m => {
    const deadline = parseLooseDate(m.deadline);
    return {
      title: str(m.title) || 'Étape',
      expectations: str(m.expectations),
      deadline,
      tasks: arr(m.tasks).map(t => normTask(t, deadline)),
    };
  });
  const tasks = arr(raw.tasks).map(t => normTask(t, parseLooseDate(raw.deadline)));
  const kind = raw.kind === 'task' || (!milestones.length && tasks.length) ? 'task' : 'project';
  if (!milestones.length && !tasks.length) throw new Error('Le plan ne contient aucune tâche.');
  return {
    kind,
    title: str(raw.title) || 'Nouveau projet',
    summary: str(raw.summary),
    objective: str(raw.objective),
    deadline: parseLooseDate(raw.deadline),
    successCriteria: arr(raw.successCriteria).map(str).filter(Boolean),
    risks: arr(raw.risks).map(str).filter(Boolean),
    milestones,
    tasks,
  };
}

export function makeTask(fields = {}) {
  return {
    id: uid(),
    projectId: null,
    milestoneId: null,
    title: '',
    notes: '',
    due: null,
    estimateMin: null,
    priority: 'normale',
    reminders: [1440, 60],
    status: 'todo',
    completedAt: null,
    ...fields,
    checklist: (fields.checklist || []).map(x => (typeof x === 'string' ? { id: uid(), text: x, done: false } : x)),
  };
}

// Plan normalisé -> { project | null, tasks[] }
export function materialize(plan, chat = []) {
  if (plan.kind === 'task' && !plan.milestones.length) {
    return { project: null, tasks: plan.tasks.map(t => makeTask(t)) };
  }
  const projectId = uid();
  const milestones = plan.milestones.map((m, i) => ({ id: uid(), title: m.title, expectations: m.expectations, deadline: m.deadline, order: i }));
  const tasks = [];
  plan.milestones.forEach((m, i) => m.tasks.forEach(t => tasks.push(makeTask({ ...t, projectId, milestoneId: milestones[i].id }))));
  plan.tasks.forEach(t => tasks.push(makeTask({ ...t, projectId })));
  const last = milestones.map(m => m.deadline).filter(Boolean).sort().pop();
  const project = {
    id: projectId,
    title: plan.title,
    summary: plan.summary,
    objective: plan.objective,
    deadline: plan.deadline || last || null,
    successCriteria: plan.successCriteria,
    risks: plan.risks,
    milestones,
    status: 'active',
    chat,
  };
  return { project, tasks };
}

// Vue compacte envoyée à l'IA
export function snapshot(project, tasks, checkins) {
  const ids = new Set(tasks.map(t => t.id));
  return {
    project: project ? {
      title: project.title, objective: project.objective, deadline: project.deadline,
      milestones: (project.milestones || []).map(m => ({ id: m.id, title: m.title, expectations: m.expectations, deadline: m.deadline })),
    } : null,
    tasks: tasks.map(t => ({
      id: t.id, milestoneId: t.milestoneId, title: t.title, status: t.status, due: t.due,
      completedAt: t.completedAt, estimateMin: t.estimateMin, priority: t.priority,
      checklist: (t.checklist || []).map(c => `${c.done ? '[x]' : '[ ]'} ${c.text}`),
      overdue: t.status !== 'done' && t.due && new Date(t.due) < new Date(),
    })),
    followUps: checkins.filter(c => ids.has(c.taskId)).slice(-15).map(c => ({ taskId: c.taskId, type: c.type, answers: c.answers, at: c.createdAt })),
  };
}

/* ---------- Replanification ----------
   Un "preview" décrit les changements proposés avant validation :
   { summary, advice, taskChanges:[{task, patch}], newTasks:[task], dropped:[task],
     milestoneChanges:[{milestone, patch}], projectPatch: {} | null, project } */

// Décalage local : repousse la tâche et tout ce qui suit dans le même projet
export function localShift({ task, newDue, project, tasks }) {
  const oldDue = task.due ? new Date(task.due) : new Date();
  const target = new Date(newDue);
  const delta = target - oldDue;
  const preview = { summary: '', advice: '', taskChanges: [], newTasks: [], dropped: [], milestoneChanges: [], projectPatch: null, project };
  preview.taskChanges.push({ task, patch: { due: target.toISOString() } });
  if (delta > 0 && project) {
    for (const t of tasks) {
      if (t.id === task.id || t.status === 'done' || t.projectId !== project.id || !t.due) continue;
      if (new Date(t.due) >= oldDue) preview.taskChanges.push({ task: t, patch: { due: new Date(new Date(t.due).getTime() + delta).toISOString() } });
    }
    for (const m of project.milestones || []) {
      if (m.deadline && new Date(m.deadline) >= oldDue) {
        preview.milestoneChanges.push({ milestone: m, patch: { deadline: new Date(new Date(m.deadline).getTime() + delta).toISOString() } });
      }
    }
    if (project.deadline && new Date(project.deadline) >= oldDue) {
      preview.projectPatch = { deadline: new Date(new Date(project.deadline).getTime() + delta).toISOString() };
    }
  }
  const days = Math.round(delta / 86400000);
  preview.summary = delta > 0
    ? `Décalage de ${days >= 1 ? `${days} jour${days > 1 ? 's' : ''}` : 'quelques heures'} appliqué à cette tâche et à la suite du projet.`
    : 'Nouvelle échéance pour cette tâche uniquement.';
  return preview;
}

export function previewFromAI(raw, project, tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const mById = new Map((project?.milestones || []).map(m => [m.id, m]));
  const preview = {
    summary: str(raw.summary), advice: str(raw.advice),
    taskChanges: [], newTasks: [], dropped: [], milestoneChanges: [], projectPatch: null, project,
  };
  for (const u of arr(raw.updatedTasks)) {
    const t = byId.get(u.id);
    if (!t || t.status === 'done') continue;
    const patch = {};
    if (str(u.title) && u.title !== t.title) patch.title = str(u.title);
    const d = parseLooseDate(u.due); if (d && d !== t.due) patch.due = d;
    if (typeof u.notes === 'string' && u.notes.trim() && u.notes !== t.notes) patch.notes = u.notes.trim();
    if (Number(u.estimateMin) > 0) patch.estimateMin = Math.round(Number(u.estimateMin));
    if (Array.isArray(u.checklist) && u.checklist.length) patch.checklist = u.checklist.map(str).filter(Boolean).map(text => ({ id: uid(), text, done: false }));
    if (Object.keys(patch).length) preview.taskChanges.push({ task: t, patch });
  }
  for (const n of arr(raw.newTasks)) {
    const nt = normTask(n);
    const milestoneId = mById.has(n.milestoneId) ? n.milestoneId : null;
    preview.newTasks.push(makeTask({ ...nt, projectId: project?.id || null, milestoneId }));
  }
  for (const id of arr(raw.droppedTaskIds)) { const t = byId.get(id); if (t && t.status !== 'done') preview.dropped.push(t); }
  for (const u of arr(raw.updatedMilestones)) {
    const m = mById.get(u.id); if (!m) continue;
    const patch = {};
    const d = parseLooseDate(u.deadline); if (d && d !== m.deadline) patch.deadline = d;
    if (str(u.expectations) && u.expectations !== m.expectations) patch.expectations = str(u.expectations);
    if (Object.keys(patch).length) preview.milestoneChanges.push({ milestone: m, patch });
  }
  const pd = parseLooseDate(raw.projectDeadline);
  if (project && pd && pd !== project.deadline) preview.projectPatch = { deadline: pd };
  return preview;
}

export const previewIsEmpty = p =>
  !p.taskChanges.length && !p.newTasks.length && !p.dropped.length && !p.milestoneChanges.length && !p.projectPatch;

// Applique un preview via les fonctions de stockage fournies
export async function applyPreview(p, { put, putMany }) {
  const changed = p.taskChanges.map(({ task, patch }) => ({ ...task, ...patch }));
  const dropped = p.dropped.map(t => ({ ...t, status: 'dropped' }));
  await putMany('tasks', [...changed, ...dropped, ...p.newTasks]);
  if (p.project && (p.milestoneChanges.length || p.projectPatch)) {
    const project = { ...p.project, ...(p.projectPatch || {}) };
    project.milestones = (project.milestones || []).map(m => {
      const c = p.milestoneChanges.find(x => x.milestone.id === m.id);
      return c ? { ...m, ...c.patch } : m;
    });
    project.replans = [...(project.replans || []), { at: new Date().toISOString(), summary: p.summary }];
    await put('projects', project);
  }
}
