// api/check.js — Vercel Cron Function
// Corre cada hora. Revisa menciones sin respuesta y tareas vencidas sin update.

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const PROJECT_GID = process.env.ASANA_PROJECT_GID;
const ALERT_HOURS = parseInt(process.env.ALERT_HOURS || "24");
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS; // App Password de Google
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

// ─── Asana helpers ───────────────────────────────────────────────────────────

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

// ─── Gmail helper (via Gmail REST API con OAuth2 no es trivial,
//     usamos el relay SMTP de Google con nodemailer-like fetch) ─────────────
// Vercel Edge/Serverless soporta fetch pero no net/tls directamente.
// Usamos la API de Gmail por HTTP con Basic Auth (App Password).

async function sendEmail(subject, htmlBody) {
  // Armamos el mensaje MIME en base64
  const boundary = "boundary_asana_bot";
  const mime = [
    `From: ${GMAIL_USER}`,
    `To: ${NOTIFY_EMAIL}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    htmlBody,
    `--${boundary}--`,
  ].join("\r\n");

  const encoded = Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Autenticación básica con App Password (Gmail API)
  const credentials = Buffer.from(`${GMAIL_USER}:${GMAIL_PASS}`).toString("base64");

  // Nota: Gmail API requiere OAuth2 para producción.
  // Para simplicidad usamos nodemailer via dynamic import.
  // Vercel incluye el runtime de Node, así que podemos usar el módulo smtp2go
  // o simplemente importar nodemailer desde npm en el serverless env.
  // Ver README para alterntiva con Resend (más simple, 1 línea).

  // Opción A: Resend (recomendado, gratis hasta 3000 emails/mes)
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

  // Opción B: Gmail SMTP via nodemailer (funciona en Vercel serverless)
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

function emailTemplate({ title, taskName, assignee, detail, taskUrl }) {
  return `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
      <strong style="color:#92400e;">${title}</strong>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;color:#6b7280;width:120px;">Tarea</td><td style="padding:8px 0;font-weight:500;">${taskName}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Responsable</td><td style="padding:8px 0;">${assignee}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;">Detalle</td><td style="padding:8px 0;">${detail}</td></tr>
    </table>
    <a href="${taskUrl}" style="display:inline-block;margin-top:20px;background:#4f46e5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px;">
      Ver tarea en Asana →
    </a>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px;">Enviado por Asana Bot Monitor</p>
  </div>`;
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function checkMentionsWithoutReply() {
  const alerts = [];
  const tasks = await asanaGet(
    `/projects/${PROJECT_GID}/tasks?opt_fields=gid,name,assignee.name,assignee.gid`
  );

  for (const task of tasks) {
    if (!task.assignee) continue;

    const stories = await asanaGet(
      `/tasks/${task.gid}/stories?opt_fields=type,text,created_at,created_by.gid`
    );

    const cutoff = Date.now() - ALERT_HOURS * 3600 * 1000;

    // Menciones: comentarios con @ que tengan más de ALERT_HOURS horas
    const oldMentions = stories.filter(
      (s) =>
        s.type === "comment" &&
        s.text?.includes("@") &&
        new Date(s.created_at).getTime() < cutoff
    );

    for (const mention of oldMentions) {
      // ¿El asignado respondió después de la mención?
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
        const commentText = `⚠️ Recordatorio automático: @${task.assignee.name}, tenés una mención sin responder hace ${hoursAgo}hs en esta tarea. Por favor actualizá el estado.`;
        await asanaComment(task.gid, commentText);

        alerts.push({
          type: "mention",
          taskName: task.name,
          assignee: task.assignee.name,
          detail: `Mención sin respuesta hace ${hoursAgo} horas`,
          taskUrl: `https://app.asana.com/0/${PROJECT_GID}/${task.gid}`,
        });
      }
    }
  }
  return alerts;
}

async function checkOverdueTasks() {
  const alerts = [];
  const now = new Date();
  const cutoff = Date.now() - ALERT_HOURS * 3600 * 1000;

  const tasks = await asanaGet(
    `/projects/${PROJECT_GID}/tasks?opt_fields=gid,name,assignee.name,due_on,modified_at,completed`
  );

  for (const task of tasks) {
    if (task.completed || !task.due_on || !task.assignee) continue;

    const dueDate = new Date(task.due_on);
    if (dueDate >= now) continue; // no vencida todavía

    const lastActivity = new Date(task.modified_at).getTime();
    if (lastActivity > cutoff) continue; // tuvo actividad reciente

    const daysOverdue = Math.round((now - dueDate) / 86400000);
    const commentText = `🔴 Esta tarea venció hace ${daysOverdue} día${daysOverdue > 1 ? "s" : ""} y no tuvo actividad en las últimas ${ALERT_HOURS}hs.\n@${task.assignee.name}: ¿cuál es el estado? Por favor actualizá la tarea.`;
    await asanaComment(task.gid, commentText);

    alerts.push({
      type: "overdue",
      taskName: task.name,
      assignee: task.assignee.name,
      detail: `Vencida el ${task.due_on} — ${daysOverdue} día${daysOverdue > 1 ? "s" : ""} de retraso`,
      taskUrl: `https://app.asana.com/0/${PROJECT_GID}/${task.gid}`,
    });
  }
  return alerts;
}

// ─── Handler de Vercel ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Seguridad: solo Vercel Cron puede llamar esto
  if (req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.log("[Bot] Iniciando revisión:", new Date().toISOString());

    const [mentionAlerts, overdueAlerts] = await Promise.all([
      checkMentionsWithoutReply(),
      checkOverdueTasks(),
    ]);

    const allAlerts = [...mentionAlerts, ...overdueAlerts];
    console.log(`[Bot] Alertas encontradas: ${allAlerts.length}`);

    // Enviamos un email por alerta
    for (const alert of allAlerts) {
      const titles = {
        mention: `⚠️ Mención sin respuesta: ${alert.taskName}`,
        overdue: `🔴 Tarea vencida sin update: ${alert.taskName}`,
      };
      await sendEmail(
        titles[alert.type],
        emailTemplate(alert)
      );
    }

    return res.status(200).json({
      ok: true,
      checked: new Date().toISOString(),
      alertsSent: allAlerts.length,
      alerts: allAlerts,
    });
  } catch (err) {
    console.error("[Bot] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
