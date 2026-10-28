// Questionnaires de suivi et enseignements tirés des réponses
const CAUSES = ['Temps sous-estimé', 'Imprévu', 'Motivation en baisse', 'Attente de quelqu’un', 'Tâche floue', 'Autre priorité'];

export const SURVEYS = {
  success: {
    title: 'Bravo, c’est fait à temps',
    intro: 'Trois questions rapides pour mieux planifier la suite.',
    questions: [
      { id: 'satisfaction', type: 'scale', label: 'Êtes-vous satisfait du résultat ?', low: 'Pas du tout', high: 'Totalement' },
      { id: 'estimate', type: 'choice', label: 'Le temps prévu était…', options: ['Trop large', 'Juste', 'Trop court'] },
      { id: 'energy', type: 'scale', label: 'Votre énergie pendant la tâche', low: 'Épuisé', high: 'En forme' },
      { id: 'helped', type: 'text', label: 'Qu’est-ce qui vous a aidé ?', optional: true },
    ],
  },
  late: {
    title: 'Terminé, avec du retard',
    intro: 'C’est fait, c’est l’essentiel. Comprenons le retard pour ajuster les prochaines dates.',
    questions: [
      { id: 'cause', type: 'choice', label: 'Principale cause du retard', options: CAUSES },
      { id: 'extra', type: 'choice', label: 'Combien de temps en plus ?', options: ['Moins d’une heure', 'Quelques heures', 'Un jour ou plus'] },
      { id: 'satisfaction', type: 'scale', label: 'Êtes-vous satisfait du résultat ?', low: 'Pas du tout', high: 'Totalement' },
      { id: 'prevent', type: 'text', label: 'Qu’est-ce qui aurait évité le retard ?', optional: true },
    ],
  },
  overdue: {
    title: 'Échéance dépassée',
    intro: 'Pas de jugement : faisons le point pour recalculer un plan réaliste.',
    questions: [
      { id: 'state', type: 'choice', label: 'Où en est la tâche ?', options: ['Pas commencée', 'En cours', 'Presque finie', 'Bloquée', 'Plus utile'] },
      { id: 'cause', type: 'choice', label: 'Ce qui a coincé', options: CAUSES },
      { id: 'need', type: 'choice', label: 'De quoi avez-vous besoin ?', options: ['Plus de temps', 'La découper', 'De l’aide ou une info', 'L’abandonner'] },
      { id: 'newDue', type: 'datetime', label: 'Nouvelle échéance réaliste', optional: true },
      { id: 'comment', type: 'text', label: 'Un détail à ajouter ?', optional: true },
    ],
  },
};

// Suivis en attente : tâches terminées sans retour, tâches en retard sans point
export function pendingSurveys(tasks, checkins) {
  const now = Date.now();
  const out = [];
  const answered = new Set(checkins.map(c => `${c.taskId}|${c.key}`));
  for (const t of tasks) {
    if (t.status === 'done' && t.completedAt) {
      if (now - new Date(t.completedAt) > 14 * 86400000) continue;
      const type = t.due && new Date(t.completedAt) > new Date(t.due) ? 'late' : 'success';
      if (!answered.has(`${t.id}|done:${t.completedAt}`)) out.push({ task: t, type, key: `done:${t.completedAt}` });
    } else if (t.status === 'todo' && t.due && new Date(t.due) < now) {
      if (!answered.has(`${t.id}|due:${t.due}`)) out.push({ task: t, type: 'overdue', key: `due:${t.due}` });
    }
  }
  return out.sort((a, b) => (a.type === 'overdue') - (b.type === 'overdue'));
}

export function surveyKeyFor(task) {
  return task.status === 'done' ? `done:${task.completedAt}` : `due:${task.due}`;
}

// Statistiques et texte d'habitudes transmis à l'IA
export function insights(tasks, checkins) {
  const real = checkins.filter(c => c.type !== 'skipped');
  const done = tasks.filter(t => t.status === 'done' && t.completedAt);
  const withDue = done.filter(t => t.due);
  const onTime = withDue.filter(t => new Date(t.completedAt) <= new Date(t.due)).length;
  const estimates = real.filter(c => c.answers?.estimate).map(c => c.answers.estimate);
  const short = estimates.filter(e => e === 'Trop court').length;
  const wide = estimates.filter(e => e === 'Trop large').length;
  const causes = {};
  real.forEach(c => { const k = c.answers?.cause; if (k) causes[k] = (causes[k] || 0) + 1; });
  const topCause = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  const sats = real.map(c => Number(c.answers?.satisfaction)).filter(Boolean);
  const avgSat = sats.length ? sats.reduce((a, b) => a + b, 0) / sats.length : null;
  const lateCount = real.filter(c => c.type === 'late' || c.type === 'overdue').length;

  const stats = {
    done: done.length,
    onTimeRate: withDue.length ? Math.round((onTime / withDue.length) * 100) : null,
    followUps: real.length,
    topCause: topCause ? topCause[0] : null,
    avgSatisfaction: avgSat ? Math.round(avgSat * 10) / 10 : null,
    underestimates: estimates.length ? Math.round((short / estimates.length) * 100) : null,
  };

  const lines = [];
  if (stats.onTimeRate !== null && withDue.length >= 3) lines.push(`${stats.onTimeRate} % des tâches terminées l'ont été à temps (${withDue.length} tâches).`);
  if (estimates.length >= 3) {
    if (short / estimates.length >= 0.4) lines.push(`Le temps prévu est souvent trop court (${stats.underestimates} % des cas) : prévoir environ 30 % de marge.`);
    else if (wide / estimates.length >= 0.5) lines.push('Les estimations sont souvent trop larges : les durées peuvent être resserrées.');
  }
  if (topCause && topCause[1] >= 2) lines.push(`Cause de retard la plus fréquente : ${topCause[0].toLowerCase()}.`);
  if (lateCount >= 3 && real.length) lines.push(`${lateCount} suivis sur ${real.length} concernent un retard.`);
  return { stats, text: lines.join(' ') };
}
