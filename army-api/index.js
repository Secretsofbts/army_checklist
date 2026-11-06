const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = String(process.env.ADMIN_TELEGRAM_IDS || '891936733')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
// Тестовые аккаунты «как будто не оплачено» (ваша 2-я страница). Убрать ID из списка, когда тест закончите.
const FORCE_EXPIRED_IDS = String(process.env.FORCE_EXPIRED_IDS || '2055929706')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_TRIAL_DAYS = 3;
const NEW_TRIAL_DAYS = 10;
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
app.use(express.json({ limit: '2mb' }));

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
  if (expiresAt > now) {
    return {
      ok: true,
      status: data.trial ? 'trial' : 'active',
      forever: false,
      expiresAt: expiresAt,
      trial: !!data.trial,
      priceRub: 200
    };
  }
  return {
    ok: false,
    status: 'expired',
    forever: false,
    expiresAt: expiresAt || null,
    trial: !!data.trial,
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

// Старым: сегодняшний день не считаем, 3 полных дня с завтра (до полуночи после 3-го дня).
function legacyTrialExpiresAt(now) {
  // завтра 00:00 МСК + 3 дня = конец 3-го бесплатного дня
  return moscowMidnightPlusDays(now, 1 + LEGACY_TRIAL_DAYS);
}

async function ensureSubscriptionRecord(uid) {
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  if (snap.exists() && snap.val()) {
    const existing = snap.val();
    // Если пробный период старым уже записали «со сегодня» — подвинем на «с завтра», если новый срок позже
    if (existing.trial && existing.trialDays === LEGACY_TRIAL_DAYS && !existing.forever &&
        existing.note !== 'force-expired-test') {
      const fixed = legacyTrialExpiresAt(Date.now());
      if (!existing.expiresAt || existing.expiresAt < fixed) {
        existing.expiresAt = fixed;
        existing.active = true;
        existing.updatedAt = Date.now();
        await ref.set(existing);
      }
    }
    return existing;
  }

  const registrySnap = await db.ref('user_registry/' + uid).get();
  const registry = registrySnap.exists() ? registrySnap.val() : null;
  const firstSeen = registry && registry.firstSeen ? Number(registry.firstSeen) : Date.now();
  const isLegacy = firstSeen < SUBSCRIPTION_LAUNCH_AT;
  const trialDays = isLegacy ? LEGACY_TRIAL_DAYS : NEW_TRIAL_DAYS;
  const now = Date.now();
  // Старым: сегодня бесплатно «в подарок», 3 дня считаем с завтра.
  // Новым: 10 дней от первой регистрации (не меньше «сейчас + 10»).
  let expiresAt;
  if (isLegacy) {
    expiresAt = legacyTrialExpiresAt(now);
  } else {
    expiresAt = firstSeen + trialDays * DAY_MS;
    if (expiresAt < now) expiresAt = now + trialDays * DAY_MS;
  }

  const entry = {
    active: true,
    trial: true,
    trialDays: trialDays,
    forever: false,
    expiresAt: expiresAt,
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
    // Принудительно показать экран «нужна подписка» (тест)
    if (FORCE_EXPIRED_IDS.indexOf(uid) !== -1) {
      const now = Date.now();
      await subscriptionRef(uid).set({
        active: false,
        trial: false,
        forever: false,
        expiresAt: now - DAY_MS,
        createdAt: now,
        updatedAt: now,
        note: 'force-expired-test'
      });
      return res.json(buildSubscriptionStatus(uid, {
        forever: false,
        trial: false,
        expiresAt: now - DAY_MS
      }, false));
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
      await ref.set(req.body);
      return res.json(req.body == null ? null : req.body);
    }
    if (method === 'PATCH') {
      await ref.update(req.body || {});
      const snap = await ref.get();
      return res.json(snap.exists() ? snap.val() : null);
    }
    if (method === 'POST') {
      const newRef = ref.push();
      await newRef.set(req.body);
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

app.listen(PORT, function () {
  console.log('army-api listening on ' + PORT);
});
