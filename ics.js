// Génération de calendriers .ics (Google Agenda, Apple Calendrier, Outlook)
const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line) {
  // Repli à 73 caractères (approximation sûre des 75 octets de la norme)
  const out = [];
  let s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join('\r\n');
}

export function buildICS({ tasks, projects = [], name = 'Planéo' }) {
  const pById = new Map(projects.map(p => [p.id, p]));
  const now = stamp(Date.now());
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planéo//Planificateur//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(name)}`, 'X-PUBLISHED-TTL:PT6H', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  for (const t of tasks) {
    if (t.status !== 'todo' || !t.due) continue;
    const end = new Date(t.due);
    const start = new Date(end.getTime() - Math.max(15, t.estimateMin || 30) * 60000);
    const p = pById.get(t.projectId);
    const desc = [
      p ? `Projet : ${p.title}` : '',
      t.notes || '',
      (t.checklist || []).length ? 'Checklist :\n' + t.checklist.map(c => `${c.done ? '☑' : '☐'} ${c.text}`).join('\n') : '',
    ].filter(Boolean).join('\n\n');
    L.push('BEGIN:VEVENT', `UID:${t.id}@planeo`, `DTSTAMP:${now}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
      `SUMMARY:${escText((p ? `[${p.title}] ` : '') + t.title)}`, `DESCRIPTION:${escText(desc)}`);
    for (const off of new Set([...(t.reminders || []), 0])) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(t.title)}`,
        `TRIGGER;RELATED=END:-PT${off}M`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  for (const p of projects) {
    if (p.status === 'archived') continue;
    for (const m of p.milestones || []) {
      if (!m.deadline) continue;
      L.push('BEGIN:VEVENT', `UID:${m.id}@planeo`, `DTSTAMP:${now}`, `DTSTART:${stamp(m.deadline)}`,
        `DTEND:${stamp(new Date(new Date(m.deadline).getTime() + 30 * 60000))}`,
        `SUMMARY:${escText(`Étape : ${m.title} (${p.title})`)}`, `DESCRIPTION:${escText(m.expectations || '')}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(m.title)}`, 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
    }
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
