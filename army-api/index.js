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
const FOREVER_IDS = String(process.env.FOREVER_TELEGRAM_IDS || '163381553,591051945,1018991144,5107937805,299076099')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
// Тестовый аккаунт (2-я страница): режим превью.
// expired = нет дней; days3 / new10 / paid1; off = как обычный.
const FORCE_TEST_MODE = String(process.env.FORCE_TEST_MODE || 'expired').trim().toLowerCase();
const FORCE_TEST_IDS = String(process.env.FORCE_TEST_IDS || '2055929706')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const FORCE_TEST_MODES = { days3: 1, new10: 1, paid1: 1, expired: 1 };
const DAY_MS = 24 * 60 * 60 * 1000;
// Старым (уже были в реестре до запуска): ровно 5 дней с завтра после якоря — один общий срок.
// Совершенно новым: 10 дней с первого захода.
const LEGACY_TRIAL_DAYS = 5;
const NEW_TRIAL_DAYS = 10;
const TRIAL_PLAN_TAG = 'legacy5-fixed-new10';
// Момент «запуска оплаты» (фиксированная дата, иначе при рестарте Render всё сбросится).
// Можно переопределить в Render: SUBSCRIPTION_LAUNCH_AT = миллисекунды Unix.
const SUBSCRIPTION_LAUNCH_AT = Number(process.env.SUBSCRIPTION_LAUNCH_AT) ||
  Date.parse('2026-11-06T21:00:00+03:00');
// Якорь для старых: «завтра» считается от этого дня (7.11 вечер → старт 8.11, 5 дней).
const LEGACY_TRIAL_ANCHOR_AT = Number(process.env.LEGACY_TRIAL_ANCHOR_AT) ||
  Date.parse('2026-11-07T21:00:00+03:00');
// Цены: обычно 200 ₽. Акция −50% (100 ₽) с отсчётом дней.
const FULL_PRICE_RUB = 200;
const PROMO_PRICE_RUB = 100;
const PROMO_DAYS = 14;
// Когда сказали «заново на 14» — обновить эту дату (или PROMO_COUNTDOWN_START_AT в Render).
const PROMO_COUNTDOWN_START_AT = Number(process.env.PROMO_COUNTDOWN_START_AT) ||
  Date.parse('2026-11-07T22:00:00+03:00');
const PAYMENT_LIVE_AT = (function () {
  const raw = String(process.env.PAYMENT_LIVE_AT || '').trim();
  if (!raw) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : 0;
})();

function promoEndsAtMs() {
  return PROMO_COUNTDOWN_START_AT + PROMO_DAYS * DAY_MS;
}

function promoDaysLeftNow(now) {
  now = now || Date.now();
  const leftMs = promoEndsAtMs() - now;
  if (leftMs <= 0) return 0;
  return Math.max(1, Math.ceil(leftMs / DAY_MS));
}

function pricingInfo(now) {
  now = now || Date.now();
  const promoEndsAt = promoEndsAtMs();
  const promoDaysLeft = promoDaysLeftNow(now);
  const promoActive = promoDaysLeft > 0;
  if (promoActive) {
    return {
      priceRub: PROMO_PRICE_RUB,
      oldPriceRub: FULL_PRICE_RUB,
      promo: true,
      promoEndsAt: promoEndsAt,
      promoDaysLeft: promoDaysLeft,
      paymentLive: !!(PAYMENT_LIVE_AT && now >= PAYMENT_LIVE_AT)
    };
  }
  return {
    priceRub: FULL_PRICE_RUB,
    oldPriceRub: null,
    promo: false,
    promoEndsAt: promoEndsAt,
    promoDaysLeft: 0,
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
      promoEndsAt: price.promoEndsAt,
      promoDaysLeft: price.promoDaysLeft
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
      promoEndsAt: price.promoEndsAt,
      promoDaysLeft: price.promoDaysLeft
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
      promoEndsAt: price.promoEndsAt,
      promoDaysLeft: price.promoDaysLeft
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
    promoEndsAt: price.promoEndsAt,
    promoDaysLeft: price.promoDaysLeft
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

// Старым: один общий срок — 5 полных дней с завтра после якоря (сегодня не входит).
function legacyTrialExpiresAt() {
  return moscowMidnightPlusDays(LEGACY_TRIAL_ANCHOR_AT, 1 + LEGACY_TRIAL_DAYS);
}

function isLegacyUser(firstSeen) {
  return firstSeen < SUBSCRIPTION_LAUNCH_AT;
}

function computeTrialExpiresAt(firstSeen, now) {
  if (isLegacyUser(firstSeen)) return legacyTrialExpiresAt();
  let expiresAt = firstSeen + NEW_TRIAL_DAYS * DAY_MS;
  if (expiresAt < now) expiresAt = now + NEW_TRIAL_DAYS * DAY_MS;
  return expiresAt;
}

function trialDaysFor(firstSeen) {
  return isLegacyUser(firstSeen) ? LEGACY_TRIAL_DAYS : NEW_TRIAL_DAYS;
}

function buildTrialEntry(firstSeen, now, prev) {
  return {
    active: true,
    trial: true,
    trialDays: trialDaysFor(firstSeen),
    trialPlan: TRIAL_PLAN_TAG,
    forever: false,
    expiresAt: computeTrialExpiresAt(firstSeen, now),
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
    note: isLegacyUser(firstSeen) ? 'legacy-trial' : 'new-trial'
  };
}

async function ensureSubscriptionRecord(uid) {
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const registrySnap = await db.ref('user_registry/' + uid).get();
  const registry = registrySnap.exists() ? registrySnap.val() : null;
  const firstSeen = registry && registry.firstSeen ? Number(registry.firstSeen) : Date.now();
  const now = Date.now();

  if (snap.exists() && snap.val()) {
    const existing = snap.val();
    if (existing.forever) return existing;
    // Кто уже был на платной (даже если срок вышел) — новый пробный не даём
    if (existing.trial === false && typeof existing.expiresAt === 'number') {
      return existing;
    }
    const note = String(existing.note || '');
    const isForce = note.indexOf('force-') === 0;
    const legacyMismatch =
      !!existing.trial &&
      isLegacyUser(firstSeen) &&
      existing.expiresAt !== legacyTrialExpiresAt();
    const needsRefresh =
      isForce ||
      existing.trialPlan !== TRIAL_PLAN_TAG ||
      legacyMismatch;

    if (needsRefresh) {
      const entry = buildTrialEntry(firstSeen, now, existing);
      await ref.set(entry);
      return entry;
    }
    return existing;
  }

  const entry = buildTrialEntry(firstSeen, now, null);
  await ref.set(entry);
  return entry;
}

// Один раз: всем из user_registry (старым) выдать общий пробный на 5 дней с завтра
async function grantLegacyTrialsToAllRegistry() {
  const metaRef = db.ref('bot_meta/legacyTrialGrantV2');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('Legacy trial bulk grant already done');
    return;
  }
  const snap = await db.ref('user_registry').get();
  if (!snap.exists()) {
    await metaRef.set({ at: Date.now(), count: 0, empty: true });
    return;
  }
  const all = snap.val() || {};
  const expiresAt = legacyTrialExpiresAt();
  const now = Date.now();
  let count = 0;
  let skipped = 0;
  const ids = Object.keys(all);
  for (let i = 0; i < ids.length; i++) {
    const uid = ids[i];
    if (ADMIN_IDS.indexOf(uid) !== -1 || FOREVER_IDS.indexOf(uid) !== -1 ||
        FORCE_TEST_IDS.indexOf(uid) !== -1) {
      skipped += 1;
      continue;
    }
    const reg = all[uid] || {};
    const firstSeen = reg.firstSeen ? Number(reg.firstSeen) : SUBSCRIPTION_LAUNCH_AT - 1;
    // Совершенно новых (после запуска оплаты) не затираем — им 10 дней при заходе
    if (!isLegacyUser(firstSeen)) {
      skipped += 1;
      continue;
    }
    const ref = subscriptionRef(uid);
    const subSnap = await ref.get();
    const prev = subSnap.exists() ? subSnap.val() : null;
    if (prev && prev.forever) {
      skipped += 1;
      continue;
    }
    if (prev && prev.trial === false && typeof prev.expiresAt === 'number' && prev.expiresAt > now) {
      skipped += 1;
      continue;
    }
    await ref.set({
      active: true,
      trial: true,
      trialDays: LEGACY_TRIAL_DAYS,
      trialPlan: TRIAL_PLAN_TAG,
      forever: false,
      expiresAt: expiresAt,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
      note: 'legacy-trial-bulk'
    });
    count += 1;
  }
  await metaRef.set({ at: now, count: count, skipped: skipped, expiresAt: expiresAt });
  console.log('Legacy trial bulk grant', { count: count, skipped: skipped, expiresAt: expiresAt });
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
    // Тестовый аккаунт: превью режимов (expired / days3 / new10 / paid1)
    if (FORCE_TEST_IDS.indexOf(uid) !== -1 && FORCE_TEST_MODES[FORCE_TEST_MODE]) {
      const ref = subscriptionRef(uid);
      const snap = await ref.get();
      const prev = snap.exists() ? snap.val() : null;
      const now = Date.now();
      const mode = FORCE_TEST_MODE;

      if (mode === 'expired') {
        const note = 'force-expired-test';
        const wantExpires = now - DAY_MS;
        if (prev && prev.note === note && typeof prev.expiresAt === 'number' && prev.expiresAt <= now) {
          return res.json(buildSubscriptionStatus(uid, prev, false));
        }
        const entry = {
          active: false,
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
  const regSnap = await db.ref('user_registry').get();
  const registered = regSnap.exists() ? Object.keys(regSnap.val() || {}).length : 0;
  const counted = {};
  let trial = 0;
  let paid = 0;
  let forever = 0;
  let expired = 0;

  const foreverSet = {};
  ADMIN_IDS.concat(FOREVER_IDS).forEach(function (id) {
    if (id) foreverSet[String(id)] = true;
  });

  Object.keys(all).forEach(function (uid) {
    const d = all[uid] || {};
    const note = String(d.note || '');
    // Тестовые превью 2-й страницы в общую статистику не мешаем
    if (note.indexOf('force-') === 0) return;
    counted[uid] = true;
    // В списке бессрочных / админ — всегда «бессрочно», даже если в базе ещё старый trial
    if (d.forever || foreverSet[uid]) {
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

  Object.keys(foreverSet).forEach(function (id) {
    if (counted[id]) return;
    counted[id] = true;
    forever += 1;
  });

  return {
    registered: registered,
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

async function nextUserNumber() {
  const countRef = db.ref('user_count');
  const regSnap = await db.ref('user_registry').get();
  const all = regSnap.exists() ? (regSnap.val() || {}) : {};
  let maxNum = 0;
  Object.keys(all).forEach(function (id) {
    const n = parseInt(all[id] && all[id].number, 10) || 0;
    if (n > maxNum) maxNum = n;
  });
  const people = Object.keys(all).length;
  const floor = Math.max(maxNum, people);
  const result = await countRef.transaction(function (current) {
    const cur = Number(current) || 0;
    return Math.max(cur, floor) + 1;
  });
  return result.snapshot.val();
}

async function reconcileUserCount() {
  const regSnap = await db.ref('user_registry').get();
  const all = regSnap.exists() ? (regSnap.val() || {}) : {};
  const people = Object.keys(all).length;
  let maxNum = 0;
  Object.keys(all).forEach(function (id) {
    const n = parseInt(all[id] && all[id].number, 10) || 0;
    if (n > maxNum) maxNum = n;
  });
  const want = Math.max(people, maxNum);
  const countRef = db.ref('user_count');
  const curSnap = await countRef.get();
  const cur = Number(curSnap.val()) || 0;
  if (want > cur) {
    await countRef.set(want);
    console.log('user_count reconciled', cur, '→', want, '(people', people + ')');
  } else {
    console.log('user_count ok', cur, '(people', people + ')');
  }
  return { people: people, userCount: Math.max(cur, want), maxNum: maxNum };
}

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
    const newNumber = await nextUserNumber();
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
const START_TEXT =
  'Просто откройте приложение по кнопке снизу "For ARMY 💜"\n\n' +
  'При возникновении каких-то вопросов или проблем напишите /support или слово «поддержка»';
const CHANNEL_TRIAL_POST = 'https://t.me/violent_arhive/5708';
// Рассылка про 5 дней пробного — сначала только тест, массово после вашего «ок»
const TRIAL5_ANNOUNCE_TEXT =
  'У вас осталось 5 дней пробного периода доступа к чек-листу, чтобы ознакомиться и решить нужен ли он вам в будущем\n\n' +
  'Более подробная информация написана на канале 💜';
const SUPPORT_ASK_TEXT =
  'Напишите ваш вопрос — я передам его в поддержку.\n\nМожно продолжать переписку здесь: ваши сообщения и ответы поддержки будут в этом боте 💜';
const SUPPORT_SENT_TEXT =
  'Сообщение отправлено в поддержку. Можно писать дальше сюда же — это диалог. Ответ придёт в этот бот 💜';
const SUPPORT_EMPTY_TEXT =
  'Пожалуйста, напишите вопрос текстом.';
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

async function telegramSendMessage(chatId, text, button, replyToMsgId) {
  // button === undefined → кнопка «Личный кабинет»
  // button === null → без кнопок
  if (button === undefined) button = { text: 'Личный кабинет', url: CABINET_LINK };
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  };
  if (button) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: button.text, url: button.url }]]
    };
  }
  if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    const desc = data && data.description ? data.description : ('HTTP ' + res.status);
    throw new Error('telegram: ' + desc);
  }
  return data;
}

function isAdminTelegramId(id) {
  return ADMIN_IDS.indexOf(String(id)) !== -1;
}

function parseSupportCommand(text) {
  const t = String(text || '').trim();
  let m = t.match(/^\/(?:support|podderzhka|поддержка)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (m) return { question: String(m[1] || '').trim() };
  m = t.match(/^поддержка(?:\s+([\s\S]*))?$/i);
  if (m) return { question: String(m[1] || '').trim() };
  return null;
}

function isBotCommandText(text) {
  return /^\/[a-zA-Zа-яА-ЯёЁ_]+/.test(String(text || '').trim());
}

const SUPPORT_IDLE_MS = 60 * 60 * 1000; // час без сообщений от пользователя → диалог тихо закрывается

function supportSessionRef(uid) {
  return db.ref('support_sessions/' + uid);
}

function supportTicketRef(adminChatId, adminMsgId) {
  return db.ref('support_tickets/' + adminChatId + '_' + adminMsgId);
}

async function saveSupportSession(uid, extra) {
  const prevSnap = await supportSessionRef(uid).get();
  const prev = prevSnap.exists() ? (prevSnap.val() || {}) : {};
  const entry = Object.assign({}, prev, extra || {}, {
    updatedAt: Date.now(),
    createdAt: prev.createdAt || Date.now()
  });
  await supportSessionRef(uid).set(entry);
  return entry;
}

async function openSupportSession(uid, extra) {
  return saveSupportSession(uid, Object.assign({}, extra || {}, { active: true }));
}

function supportLastUserAt(session) {
  if (!session || typeof session !== 'object') return 0;
  return Number(session.lastUserTextAt || session.createdAt || 0) || 0;
}

// Если пользователь молчит час — закрываем без сообщений. Ответы админа таймер не продлевают.
async function ensureSupportSessionLive(uid, session) {
  if (!session || !session.active) return null;
  const last = supportLastUserAt(session);
  if (last && (Date.now() - last) <= SUPPORT_IDLE_MS) return session;
  await supportSessionRef(uid).update({
    active: false,
    awaitingFirst: false,
    closedAt: Date.now(),
    closeReason: 'user-idle'
  });
  return null;
}

async function deliverSupportMessage(fromUser, questionText, options) {
  options = options || {};
  const uid = String(fromUser.id);
  const prevSnap = await supportSessionRef(uid).get();
  const prev = prevSnap.exists() ? (prevSnap.val() || {}) : {};
  const session = await openSupportSession(uid, {
    awaitingFirst: false,
    lastAdminMsg: prev.lastAdminMsg || {}
  });
  const name = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'без имени';
  const uname = fromUser.username ? '@' + fromUser.username : 'нет username';
  const isFollowUp = !!options.followUp;
  const body =
    (isFollowUp ? '💬 Продолжение диалога\n' : '🆘 Сообщение в поддержку\n') +
    'От: ' + name + ' (' + uname + ')\n' +
    'id: ' + uid + '\n\n' +
    questionText +
    '\n\n↳ Ответьте reply на это сообщение — текст уйдёт человеку. Диалог можно продолжать.';

  const admins = ADMIN_IDS.length ? ADMIN_IDS : [];
  if (!admins.length) throw new Error('no-admin');

  const lastByAdmin = (session && session.lastAdminMsg) || {};
  const nextLast = Object.assign({}, lastByAdmin);

  for (let i = 0; i < admins.length; i++) {
    const adminId = admins[i];
    const replyTo = lastByAdmin[adminId] || null;
    let sent;
    try {
      sent = await telegramSendMessage(adminId, body, null, replyTo);
    } catch (e) {
      // Если старый reply_to уже невалиден — шлём без него
      sent = await telegramSendMessage(adminId, body, null);
    }
    const msgId = sent && sent.result && sent.result.message_id;
    if (msgId) {
      nextLast[adminId] = msgId;
      await supportTicketRef(adminId, msgId).set({
        userId: uid,
        userName: name,
        at: Date.now()
      });
    }
  }

  await openSupportSession(uid, {
    awaitingFirst: false,
    lastAdminMsg: nextLast,
    lastUserTextAt: Date.now()
  });
}

async function handleAdminSupportReply(msg) {
  if (!msg || !msg.from || !isAdminTelegramId(msg.from.id)) return false;
  const reply = msg.reply_to_message;
  if (!reply || !reply.message_id) return false;
  const snap = await supportTicketRef(msg.chat.id, reply.message_id).get();
  if (!snap.exists()) return false;
  const ticket = snap.val() || {};
  const userId = String(ticket.userId || '');
  if (!userId) return false;

  let answer = String(msg.text || msg.caption || '').trim();
  if (!answer) {
    await telegramSendMessage(msg.chat.id, 'Ответ пока только текстом — напишите текст reply-ем.', null);
    return true;
  }

  await telegramSendMessage(userId, 'Ответ поддержки:\n\n' + answer, null);

  // Ответ админа не продлевает час ожидания и не открывает диалог заново
  const sessionSnap = await supportSessionRef(userId).get();
  const session = sessionSnap.exists() ? (sessionSnap.val() || {}) : {};
  const live = await ensureSupportSessionLive(userId, session);
  if (live) {
    const lastByAdmin = Object.assign({}, live.lastAdminMsg || {});
    lastByAdmin[String(msg.chat.id)] = reply.message_id;
    await saveSupportSession(userId, {
      active: true,
      awaitingFirst: false,
      lastAdminMsg: lastByAdmin
    });
  }

  await telegramSendMessage(msg.chat.id, '✓ Отправлено. Можно продолжать диалог reply-ем.', null);
  return true;
}

async function handleSupportFlow(msg) {
  if (!msg || !msg.chat || !msg.from) return false;
  if (msg.chat.type !== 'private') return false;
  const uid = String(msg.from.id);
  const text = String(msg.text || '');

  // Админ отвечает reply-ем на любое сообщение диалога
  if (await handleAdminSupportReply(msg)) return true;
  // Сообщения админа без reply в поддержку не пересылаем
  if (isAdminTelegramId(msg.from.id)) return false;

  const parsed = parseSupportCommand(text);
  if (parsed) {
    if (!parsed.question) {
      await openSupportSession(uid, {
        awaitingFirst: true,
        lastUserTextAt: Date.now()
      });
      await telegramSendMessage(msg.chat.id, SUPPORT_ASK_TEXT, null);
      return true;
    }
    const sessionSnap = await supportSessionRef(uid).get();
    const raw = sessionSnap.exists() ? sessionSnap.val() : null;
    const live = raw ? await ensureSupportSessionLive(uid, raw) : null;
    const already = !!live;
    await deliverSupportMessage(msg.from, parsed.question, { followUp: already });
    if (!already) await telegramSendMessage(msg.chat.id, SUPPORT_SENT_TEXT, null);
    return true;
  }

  const sessionSnap = await supportSessionRef(uid).get();
  if (!sessionSnap.exists()) return false;
  const live = await ensureSupportSessionLive(uid, sessionSnap.val() || {});
  if (!live) return false;

  // Команды бота (кроме support) не считаем текстом диалога
  if (isBotCommandText(text) && !parseSupportCommand(text)) return false;

  const question = text.trim() || String(msg.caption || '').trim();
  if (!question) {
    if (live.awaitingFirst) {
      await telegramSendMessage(msg.chat.id, SUPPORT_EMPTY_TEXT, null);
      return true;
    }
    return false;
  }

  const wasAwaiting = !!live.awaitingFirst;
  await deliverSupportMessage(msg.from, question, { followUp: !wasAwaiting });
  if (wasAwaiting) await telegramSendMessage(msg.chat.id, SUPPORT_SENT_TEXT, null);
  return true;
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

async function handleStartCommand(msg) {
  if (!msg || !msg.chat || !msg.chat.id) return false;
  const text = String(msg.text || '');
  if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return false;
  try {
    await telegramSendMessage(msg.chat.id, START_TEXT, null);
  } catch (e) {
    console.error('start reply failed', e);
  }
  return true;
}

async function handleBotMessage(msg) {
  if (!msg) return;
  try {
    if (await handleSupportFlow(msg)) return;
    await handleStartCommand(msg);
  } catch (e) {
    console.error('bot message handle error', e);
  }
}

// Telegram шлёт сюда все апдейты (команда /start и т.д.)
app.post('/telegram/webhook', async function (req, res) {
  const secret = String(process.env.WEBHOOK_SECRET || '');
  if (secret) {
    const got = String(req.get('x-telegram-bot-api-secret-token') || '');
    if (got !== secret) return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ ok: true });
  try {
    const update = req.body || {};
    if (update.message) await handleBotMessage(update.message);
  } catch (e) {
    console.error('webhook handle error', e);
  }
});

async function ensureTelegramWebhook() {
  const base = String(
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://army-checklist.onrender.com'
  ).replace(/\/$/, '');
  const webhookUrl = base + '/telegram/webhook';
  const secret = String(process.env.WEBHOOK_SECRET || '');
  const body = {
    url: webhookUrl,
    allowed_updates: ['message'],
    drop_pending_updates: false
  };
  if (secret) body.secret_token = secret;
  try {
    const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(function () { return null; });
    console.log('setWebhook', webhookUrl, data && data.ok ? 'ok' : data);
  } catch (e) {
    console.error('setWebhook failed', e);
  }
}

async function ensureBotCommands() {
  try {
    const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setMyCommands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Как открыть приложение' },
          { command: 'support', description: 'Написать в поддержку' }
        ]
      })
    });
    const data = await res.json().catch(function () { return null; });
    console.log('setMyCommands', data && data.ok ? 'ok' : data);
  } catch (e) {
    console.error('setMyCommands failed', e);
  }
}

async function applyForceTestAccountOnBoot() {
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  if (!FORCE_TEST_MODES[FORCE_TEST_MODE]) return;
  if (FORCE_TEST_MODE !== 'expired') return;
  try {
    const now = Date.now();
    await subscriptionRef(testId).set({
      active: false,
      trial: false,
      forever: false,
      expiresAt: now - DAY_MS,
      createdAt: now,
      updatedAt: now,
      note: 'force-expired-test'
    });
    console.log('Test account forced expired (no days)', testId);
  } catch (e) {
    console.error('Test account force expired failed', e);
  }
}

app.listen(PORT, function () {
  console.log('army-api listening on ' + PORT);
  scheduleSubscriptionReminders();
  ensureTelegramWebhook();
  ensureBotCommands();
  applyForceTestAccountOnBoot();
  reconcileUserCount().catch(function (e) {
    console.error('user_count reconcile failed', e);
  });
  grantLegacyTrialsToAllRegistry().catch(function (e) {
    console.error('legacy trial bulk failed', e);
  });
  // Извинение только бессрочным (им случайно ушло про 5 дней)
  setTimeout(function () {
    broadcastForeverOops().catch(function (e) {
      console.error('forever oops broadcast failed', e);
    });
  }, 6000);
});

const FOREVER_OOPS_TEXT =
  'Ой, для вас бесконечная подписка — забудьте 😂';

async function broadcastForeverOops() {
  const metaRef = db.ref('bot_meta/foreverOopsBroadcastV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('forever oops broadcast already done', metaSnap.val());
    return;
  }
  await metaRef.set({ at: Date.now(), status: 'running' });

  const ids = {};
  ADMIN_IDS.concat(FOREVER_IDS).forEach(function (id) {
    if (id) ids[String(id)] = true;
  });
  // На всякий случай — кто уже forever в базе подписок
  try {
    const snap = await db.ref('subscriptions').get();
    const all = snap.exists() ? (snap.val() || {}) : {};
    Object.keys(all).forEach(function (uid) {
      if (all[uid] && all[uid].forever) ids[uid] = true;
    });
  } catch (e) {
    console.error('forever oops: subscriptions read failed', e);
  }

  const list = Object.keys(ids);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    try {
      await telegramSendMessage(list[i], FOREVER_OOPS_TEXT, null);
      sent += 1;
    } catch (e) {
      failed += 1;
      console.error('forever oops fail', list[i], String(e.message || e));
    }
    await new Promise(function (resolve) { setTimeout(resolve, 45); });
  }

  await metaRef.set({
    at: Date.now(),
    status: 'done',
    sent: sent,
    failed: failed,
    total: list.length
  });
  console.log('forever oops broadcast done', { sent: sent, failed: failed, total: list.length });
}
