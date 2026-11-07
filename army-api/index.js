const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = String(process.env.ADMIN_TELEGRAM_IDS || '891936733')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
// Бессрочный доступ без прав админа (подруги и исключения).
const FOREVER_IDS = String(process.env.FOREVER_TELEGRAM_IDS || '163381553,591051945')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
// Тестовый аккаунт (2-я страница): режим превью.
// days3 = обычный человек, осталось 3 дня; new10 = новый с 10 днями; paid1 = последний день.
const FORCE_TEST_MODE = String(process.env.FORCE_TEST_MODE || 'paid1').trim();
const FORCE_TEST_IDS = String(process.env.FORCE_TEST_IDS || '2055929706')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const DAY_MS = 24 * 60 * 60 * 1000;
// Старым: 5 дней с завтра (из‑за задержки с кассой). Новым по-прежнему 10 дней.
const LEGACY_TRIAL_DAYS = 5;
const NEW_TRIAL_DAYS = 10;
const TRIAL_PLAN_TAG = 'legacy5-new10';
// Момент «запуска оплаты» (фиксированная дата, иначе при рестарте Render всё сбросится).
// Можно переопределить в Render: SUBSCRIPTION_LAUNCH_AT = миллисекунды Unix.
const SUBSCRIPTION_LAUNCH_AT = Number(process.env.SUBSCRIPTION_LAUNCH_AT) ||
  Date.parse('2026-11-06T21:00:00+03:00');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Нужна переменная FIREBASE_SERVICE_ACCOUNT (JSON ключа сервисного аккаунта)');
  process.exit(1);
}
if (!BOT_TOKEN) {
  console.error('Нужна переменная BOT_TOKEN от @BotFather');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_URL || 'https://army-checklist-default-rtdb.firebaseio.com'
});
const db = admin.database();

const app = express();
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({
  limit: '2mb',
  verify: function (req, res, buf) {
    req.rawBody = buf ? buf.toString('utf8') : '';
  }
}));

function unwrapCloudBody(req) {
  var val = req.body;
  // Голый JSON false/true иногда приходит как пустой body — берём raw
  if ((val === undefined || (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0)) && req.rawBody) {
    try {
      val = JSON.parse(req.rawBody);
    } catch (e) {}
  }
  // Клиент оборачивает примитивы: { "__army": false }
  if (val && typeof val === 'object' && !Array.isArray(val) &&
      Object.prototype.hasOwnProperty.call(val, '__army') &&
      Object.keys(val).length === 1) {
    val = val.__army;
  }
  return val;
}

function verifyTelegramInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  params.forEach(function (value, key) {
    pairs.push(key + '=' + value);
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const check = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (check !== hash) return null;
  const authDate = parseInt(params.get('auth_date'), 10) || 0;
  if (Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch (e) {
    return null;
  }
}

function authUser(req) {
  const raw = req.get('X-Telegram-Init-Data') || '';
  const user = verifyTelegramInitData(raw);
  if (!user) return null;
  user.isAdmin = ADMIN_IDS.indexOf(String(user.id)) !== -1;
  return user;
}

function pathAllowed(user, method, path) {
  const parts = String(path || '').split('/').filter(Boolean);
  if (!parts.length) return false;
  const uid = String(user.id);
  if (parts[0] === 'users' && parts[1] === uid) return true;
  if (parts[0] === 'user_registry' && parts[1] === uid) {
    return method === 'GET' || method === 'PUT' || method === 'PATCH';
  }
  if (parts[0] === 'user_registry' && parts.length === 1 && method === 'GET') return true;
  if (parts[0] === 'user_count' && parts.length === 1 && method === 'GET') return true;
  if (parts[0] === 'qa' || parts[0] === 'suggestions') {
    if (method === 'GET' || method === 'POST') return true;
    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') return !!user.isAdmin;
    return false;
  }
  return false;
}

app.get('/health', function (req, res) {
  res.json({ ok: true });
});

function subscriptionRef(uid) {
  return db.ref('subscriptions/' + uid);
}

function buildSubscriptionStatus(uid, data, isAdmin) {
  const now = Date.now();
  if (isAdmin) {
    return {
      ok: true,
      status: 'admin',
      forever: true,
      expiresAt: null,
      trial: false,
      priceRub: 200
    };
  }
  data = data || {};
  if (data.forever) {
    return {
      ok: true,
      status: 'forever',
      forever: true,
      expiresAt: null,
      trial: false,
      priceRub: 200
    };
  }
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0;
  const trialDays = typeof data.trialDays === 'number' ? data.trialDays : null;
  if (expiresAt > now) {
    return {
      ok: true,
      status: data.trial ? 'trial' : 'active',
      forever: false,
      expiresAt: expiresAt,
      trial: !!data.trial,
      trialDays: trialDays,
      priceRub: 200
    };
  }
  return {
    ok: false,
    status: 'expired',
    forever: false,
    expiresAt: expiresAt || null,
    trial: !!data.trial,
    trialDays: trialDays,
    priceRub: 200
  };
}

// Полуночь по Москве (UTC+3) для календарного дня ms, плюс N суток.
function moscowMidnightPlusDays(ms, days) {
  const MOSCOW = 3 * 60 * 60 * 1000;
  const local = ms + MOSCOW;
  const startOfDay = Math.floor(local / DAY_MS) * DAY_MS - MOSCOW;
  return startOfDay + days * DAY_MS;
}

// Старым: сегодняшний день не считаем, 5 полных дней с завтра.
function legacyTrialExpiresAt(now) {
  return moscowMidnightPlusDays(now, 1 + LEGACY_TRIAL_DAYS);
}

function isLegacyUser(firstSeen) {
  return firstSeen < SUBSCRIPTION_LAUNCH_AT;
}

function computeTrialExpiresAt(firstSeen, now) {
  if (isLegacyUser(firstSeen)) return legacyTrialExpiresAt(now);
  let expiresAt = firstSeen + NEW_TRIAL_DAYS * DAY_MS;
  if (expiresAt < now) expiresAt = now + NEW_TRIAL_DAYS * DAY_MS;
  return expiresAt;
}

function trialDaysFor(firstSeen) {
  return isLegacyUser(firstSeen) ? LEGACY_TRIAL_DAYS : NEW_TRIAL_DAYS;
}

async function ensureSubscriptionRecord(uid) {
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const registrySnap = await db.ref('user_registry/' + uid).get();
  const registry = registrySnap.exists() ? registrySnap.val() : null;
  const firstSeen = registry && registry.firstSeen ? Number(registry.firstSeen) : Date.now();
  const now = Date.now();
  const days = trialDaysFor(firstSeen);

  if (snap.exists() && snap.val()) {
    const existing = snap.val();
    if (existing.forever || existing.note === 'force-expired-test' ||
        existing.note === 'force-one-day-test' || existing.note === 'force-paid-one-day-test' ||
        existing.note === 'force-new10-preview' || existing.note === 'force-days3-preview') return existing;
    // Уже оплативших с trial:false не трогаем. Пробным один раз выставляем актуальный срок.
    if (existing.trial && existing.trialPlan !== TRIAL_PLAN_TAG) {
      existing.expiresAt = computeTrialExpiresAt(firstSeen, now);
      existing.trialDays = days;
      existing.trialPlan = TRIAL_PLAN_TAG;
      existing.active = true;
      existing.updatedAt = now;
      delete existing.bonusTag;
      delete existing.bonusTags;
      await ref.set(existing);
    }
    return existing;
  }

  const entry = {
    active: true,
    trial: true,
    trialDays: days,
    trialPlan: TRIAL_PLAN_TAG,
    forever: false,
    expiresAt: computeTrialExpiresAt(firstSeen, now),
    createdAt: now,
    updatedAt: now
  };
  await ref.set(entry);
  return entry;
}

app.get('/subscription', async function (req, res) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  const uid = String(user.id);
  try {
    if (user.isAdmin) {
      const existing = await subscriptionRef(uid).get();
      if (!existing.exists() || !existing.val() || !existing.val().forever) {
        await subscriptionRef(uid).set({
          active: true,
          trial: false,
          forever: true,
          expiresAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          note: 'admin'
        });
      }
      return res.json(buildSubscriptionStatus(uid, { forever: true }, true));
    }
    if (FOREVER_IDS.indexOf(uid) !== -1) {
      const existing = await subscriptionRef(uid).get();
      if (!existing.exists() || !existing.val() || !existing.val().forever) {
        await subscriptionRef(uid).set({
          active: true,
          trial: false,
          forever: true,
          expiresAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          note: 'forever-friend'
        });
      }
      return res.json(buildSubscriptionStatus(uid, { forever: true }, false));
    }
    // Тестовый аккаунт: превью режимов (days3 / new10 / paid1)
    if (FORCE_TEST_IDS.indexOf(uid) !== -1) {
      const ref = subscriptionRef(uid);
      const snap = await ref.get();
      const prev = snap.exists() ? snap.val() : null;
      const now = Date.now();
      const mode = FORCE_TEST_MODE || 'days3';

      if (mode === 'days3') {
        const note = 'force-days3-preview';
        // Всегда обновляем срок при смене режима, чтобы окошко «3 дня» могло показаться один раз
        if (prev && prev.note === note && typeof prev.expiresAt === 'number') {
          const left = Math.ceil((prev.expiresAt - now) / DAY_MS);
          if (left === 3) {
            return res.json(buildSubscriptionStatus(uid, prev, false));
          }
        }
        const entry = {
          active: true,
          trial: false,
          forever: false,
          expiresAt: now + 3 * DAY_MS,
          createdAt: (prev && prev.createdAt) || now,
          updatedAt: now,
          note: note
        };
        await ref.set(entry);
        return res.json(buildSubscriptionStatus(uid, entry, false));
      }

      if (mode === 'new10') {
        const note = 'force-new10-preview';
        if (prev && prev.note === note && prev.trial && typeof prev.expiresAt === 'number' && prev.expiresAt > now) {
          return res.json(buildSubscriptionStatus(uid, prev, false));
        }
        const entry = {
          active: true,
          trial: true,
          trialDays: NEW_TRIAL_DAYS,
          forever: false,
          expiresAt: now + NEW_TRIAL_DAYS * DAY_MS,
          createdAt: (prev && prev.createdAt) || now,
          updatedAt: now,
          note: note
        };
        await ref.set(entry);
        return res.json(buildSubscriptionStatus(uid, entry, false));
      }

      // paid1 — последний день
      const notePaid = 'force-paid-one-day-test';
      if (prev && prev.note === notePaid && typeof prev.expiresAt === 'number') {
        const left = Math.ceil((prev.expiresAt - now) / DAY_MS);
        if (left === 1) {
          return res.json(buildSubscriptionStatus(uid, prev, false));
        }
      }
      const paidEntry = {
        active: true,
        trial: false,
        forever: false,
        expiresAt: now + DAY_MS,
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        note: notePaid
      };
      await ref.set(paidEntry);
      return res.json(buildSubscriptionStatus(uid, paidEntry, false));
    }
    const data = await ensureSubscriptionRecord(uid);
    return res.json(buildSubscriptionStatus(uid, data, false));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'subscription' });
  }
});

// Выдать доступ вручную (только админ). body: { userId, days?, forever? }
app.post('/admin/grant', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const targetId = String((req.body && req.body.userId) || '').trim();
  if (!targetId) return res.status(400).json({ error: 'userId' });
  const forever = !!(req.body && req.body.forever);
  const days = Math.max(0, parseInt(req.body && req.body.days, 10) || 0);
  try {
    const ref = subscriptionRef(targetId);
    const snap = await ref.get();
    const prev = snap.exists() ? snap.val() : {};
    const now = Date.now();
    let entry;
    if (forever) {
      entry = {
        active: true,
        trial: false,
        forever: true,
        expiresAt: null,
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        grantedBy: String(user.id)
      };
    } else {
      const base = Math.max(now, (prev && prev.expiresAt) || 0);
      const expiresAt = base + (days || 30) * DAY_MS;
      entry = {
        active: true,
        trial: false,
        forever: false,
        expiresAt: expiresAt,
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        grantedBy: String(user.id)
      };
    }
    await ref.set(entry);
    return res.json(buildSubscriptionStatus(targetId, entry, false));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'grant' });
  }
});

app.post('/register', async function (req, res) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  const uid = String(user.id);
  try {
    const ownRef = db.ref('user_registry/' + uid);
    const snap = await ownRef.get();
    if (snap.exists() && snap.val() && snap.val().number) {
      return res.json(snap.val());
    }
    const countRef = db.ref('user_count');
    const result = await countRef.transaction(function (current) {
      return (current || 0) + 1;
    });
    const newNumber = result.snapshot.val();
    const firstSeen = Date.now();
    const entry = { number: newNumber, firstSeen: firstSeen };
    await ownRef.set(entry);
    return res.json(entry);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'register' });
  }
});

app.use('/cloud', async function (req, res) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  const path = String(req.path || '').replace(/^\//, '');
  const method = req.method;
  if (!pathAllowed(user, method, path)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const ref = db.ref(path);
    if (method === 'GET') {
      const snap = await ref.get();
      return res.json(snap.exists() ? snap.val() : null);
    }
    if (method === 'PUT') {
      const val = unwrapCloudBody(req);
      await ref.set(val === undefined ? null : val);
      return res.json(val === undefined ? null : val);
    }
    if (method === 'PATCH') {
      const val = unwrapCloudBody(req);
      await ref.update(val && typeof val === 'object' ? val : {});
      const snap = await ref.get();
      return res.json(snap.exists() ? snap.val() : null);
    }
    if (method === 'POST') {
      const val = unwrapCloudBody(req);
      const newRef = ref.push();
      await newRef.set(val === undefined ? null : val);
      return res.json({ name: newRef.key });
    }
    if (method === 'DELETE') {
      await ref.remove();
      return res.json(null);
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'cloud' });
  }
});

const CABINET_LINK = 'https://t.me/army_checklist_bot?startapp=cabinet';
const ONEDAY_REMIND_TEXT =
  'Сегодня последний день вашей подписки на чек-лист по архиву BTS.\n\n' +
  'Для продолжения использования можно оплатить её в <a href="' + CABINET_LINK + '">личном кабинете</a>.\n\n' +
  'Спасибо, что пользуетесь ботом 💜';

function moscowParts(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d);
  const map = {};
  parts.forEach(function (p) {
    if (p.type !== 'literal') map[p.type] = p.value;
  });
  return {
    dateKey: map.year + '-' + map.month + '-' + map.day,
    hour: parseInt(map.hour, 10) || 0,
    minute: parseInt(map.minute, 10) || 0
  };
}

function isLastInclusiveDayMoscow(expiresAt, now) {
  now = now || Date.now();
  if (typeof expiresAt !== 'number' || expiresAt <= now) return false;
  // Последний день доступа = календарный день expiresAt-1 мс по Москве
  const untilKey = moscowParts(expiresAt - 1).dateKey;
  const todayKey = moscowParts(now).dateKey;
  return untilKey === todayKey;
}

async function telegramSendMessage(chatId, text) {
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Личный кабинет', url: CABINET_LINK }
        ]]
      }
    })
  });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    const desc = data && data.description ? data.description : ('HTTP ' + res.status);
    throw new Error('telegram: ' + desc);
  }
  return data;
}

async function sendOneDayReminderToUser(uid, options) {
  options = options || {};
  const force = !!options.force;
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const data = snap.exists() ? snap.val() : null;
  if (!force) {
    if (!data || data.forever) return { sent: false, reason: 'no-sub' };
    if (!isLastInclusiveDayMoscow(data.expiresAt)) return { sent: false, reason: 'not-last-day' };
    if (data.oneDayRemindFor === data.expiresAt) return { sent: false, reason: 'already' };
  }
  try {
    await telegramSendMessage(uid, ONEDAY_REMIND_TEXT);
  } catch (e) {
    return { sent: false, reason: 'telegram', error: String(e.message || e) };
  }
  if (data && typeof data === 'object') {
    data.oneDayRemindFor = data.expiresAt || Date.now();
    data.oneDayRemindAt = Date.now();
    data.updatedAt = Date.now();
    await ref.set(data);
  } else if (force) {
    await db.ref('bot_meta/oneDayRemindLog/' + uid).push({
      at: Date.now(),
      force: true
    });
  }
  return { sent: true };
}

async function runOneDayReminders() {
  const snap = await db.ref('subscriptions').get();
  if (!snap.exists()) return { checked: 0, sent: 0 };
  const all = snap.val() || {};
  const ids = Object.keys(all);
  let sent = 0;
  const errors = [];
  for (let i = 0; i < ids.length; i++) {
    const uid = ids[i];
    try {
      const result = await sendOneDayReminderToUser(uid, { force: false });
      if (result.sent) sent++;
    } catch (e) {
      errors.push({ uid: uid, error: String(e.message || e) });
    }
  }
  return { checked: ids.length, sent: sent, errors: errors };
}

// Админ: принудительно отправить напоминание (для теста)
app.post('/admin/send-oneday-reminder', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const targetId = String((req.body && req.body.userId) || '').trim();
  if (!targetId) return res.status(400).json({ error: 'userId' });
  try {
    const result = await sendOneDayReminderToUser(targetId, { force: true });
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'remind' });
  }
});

// Cron/ручной запуск: секрет в Render → CRON_SECRET
app.get('/cron/oneday-reminders', async function (req, res) {
  const secret = String(process.env.CRON_SECRET || '');
  if (!secret || req.query.secret !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    if (req.query.testUser) {
      const result = await sendOneDayReminderToUser(String(req.query.testUser), { force: true });
      return res.json({ mode: 'test', result: result });
    }
    const result = await runOneDayReminders();
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'cron' });
  }
});

var lastOneDayCronDateKey = '';
function scheduleOneDayReminders() {
  setInterval(async function () {
    try {
      const parts = moscowParts(Date.now());
      // 12:00 по Москве, один раз в этот день
      if (parts.hour === 12 && parts.minute === 0 && lastOneDayCronDateKey !== parts.dateKey) {
        lastOneDayCronDateKey = parts.dateKey;
        console.log('Running one-day subscription reminders for', parts.dateKey);
        const result = await runOneDayReminders();
        console.log('One-day reminders result', result);
      }
    } catch (e) {
      console.error('one-day cron error', e);
    }
  }, 30000);
}

app.listen(PORT, function () {
  console.log('army-api listening on ' + PORT);
  scheduleOneDayReminders();
  // Один раз после деплоя: тестовое сообщение на 2-ю страницу (не чаще раза в сутки)
  setTimeout(async function () {
    try {
      const dayKey = moscowParts(Date.now()).dateKey;
      const metaRef = db.ref('bot_meta/testOneDayRemindV2');
      const metaSnap = await metaRef.get();
      if (metaSnap.exists() && metaSnap.val() === dayKey) {
        console.log('Test one-day remind already sent today');
        return;
      }
      const testId = FORCE_TEST_IDS[0] || '2055929706';
      const result = await sendOneDayReminderToUser(testId, { force: true });
      console.log('Test one-day remind to', testId, result);
      if (result.sent) await metaRef.set(dayKey);
    } catch (e) {
      console.error('Test one-day remind failed', e);
    }
  }, 4000);
});
