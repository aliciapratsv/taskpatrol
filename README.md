# Asana Bot Monitor 🤖

Bot serverless que corre en Vercel y alerta cuando:
- Alguien del equipo fue **mencionado (@)** y no respondió en X horas
- Una **tarea venció** y no tuvo actividad en X horas

Comenta en la tarea de Asana + manda email.

---

## Setup (15 minutos)

### 1. Subir a GitHub

1. Creá un repositorio nuevo en GitHub (puede ser privado)
2. Subí estos 3 archivos:
   ```
   asana-bot/
   ├── api/check.js
   ├── package.json
   └── vercel.json
   ```
3. Si nunca usaste Git desde el browser: en GitHub → tu repo → "uploading an existing file"

### 2. Conectar Vercel

1. Entrá a [vercel.com](https://vercel.com) → New Project
2. Importá el repo de GitHub
3. Framework Preset: **Other**
4. Deploy (va a fallar la primera vez, está bien — falta configurar variables)

### 3. Variables de entorno en Vercel

En tu proyecto de Vercel → Settings → Environment Variables, agregá:

| Variable | Valor | Dónde conseguirlo |
|---|---|---|
| `ASANA_TOKEN` | `1/xxx:yyy` | Asana → Perfil → My Profile Settings → Apps → Manage Developer Apps → New Access Token |
| `ASANA_PROJECT_GID` | `1234567890` | URL del proyecto en Asana: `app.asana.com/0/**GID**/...` |
| `ALERT_HOURS` | `24` | Horas antes de alertar (podés cambiarlo) |
| `GMAIL_USER` | `tubot@gmail.com` | Tu cuenta de Gmail |
| `GMAIL_PASS` | `xxxx xxxx xxxx xxxx` | **App Password** (ver abajo) |
| `NOTIFY_EMAIL` | `manager@empresa.com` | A quién mandar los emails |
| `CRON_SECRET` | cualquier string largo | Ej: `mi-secreto-super-seguro-2024` |

#### Cómo conseguir el App Password de Gmail

1. Activá verificación en 2 pasos en tu cuenta Google
2. Entrá a [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Nombre: "Asana Bot" → Crear
4. Copiá las 16 letras que aparecen (con espacios está bien)

### 4. Redeploy

En Vercel → Deployments → redeploy el último. Ahora sí va a funcionar.

---

## Cómo funciona

```
Cada hora (cron)
      │
      ▼
GET /api/check
      │
      ├── Para cada tarea del proyecto:
      │     ├── ¿Hay menciones (@) sin respuesta > ALERT_HOURS?  → alerta
      │     └── ¿Tarea vencida sin actividad > ALERT_HOURS?      → alerta
      │
      └── Por cada alerta:
            ├── POST comentario en la tarea de Asana
            └── Manda email a NOTIFY_EMAIL
```

## Probar manualmente

Podés llamar al endpoint desde el browser o curl:

```bash
curl -H "Authorization: Bearer mi-secreto-super-seguro-2024" \
  https://tu-proyecto.vercel.app/api/check
```

Responde con JSON mostrando cuántas alertas encontró.

## Alternativa de email: Resend (más simple)

Si Gmail da problemas, creá cuenta en [resend.com](https://resend.com) (gratis hasta 3000 emails/mes) y agregá:

| Variable | Valor |
|---|---|
| `RESEND_API_KEY` | `re_xxxxxxxxxxxx` |

El código lo detecta automáticamente y usa Resend en lugar de Gmail SMTP.
