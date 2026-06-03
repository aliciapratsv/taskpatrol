// api/check.js — Vercel Cron Function
// Corre cada hora. Revisa menciones sin respuesta y tareas vencidas sin update.
// Monitorea TODOS los proyectos del workspace automáticamente.

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const WORKSPACE_GID = process.env.ASANA_WORKSPACE_GID; // workspace, no proyecto
const ALERT_HOURS = parseInt(process.env.ALERT_HOURS || "24");
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

// ─── Asana helpers ────────────────────────────────────────────────────────────

async function asanaGet(path) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function asanaComment(taskGid, text) {
  await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}/stories`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ASANA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { text } }),
  });
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(subject, htmlBody) {
  // Opción A: Resend (recomendado)
  if (process.env.RESEND_API_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: GMAIL_USER,
        to: [NOTIFY_EMAIL],
        subject,
        html: htmlBody,
      }),
    });
    return;
  }
  // Opción B: Gmail SMTP
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: GMAIL_USER,
    to: NOTIFY_EMAIL,
    subject,
    html: htmlBody,
  });
}

function emailTemplate({ title, taskName, assignee, projectName, detail, taskGid, projectGid }) {
  const taskUrl = `https://app.asana.com/0/${projectGid}/${taskGid}`;
  return `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
      <strong style="color:#92400e;">${title}</strong>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;color:#6b7280;width:120px;">Proyecto</td><td style="padding:8px 0;">${projectName}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Tarea</td><td style="padding:8px 0;font-weight:500;">${taskName}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Responsable</td><td style="padding:8px 0;">${assignee}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Detalle</td><td style="padding:8px 0;">${detail}</td></tr>
    </table>
    <a href="${taskUrl}" style="display:inline-block;margin-top:20px;background:#4f46e5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px;">
      Ver tarea en Asana →
    </a>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px;">Enviado por Taskpatrol 🤖</p>
  </div>`;
}

// ─── Obtener todos los proyectos del workspace ────────────────────────────────

async function getAllProjects() {
  // Trae todos los proyectos activos del workspace donde el token tiene acceso
  return await asanaGet(
    `/projects?workspace=${WORKSPACE_GID}&archived=false&opt_fields=gid,name`
  );
}

// ─── Lógica de alertas ────────────────────────────────────────────────────────

async function checkProject(project) {
  const alerts = [];
  const cutoff = Date.now() - ALERT_HOURS * 3600 * 1000;
  const now = new Date();

  const tasks = await asanaGet(
    `/projects/${project.gid}/tasks?opt_fields=gid,name,assignee.name,assignee.gid,due_on,modified_at,completed`
  );

  for (const task of tasks) {
    if (task.completed || !task.assignee) continue;

    const stories = await asanaGet(
      `/tasks/${task.gid}/stories?opt_fields=type,text,created_at,created_by.gid`
    );

    // — Alerta 1: mención sin respuesta —
    const oldMentions = stories.filter(
      (s) =>
        s.type === "comment" &&
        s.text?.includes("@") &&
        new Date(s.created_at).getTime() < cutoff
    );

    for (const mention of oldMentions) {
      const replied = stories.some(
        (s) =>
          s.type === "comment" &&
          s.created_by?.gid === task.assignee.gid &&
          new Date(s.created_at) > new Date(mention.created_at)
      );
      if (!replied) {
        const hoursAgo = Math.round(
          (Date.now() - new Date(mention.created_at).getTime()) / 3600000
        );
        await asanaComment(
          task.gid,
          `⚠️ Recordatorio: @${task.assignee.name}, tenés una mención sin responder hace ${hoursAgo}hs. Por favor actualizá el estado.`
        );
        alerts.push({
          type: "mention",
          title: `⚠️ Mención sin respuesta`,
          taskName: task.name,
          taskGid: task.gid,
          projectName: project.name,
          projectGid: project.gid,
          assignee: task.assignee.name,
          detail: `Mención sin respuesta hace ${hoursAgo} horas`,
        });
      }
    }

    // — Alerta 2: tarea vencida sin update —
    if (task.due_on) {
      const dueDate = new Date(task.due_on);
      const lastActivity = new Date(task.modified_at).getTime();
      if (dueDate < now && lastActivity < cutoff) {
        const daysOverdue = Math.round((now - dueDate) / 86400000);
        await asanaComment(
          task.gid,
          `🔴 Esta tarea venció hace ${daysOverdue} día${daysOverdue > 1 ? "s" : ""} y no tuvo actividad en ${ALERT_HOURS}hs. @${task.assignee.name}: ¿cuál es el estado?`
        );
        alerts.push({
          type: "overdue",
          title: `🔴 Tarea vencida sin update`,
          taskName: task.name,
          taskGid: task.gid,
          projectName: project.name,
          projectGid: project.gid,
          assignee: task.assignee.name,
          detail: `Vencida el ${task.due_on} — ${daysOverdue} día${daysOverdue > 1 ? "s" : ""} de retraso`,
        });
      }
    }
  }

  return alerts;
}

// ─── Handler de Vercel ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.log("[Taskpatrol] Iniciando revisión:", new Date().toISOString());

    const projects = await getAllProjects();
    console.log(`[Taskpatrol] Proyectos encontrados: ${projects.length}`);

    const allAlerts = [];
    for (const project of projects) {
      console.log(`[Taskpatrol] Revisando: ${project.name}`);
      const alerts = await checkProject(project);
      allAlerts.push(...alerts);
    }

    console.log(`[Taskpatrol] Alertas totales: ${allAlerts.length}`);

    for (const alert of allAlerts) {
      await sendEmail(
        `[Taskpatrol] ${alert.title}: ${alert.taskName} — ${alert.projectName}`,
        emailTemplate(alert)
      );
    }

    return res.status(200).json({
      ok: true,
      checked: new Date().toISOString(),
      projectsScanned: projects.length,
      alertsSent: allAlerts.length,
      alerts: allAlerts,
    });
  } catch (err) {
    console.error("[Taskpatrol] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
