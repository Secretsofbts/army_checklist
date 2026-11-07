const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = String(process.env.ADMIN_TELEGRAM_IDS || '891936733')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
// Бессрочный доступ без прав админа (подруги и исключения).
const FOREVER_IDS = String(process.env.FOREVER_TELEGRAM_IDS || '163381553,591051945,1018991144')
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
// Цены: обычно 200 ₽. Первые 14 дней после включения оплаты — 100 ₽ (−50%).
const FULL_PRICE_RUB = 200;
const PROMO_PRICE_RUB = 100;
const PROMO_DAYS = 14;
// Когда оплата реально заработает — поставьте в Render дату старта, например:
// PAYMENT_LIVE_AT=2026-11-20T12:00:00+03:00
// До этой даты на экране уже видна скидка 100 ₽; отсчёт 2 недель идёт с неё.
const PAYMENT_LIVE_AT = (function () {
  const raw = String(process.env.PAYMENT_LIVE_AT || '').trim();
  if (!raw) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : 0;
})();

function pricingInfo(now) {
  now = now || Date.now();
  const promoEndsAt = PAYMENT_LIVE_AT
    ? (PAYMENT_LIVE_AT + PROMO_DAYS * DAY_MS)
    : null;
  // Пока оплата не включена ИЛИ идут первые 14 дней после включения — показываем 100 ₽
  const promoActive = !PAYMENT_LIVE_AT || now < promoEndsAt;
  if (promoActive) {
    return {
      priceRub: PROMO_PRICE_RUB,
      oldPriceRub: FULL_PRICE_RUB,
      promo: true,
      promoEndsAt: promoEndsAt,
      paymentLive: !!(PAYMENT_LIVE_AT && now >= PAYMENT_LIVE_AT)
    };
  }
  return {
    priceRub: FULL_PRICE_RUB,
    oldPriceRub: null,
    promo: false,
    promoEndsAt: promoEndsAt,
    paymentLive: true
  };
}

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
  const price = pricingInfo(now);
  if (isAdmin) {
    return {
      ok: true,
      status: 'admin',
      forever: true,
      expiresAt: null,
      trial: false,
      priceRub: price.priceRub,
      oldPriceRub: price.oldPriceRub,
      promo: price.promo,
      promoEndsAt: price.promoEndsAt
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
      priceRub: price.priceRub,
      oldPriceRub: price.oldPriceRub,
      promo: price.promo,
      promoEndsAt: price.promoEndsAt
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
      priceRub: price.priceRub,
      oldPriceRub: price.oldPriceRub,
      promo: price.promo,
      promoEndsAt: price.promoEndsAt
    };
  }
  return {
    ok: false,
    status: 'expired',
    forever: false,
    expiresAt: expiresAt || null,
    trial: !!data.trial,
    trialDays: trialDays,
    priceRub: price.priceRub,
    oldPriceRub: price.oldPriceRub,
    promo: price.promo,
    promoEndsAt: price.promoEndsAt
  };
}

// Полуночь по Москве (UTC+3) для календарного дня ms, плюс N суток.
function moscowMidnightPlusDays(ms, days) {
  const MOSCOW = 3 * 60 * 60 * 1000;
  const local = ms + MOSCOW;
  const startOfDay = Math.floor(local / DAY_MS) * DAY_MS - MOSCOW;
  return startOfDay + days * DAY_MS;
}

// Оплаченные дни: день оплаты НЕ входит в счёт.
// Пример: оплата на 30 дней 7 ноября → доступ до 7 декабря включительно (30 + день оплаты).
function paidExpiresAtFrom(fromMs, paidDays) {
  const days = Math.max(1, parseInt(paidDays, 10) || 30);
  const base = Math.max(Date.now(), Number(fromMs) || 0);
  return moscowMidnightPlusDays(base, days + 1);
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
        // До полуночи через 3 календарных дня: сегодня + ещё 2 = 3 дня включая сегодня
        const wantExpires = moscowMidnightPlusDays(now, 3);
        if (prev && prev.note === note && prev.expiresAt === wantExpires) {
          return res.json(buildSubscriptionStatus(uid, prev, false));
        }
        const entry = {
          active: true,
          trial: false,
          forever: false,
          expiresAt: wantExpires,
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

      // paid1 — последний день = до конца сегодняшнего дня по Москве
      const notePaid = 'force-paid-one-day-test';
      const wantExpires = moscowMidnightPlusDays(now, 1);
      if (prev && prev.note === notePaid && prev.expiresAt === wantExpires) {
        return res.json(buildSubscriptionStatus(uid, prev, false));
      }
      const paidEntry = {
        active: true,
        trial: false,
        forever: false,
        expiresAt: wantExpires,
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

async function collectSubscriptionStats() {
  const now = Date.now();
  const snap = await db.ref('subscriptions').get();
  const all = snap.exists() ? snap.val() : {};
  const counted = {};
  let trial = 0;
  let paid = 0;
  let forever = 0;
  let expired = 0;

  Object.keys(all).forEach(function (uid) {
    const d = all[uid] || {};
    const note = String(d.note || '');
    // Тестовые превью 2-й страницы в общую статистику не мешаем
    if (note.indexOf('force-') === 0) return;
    counted[uid] = true;
    if (d.forever) {
      forever += 1;
      return;
    }
    if (typeof d.expiresAt === 'number' && d.expiresAt > now) {
      if (d.trial) trial += 1;
      else paid += 1;
      return;
    }
    expired += 1;
  });

  ADMIN_IDS.concat(FOREVER_IDS).forEach(function (id) {
    if (!id || counted[id]) return;
    counted[id] = true;
    forever += 1;
  });

  return {
    total: trial + paid + forever,
    trial: trial,
    paid: paid,
    forever: forever,
    expired: expired
  };
}

// Статистика подписок — только админ
app.get('/admin/subscription-stats', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  try {
    const stats = await collectSubscriptionStats();
    return res.json({ ok: true, stats: stats });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'stats' });
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
      const paidDays = days || 30;
      const base = Math.max(now, (prev && prev.expiresAt) || 0);
      const expiresAt = paidExpiresAtFrom(base, paidDays);
      entry = {
        active: true,
        trial: false,
        forever: false,
        expiresAt: expiresAt,
        paidDays: paidDays,
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        grantedBy: String(user.id)
      };
    }
    await ref.set(entry);
    if (!forever) {
      const thanks = await sendPaidThanksToUser(targetId, entry.paidDays || days || 30);
      if (!thanks.sent) console.error('paid thanks failed', targetId, thanks);
    }
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
const BOT_APP_LINK = 'https://t.me/army_checklist_bot?startapp';
const ONEDAY_REMIND_TEXT =
  'Сегодня последний день вашей подписки на чек-лист по архиву BTS\n\n' +
  'Для продолжения использования можно добавить нужное количество дней в своем личном кабинете\n\n' +
  'Спасибо, что пользуетесь ботом 💜';
const EXPIRED_REMIND_TEXT =
  'Ваша подписка на чек-лист по архиву BTS закончилась 😢\n\n' +
  'Мы будем ждать вашего возвращения и оберегать все поставленные галочки\n\n' +
  'Продлить подписку можно в боте 💜';
const PAID_THANKS_PHOTO = path.join(__dirname, 'sub-extended.jpg');

function pluralDaysRu(n) {
  const num = Math.abs(parseInt(n, 10) || 0);
  const mod10 = num % 10;
  const mod100 = num % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

function paidThanksCaption(days) {
  const n = Math.max(1, parseInt(days, 10) || 30);
  return (
    'Подписка успешно была оплачена и продлена на ' + n + ' ' + pluralDaysRu(n) + ' ☺️\n\n' +
    'Спасибо, что поддерживаете данный проект и архив 🫶'
  );
}

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

// Первый календарный день без доступа (день expiresAt по Москве)
function isFirstExpiredDayMoscow(expiresAt, now) {
  now = now || Date.now();
  if (typeof expiresAt !== 'number' || expiresAt > now) return false;
  return moscowParts(expiresAt).dateKey === moscowParts(now).dateKey;
}

async function telegramSendMessage(chatId, text, button) {
  button = button || { text: 'Личный кабинет', url: CABINET_LINK };
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: button.text, url: button.url }
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

async function telegramSendPhoto(chatId, caption, photoPath) {
  const buf = fs.readFileSync(photoPath || PAID_THANKS_PHOTO);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', String(caption || ''));
  form.append('disable_notification', 'false');
  form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'sub-extended.jpg');
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendPhoto';
  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    const desc = data && data.description ? data.description : ('HTTP ' + res.status);
    throw new Error('telegram-photo: ' + desc);
  }
  return data;
}

async function sendPaidThanksToUser(uid, days) {
  const caption = paidThanksCaption(days);
  try {
    await telegramSendPhoto(uid, caption, PAID_THANKS_PHOTO);
    return { sent: true, days: Math.max(1, parseInt(days, 10) || 30) };
  } catch (e) {
    return { sent: false, reason: 'telegram', error: String(e.message || e) };
  }
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

async function sendExpiredReminderToUser(uid, options) {
  options = options || {};
  const force = !!options.force;
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const data = snap.exists() ? snap.val() : null;
  if (!force) {
    if (!data || data.forever) return { sent: false, reason: 'no-sub' };
    if (!isFirstExpiredDayMoscow(data.expiresAt)) return { sent: false, reason: 'not-expired-day' };
    if (data.expiredRemindFor === data.expiresAt) return { sent: false, reason: 'already' };
  }
  try {
    await telegramSendMessage(uid, EXPIRED_REMIND_TEXT, {
      text: 'Открыть бот',
      url: BOT_APP_LINK
    });
  } catch (e) {
    return { sent: false, reason: 'telegram', error: String(e.message || e) };
  }
  if (data && typeof data === 'object') {
    data.expiredRemindFor = data.expiresAt || Date.now();
    data.expiredRemindAt = Date.now();
    data.updatedAt = Date.now();
    await ref.set(data);
  } else if (force) {
    await db.ref('bot_meta/expiredRemindLog/' + uid).push({
      at: Date.now(),
      force: true
    });
  }
  return { sent: true };
}

async function runSubscriptionReminders() {
  const snap = await db.ref('subscriptions').get();
  if (!snap.exists()) return { checked: 0, lastDaySent: 0, expiredSent: 0 };
  const all = snap.val() || {};
  const ids = Object.keys(all);
  let lastDaySent = 0;
  let expiredSent = 0;
  const errors = [];
  for (let i = 0; i < ids.length; i++) {
    const uid = ids[i];
    try {
      const lastDay = await sendOneDayReminderToUser(uid, { force: false });
      if (lastDay.sent) lastDaySent++;
      const expired = await sendExpiredReminderToUser(uid, { force: false });
      if (expired.sent) expiredSent++;
    } catch (e) {
      errors.push({ uid: uid, error: String(e.message || e) });
    }
  }
  return { checked: ids.length, lastDaySent: lastDaySent, expiredSent: expiredSent, errors: errors };
}

// Админ: принудительно отправить напоминание (для теста)
// body: { userId, type?: 'lastDay' | 'expired' }
app.post('/admin/send-oneday-reminder', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const targetId = String((req.body && req.body.userId) || '').trim();
  if (!targetId) return res.status(400).json({ error: 'userId' });
  const type = String((req.body && req.body.type) || 'lastDay');
  try {
    const result = type === 'expired'
      ? await sendExpiredReminderToUser(targetId, { force: true })
      : await sendOneDayReminderToUser(targetId, { force: true });
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
      const type = String(req.query.type || 'lastDay');
      const uid = String(req.query.testUser);
      const result = type === 'expired'
        ? await sendExpiredReminderToUser(uid, { force: true })
        : await sendOneDayReminderToUser(uid, { force: true });
      return res.json({ mode: 'test', type: type, result: result });
    }
    const result = await runSubscriptionReminders();
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'cron' });
  }
});

var lastRemindCronDateKey = '';
function scheduleSubscriptionReminders() {
  setInterval(async function () {
    try {
      const parts = moscowParts(Date.now());
      // 12:00 по Москве: и «последний день», и «подписка закончилась»
      if (parts.hour === 12 && parts.minute === 0 && lastRemindCronDateKey !== parts.dateKey) {
        lastRemindCronDateKey = parts.dateKey;
        console.log('Running subscription reminders for', parts.dateKey);
        const result = await runSubscriptionReminders();
        console.log('Subscription reminders result', result);
      }
    } catch (e) {
      console.error('subscription remind cron error', e);
    }
  }, 30000);
}

app.listen(PORT, function () {
  console.log('army-api listening on ' + PORT);
  scheduleSubscriptionReminders();
  // После деплоя: тестовое «подписка продлена» с фото на 2-ю страницу
  setTimeout(async function () {
    try {
      const dayKey = moscowParts(Date.now()).dateKey;
      const metaRef = db.ref('bot_meta/testPaidThanksV2');
      const metaSnap = await metaRef.get();
      if (metaSnap.exists() && metaSnap.val() === dayKey) {
        console.log('Test paid thanks already sent today');
        return;
      }
      const testId = FORCE_TEST_IDS[0] || '2055929706';
      const result = await sendPaidThanksToUser(testId, 30);
      console.log('Test paid thanks to', testId, result);
      if (result.sent) await metaRef.set(dayKey);
    } catch (e) {
      console.error('Test paid thanks failed', e);
    }
  }, 4000);
});
