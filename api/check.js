import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const WORKSPACE_GID = process.env.ASANA_WORKSPACE_GID;
const CC_EMAIL = 'alicia@pow.la';

const TEAM = [
  { email: 'brenda@pow.la',        name: 'Brenda'  },
  { email: 'florencia@pow.la',     name: 'Florencia' },
  { email: 'martina.arias@pow.la', name: 'Martina' },
  { email: 'luciana@pow.la',       name: 'Luciana' },
];

async function asanaGet(path) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function sendEmail({ to, name, mentions, overdue }) {
  if (!process.env.GMAIL_USER) return;

  const mentionRows = mentions.map(a => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0ede8;">
        <a href="https://app.asana.com/0/${a.projectGid}/${a.taskGid}" style="color:#FF722D;text-decoration:none;font-weight:500;">${a.taskName}</a>
        <div style="font-size:12px;color:#888;margin-top:3px;">${a.projectName} · sin respuesta hace ${a.hoursAgo}hs</div>
      </td>
    </tr>`).join('');

  const overdueRows = overdue.map(a => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0ede8;">
        <a href="https://app.asana.com/0/${a.projectGid}/${a.taskGid}" style="color:#FF722D;text-decoration:none;font-weight:500;">${a.taskName}</a>
        <div style="font-size:12px;color:#888;margin-top:3px;">${a.projectName} · venció el ${a.dueOn} · ${a.daysOverdue}d de retraso</div>
      </td>
    </tr>`).join('');

  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fafaf8;">
    <div style="margin-bottom:24px;">
      <span style="background:#FF722D;color:#fff;padding:4px 10px;border-radius:3px;font-size:13px;font-weight:700;letter-spacing:0.04em;">POW</span>
      <span style="font-size:12px;color:#aaa;margin-left:10px;text-transform:uppercase;letter-spacing:0.08em;">Taskpatrol</span>
    </div>
    <h2 style="font-size:18px;font-weight:400;color:#1a1a1a;margin:0 0 6px;">Hola ${name} 👋</h2>
    <p style="font-size:14px;color:#666;margin:0 0 28px;">Este es tu recordatorio diario de Taskpatrol. Estas tareas necesitan tu atención.</p>

    ${mentions.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#aaa;margin-bottom:8px;">Menciones sin respuesta · +24hs</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #ede9e3;">
        ${mentionRows}
      </table>
    </div>` : ''}

    ${overdue.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#aaa;margin-bottom:8px;">Tareas vencidas sin update</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #ede9e3;">
        ${overdueRows}
      </table>
    </div>` : ''}

    <p style="font-size:12px;color:#bbb;margin-top:32px;padding-top:16px;border-top:1px solid #ede9e3;">
      Enviado automáticamente por Taskpatrol · POW · todos los días 7am
    </p>
  </div>`;

  const nodemailer = await import('nodemailer');
  const t = nodemailer.default.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  await t.sendMail({
    from: `Taskpatrol POW <${process.env.GMAIL_USER}>`,
    to: to,
    cc: CC_EMAIL,
    subject: `[Taskpatrol] Recordatorio de tareas pendientes · ${new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' })}`,
    html,
  });
}

async function getTeamGids() {
  const users = await asanaGet(`/workspaces/${WORKSPACE_GID}/users?opt_fields=gid,email,name`);
  const teamEmails = TEAM.map(t => t.email);
  return users.filter(u => teamEmails.includes(u.email));
}

async function checkForMember(member, projects, cutoff, now) {
  const mentions = [];
  const overdue = [];

  for (const project of projects) {
    const tasks = await asanaGet(
      `/projects/${project.gid}/tasks?opt_fields=gid,name,assignee.gid,due_on,modified_at,completed`
    );

    for (const task of tasks) {
      if (task.completed || !task.assignee) continue;
      if (task.assignee.gid !== member.gid) continue;

      // Menciones sin respuesta
      const stories = await asanaGet(
        `/tasks/${task.gid}/stories?opt_fields=type,text,created_at,created_by.gid`
      );
      const oldMentions = stories.filter(
        s => s.type === 'comment' && s.text?.includes('@') &&
             new Date(s.created_at).getTime() < cutoff
      );
      for (const mention of oldMentions) {
        const replied = stories.some(
          s => s.type === 'comment' &&
               s.created_by?.gid === member.gid &&
               new Date(s.created_at) > new Date(mention.created_at)
        );
        if (!replied) {
          const hoursAgo = Math.round((Date.now() - new Date(mention.created_at).getTime()) / 3600000);
          mentions.push({ taskName: task.name, taskGid: task.gid, projectName: project.name, projectGid: project.gid, hoursAgo });
        }
      }

      // Tareas vencidas sin update
      if (task.due_on) {
        const dueDate = new Date(task.due_on);
        if (dueDate < now && new Date(task.modified_at).getTime() < cutoff) {
          const daysOverdue = Math.round((now - dueDate) / 86400000);
          overdue.push({ taskName: task.name, taskGid: task.gid, projectName: project.name, projectGid: project.gid, dueOn: task.due_on, daysOverdue });
        }
      }
    }
  }
  return { mentions, overdue };
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    let config;
    try { config = await kv.get('bot_config') || { enabled: true, alertHours: 24 }; }
    catch { config = { enabled: true, alertHours: parseInt(process.env.ALERT_HOURS || '24') }; }
    if (!config.enabled) return res.status(200).json({ ok: true, skipped: true });

    const alertHours = config.alertHours || 24;
    const cutoff = Date.now() - alertHours * 3600 * 1000;
    const now = new Date();

    const teamMembers = await getTeamGids();
    console.log('[Debug] Team members encontrados:', teamMembers.length, teamMembers.map(m => m.email).join(', '));
const projects = await asanaGet(`/projects?workspace=${WORKSPACE_GID}&archived=false&opt_fields=gid,name`);
console.log('[Debug] Proyectos encontrados:', projects.length, projects.map(p => p.name).join(', '));
    const allAlerts = [];
    for (const member of teamMembers) {
      const teamInfo = TEAM.find(t => t.email === member.email);
      const { mentions, overdue } = await checkForMember(member, projects, cutoff, now);
      if (mentions.length === 0 && overdue.length === 0) continue;
      await sendEmail({ to: member.email, name: teamInfo?.name || member.name, mentions, overdue });
      allAlerts.push(...mentions.map(m => ({ ...m, type: 'mention', assignee: member.name, ts: new Date().toISOString() })));
      allAlerts.push(...overdue.map(o => ({ ...o, type: 'overdue', assignee: member.name, ts: new Date().toISOString() })));
    }

    if (allAlerts.length > 0) {
      try {
        for (const a of allAlerts) await kv.lpush('alerts_log', JSON.stringify(a));
        await kv.ltrim('alerts_log', 0, 99);
      } catch {}
    }
    try { await kv.set('last_run', { ts: new Date().toISOString(), alertCount: allAlerts.length }); } catch {}

    return res.status(200).json({ ok: true, checked: new Date().toISOString(), emailsSent: teamMembers.length, alertsSent: allAlerts.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
