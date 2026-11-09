const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');
const { startChannelGuard } = require('./channel-guard');

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
// legacy = как у всех старых; expired / days3 / new10 / paid1; off = как обычный.
// Пока для проверки paywall: тестовый аккаунт с 0 дней (expired).
const FORCE_TEST_MODE = 'expired';
const FORCE_TEST_IDS = String(process.env.FORCE_TEST_IDS || '2055929706')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const FORCE_TEST_MODES = { legacy: 1, days3: 1, new10: 1, paid1: 1, expired: 1 };
const DAY_MS = 24 * 60 * 60 * 1000;
// Старым (уже были в реестре до запуска): общий срок с завтра после якоря.
// Было 5 дней, +1 день (итого 6), чтобы не показывать окно оплаты раньше, чем она готова.
// Совершенно новым: 10 дней с первого захода.
const LEGACY_TRIAL_DAYS_ORIGINAL = 5;
const LEGACY_TRIAL_DAYS = 6;
const NEW_TRIAL_DAYS = 10;
const TRIAL_PLAN_TAG = 'legacy6-fixed-new10';
// Момент «запуска оплаты» (фиксированная дата, иначе при рестарте Render всё сбросится).
// Можно переопределить в Render: SUBSCRIPTION_LAUNCH_AT = миллисекунды Unix.
const SUBSCRIPTION_LAUNCH_AT = Number(process.env.SUBSCRIPTION_LAUNCH_AT) ||
  Date.parse('2026-11-06T21:00:00+03:00');
// Якорь для старых: «завтра» считается от этого дня (7.11 вечер → старт 8.11).
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

function referralRef(friendId) {
  return db.ref('referrals/' + String(friendId));
}

const REFERRAL_BONUS_DAYS = 30;

async function isExistingBotUser(friendId) {
  const uid = String(friendId || '');
  if (!uid) return true;
  const [regSnap, subSnap, supportSnap] = await Promise.all([
    db.ref('user_registry/' + uid).get(),
    db.ref('subscriptions/' + uid).get(),
    db.ref('support_sessions/' + uid).get()
  ]);
  return regSnap.exists() || subSnap.exists() || supportSnap.exists();
}

async function captureReferralFromStart(friendId, payload) {
  const m = String(payload || '').trim().match(/^ref_(\d+)$/i);
  if (!m) return { saved: false, reason: 'no-payload' };
  const referrerId = String(m[1]);
  const friendKey = String(friendId || '');
  if (!friendKey || !referrerId) {
    return { saved: false, reason: 'empty' };
  }
  if (referrerId === friendKey) {
    return { saved: false, reason: 'self' };
  }
  // Бонус только для абсолютно нового id — кто уже пользовался ботом/чек-листом, не считается.
  if (await isExistingBotUser(friendKey)) {
    return { saved: false, reason: 'not-new' };
  }
  const ref = referralRef(friendKey);
  const snap = await ref.get();
  if (snap.exists()) return { saved: false, reason: 'already' };
  await ref.set({
    referrerId: referrerId,
    createdAt: Date.now(),
    rewarded: false
  });
  return { saved: true, referrerId: referrerId };
}

async function extendSubscriptionByDays(uid, days) {
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const prev = snap.exists() ? (snap.val() || {}) : {};
  if (prev.forever) return { skipped: true, reason: 'forever' };
  const now = Date.now();
  const base = Math.max(now, typeof prev.expiresAt === 'number' ? prev.expiresAt : 0);
  const expiresAt = paidExpiresAtFrom(base, days);
  await ref.update({
    active: true,
    expiresAt: expiresAt,
    updatedAt: now
  });
  return { skipped: false, expiresAt: expiresAt };
}

// После первой платной выдачи другу: +30 дней другу и пригласившему (один раз).
async function applyReferralBonusOnFirstPaid(friendId) {
  const friendKey = String(friendId || '');
  if (!friendKey) return { applied: false, reason: 'no-friend' };
  const ref = referralRef(friendKey);
  const snap = await ref.get();
  if (!snap.exists()) return { applied: false, reason: 'none' };
  const data = snap.val() || {};
  if (data.rewarded) return { applied: false, reason: 'already' };
  const referrerId = String(data.referrerId || '');
  if (!referrerId || referrerId === friendKey) {
    return { applied: false, reason: 'bad-referrer' };
  }

  const friendExt = await extendSubscriptionByDays(friendKey, REFERRAL_BONUS_DAYS);
  const referrerExt = await extendSubscriptionByDays(referrerId, REFERRAL_BONUS_DAYS);
  await ref.update({
    rewarded: true,
    rewardedAt: Date.now(),
    friendExtended: !friendExt.skipped,
    referrerExtended: !referrerExt.skipped
  });

  try {
    await telegramSendPhoto(friendKey, REFERRAL_BONUS_FRIEND_TEXT, REFERRAL_BONUS_FRIEND_PHOTO);
  } catch (e) {
    console.error('referral notify friend photo failed', friendKey, e);
    try {
      await telegramSendMessage(friendKey, REFERRAL_BONUS_FRIEND_TEXT, undefined);
    } catch (e2) {
      console.error('referral notify friend text failed', friendKey, e2);
    }
  }
  try {
    await telegramSendPhoto(referrerId, REFERRAL_BONUS_REFERRER_TEXT, REFERRAL_BONUS_REFERRER_PHOTO);
  } catch (e) {
    console.error('referral notify referrer photo failed', referrerId, e);
    try {
      await telegramSendMessage(referrerId, REFERRAL_BONUS_REFERRER_TEXT, undefined);
    } catch (e2) {
      console.error('referral notify referrer text failed', referrerId, e2);
    }
  }
  return { applied: true, referrerId: referrerId, friendExt: friendExt, referrerExt: referrerExt };
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

// Старым: один общий срок — N полных дней с завтра после якоря (день якоря не входит).
function legacyTrialExpiresAt() {
  return moscowMidnightPlusDays(LEGACY_TRIAL_ANCHOR_AT, 1 + LEGACY_TRIAL_DAYS);
}

function legacyTrialExpiresAtOriginal5() {
  return moscowMidnightPlusDays(LEGACY_TRIAL_ANCHOR_AT, 1 + LEGACY_TRIAL_DAYS_ORIGINAL);
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

// Один раз: всем со старым общим сроком (5 дней) продлить на +1 день (до нового общего expiresAt).
async function extendLegacyTrialsPlusOneDay() {
  const metaRef = db.ref('bot_meta/legacyTrialExtendPlus1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('Legacy trial +1 day already done');
    return;
  }
  const oldExpiresAt = legacyTrialExpiresAtOriginal5();
  const newExpiresAt = legacyTrialExpiresAt();
  const now = Date.now();
  const snap = await db.ref('subscriptions').get();
  const all = snap.exists() ? snap.val() || {} : {};
  const ids = Object.keys(all);
  let count = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i++) {
    const uid = ids[i];
    if (ADMIN_IDS.indexOf(uid) !== -1 || FOREVER_IDS.indexOf(uid) !== -1) {
      skipped += 1;
      continue;
    }
    const prev = all[uid] || {};
    if (prev.forever) {
      skipped += 1;
      continue;
    }
    if (!prev.trial) {
      skipped += 1;
      continue;
    }
    const exp = typeof prev.expiresAt === 'number' ? prev.expiresAt : 0;
    const note = String(prev.note || '');
    // Только общий старый срок (5 дней). Новых с 10 днями не трогаем.
    if (exp !== oldExpiresAt) {
      skipped += 1;
      continue;
    }
    await subscriptionRef(uid).set({
      active: newExpiresAt > now,
      trial: true,
      trialDays: LEGACY_TRIAL_DAYS,
      trialPlan: TRIAL_PLAN_TAG,
      forever: false,
      expiresAt: newExpiresAt,
      createdAt: prev.createdAt || now,
      updatedAt: now,
      note: note.indexOf('force-legacy') === 0 ? note : 'legacy-trial-plus1'
    });
    count += 1;
  }
  await metaRef.set({
    at: now,
    count: count,
    skipped: skipped,
    oldExpiresAt: oldExpiresAt,
    newExpiresAt: newExpiresAt
  });
  console.log('Legacy trial +1 day', {
    count: count,
    skipped: skipped,
    oldExpiresAt: oldExpiresAt,
    newExpiresAt: newExpiresAt
  });
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
    // Тестовый аккаунт: превью режимов (legacy / expired / days3 / new10 / paid1)
    if (FORCE_TEST_IDS.indexOf(uid) !== -1 && FORCE_TEST_MODES[FORCE_TEST_MODE]) {
      const ref = subscriptionRef(uid);
      const snap = await ref.get();
      const prev = snap.exists() ? snap.val() : null;
      const now = Date.now();
      const mode = FORCE_TEST_MODE;

      if (mode === 'legacy') {
        const note = 'force-legacy-same-as-all';
        const wantExpires = legacyTrialExpiresAt();
        if (prev && prev.note === note && prev.trial && prev.expiresAt === wantExpires) {
          return res.json(buildSubscriptionStatus(uid, prev, false));
        }
        const entry = {
          active: wantExpires > now,
          trial: true,
          trialDays: LEGACY_TRIAL_DAYS,
          trialPlan: TRIAL_PLAN_TAG,
          forever: false,
          expiresAt: wantExpires,
          createdAt: (prev && prev.createdAt) || now,
          updatedAt: now,
          note: note
        };
        await ref.set(entry);
        return res.json(buildSubscriptionStatus(uid, entry, false));
      }

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
      // Пауза, чтобы другу сначала дошла «оплата», и только потом «+30 бонус»
      await new Promise(function (resolve) { setTimeout(resolve, 800); });
      try {
        const bonus = await applyReferralBonusOnFirstPaid(targetId);
        if (bonus && bonus.applied) console.log('referral bonus applied', targetId, bonus.referrerId);
      } catch (bonusErr) {
        console.error('referral bonus failed', targetId, bonusErr);
      }
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
const REFERRAL_NOT_NEW_TEXT =
  'Вы уже пользовались когда-то чек-листом и есть в базе, поэтому ссылка не подходит под условия бонуса «Приведи друга»...\n\n' +
  'Но если захотите вернуться, то мы всегда рады и храним ваши галочки, если вы их ставили 😇';
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
const SUPPORT_CLOSED_TEXT =
  'Диалог с поддержкой закрыт — долго не было сообщений, поэтому новые сообщения сюда больше не доходят.\n\n' +
  'Чтобы написать снова, отправьте /support или слово «поддержка».';
const ONEDAY_REMIND_TEXT =
  'Сегодня последний день вашей подписки на чек-лист по архиву BTS\n\n' +
  'Для продолжения использования можно добавить нужное количество дней в своем личном кабинете 💜';
const EXPIRED_REMIND_TEXT =
  'Ваша подписка на чек-лист по архиву BTS закончилась 😢\n\n' +
  'Мы будем ждать вашего возвращения и оберегать все поставленные галочки\n\n' +
  'Продлить подписку можно в боте 💜';
const PAID_THANKS_PHOTO = path.join(__dirname, 'sub-extended.jpg');
const ONEDAY_REMIND_PHOTO = path.join(__dirname, 'oneday-remind.jpg');
const EXPIRED_REMIND_PHOTO = path.join(__dirname, 'expired-remind.jpg');
const REFERRAL_INVITE_PHOTO = path.join(__dirname, 'referral-invite.jpg');
const REFERRAL_NOT_NEW_PHOTO = path.join(__dirname, 'referral-not-new.jpg');
const REFERRAL_BONUS_REFERRER_PHOTO = path.join(__dirname, 'referral-bonus-referrer.jpg');
const REFERRAL_BONUS_FRIEND_PHOTO = path.join(__dirname, 'referral-bonus-friend.jpg');
const REFERRAL_SELF_PHOTO = path.join(__dirname, 'referral-self.jpg');
const REFERRAL_SELF_TEXT = 'Хитрюжка, на себя нельзя 😁';
const REFERRAL_INVITE_TEXT =
  'Ваш друг пригласил вас в чек-лист по архиву BTS 🥰\n\n' +
  'Для начала использования откройте приложение кнопкой снизу «For ARMY 💜» — у вас начнётся пробный период\n\n' +
  'Если вам понравится и вы потом оформите подписку, то вам и тому, кто пригласил, начислятся бонусные 30 дней каждому =)';
const REFERRAL_BONUS_REFERRER_TEXT =
  'Ура! Ваш приглашенный друг первый раз оформил подписку 💜\n\n' +
  'Вам начислено +' + REFERRAL_BONUS_DAYS + ' бонусных дней)';
const REFERRAL_BONUS_FRIEND_TEXT =
  'Вам начислено еще +' + REFERRAL_BONUS_DAYS + ' бонусных дней за участие в акции 💜';

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

const SUPPORT_IDLE_MS = 60 * 60 * 1000; // час без сообщений от пользователя → диалог закрывается

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

// Если пользователь молчит час — закрываем. Ответы админа таймер не продлевают.
// Возвращает { live, justClosed }.
async function ensureSupportSessionLive(uid, session) {
  if (!session || !session.active) return { live: null, justClosed: false };
  const last = supportLastUserAt(session);
  if (last && (Date.now() - last) <= SUPPORT_IDLE_MS) return { live: session, justClosed: false };
  await supportSessionRef(uid).update({
    active: false,
    awaitingFirst: false,
    closedAt: Date.now(),
    closeReason: 'user-idle'
  });
  return { live: null, justClosed: true };
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
  const ensured = await ensureSupportSessionLive(userId, session);
  if (ensured.live) {
    const lastByAdmin = Object.assign({}, ensured.live.lastAdminMsg || {});
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
    const ensured = raw ? await ensureSupportSessionLive(uid, raw) : { live: null, justClosed: false };
    const already = !!ensured.live;
    await deliverSupportMessage(msg.from, parsed.question, { followUp: already });
    if (!already) await telegramSendMessage(msg.chat.id, SUPPORT_SENT_TEXT, null);
    return true;
  }

  const sessionSnap = await supportSessionRef(uid).get();
  if (!sessionSnap.exists()) return false;
  const ensured = await ensureSupportSessionLive(uid, sessionSnap.val() || {});
  if (!ensured.live) {
    // Команды бота (кроме support) не трогаем — пусть обработает /start и т.д.
    if (isBotCommandText(text) && !parseSupportCommand(text)) return false;
    const stray = text.trim() || String(msg.caption || '').trim();
    if (!stray) return false;
    try {
      await telegramSendMessage(msg.chat.id, SUPPORT_CLOSED_TEXT, null);
    } catch (e) {
      console.error('support closed notify failed', uid, e);
    }
    return true;
  }

  const live = ensured.live;

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
    try {
      await telegramSendPhoto(uid, ONEDAY_REMIND_TEXT, ONEDAY_REMIND_PHOTO);
    } catch (photoErr) {
      console.error('oneday remind photo failed', uid, photoErr);
      await telegramSendMessage(uid, ONEDAY_REMIND_TEXT);
    }
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
    try {
      await telegramSendPhoto(uid, EXPIRED_REMIND_TEXT, EXPIRED_REMIND_PHOTO);
    } catch (photoErr) {
      console.error('expired remind photo failed', uid, photoErr);
      await telegramSendMessage(uid, EXPIRED_REMIND_TEXT, {
        text: 'Открыть бот',
        url: BOT_APP_LINK
      });
    }
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
    const parts = text.trim().split(/\s+/);
    const payload = parts.length > 1 ? parts.slice(1).join(' ') : '';
    const fromId = msg.from && msg.from.id != null ? msg.from.id : msg.chat.id;
    var skipDefaultStart = false;
    try {
      const captured = await captureReferralFromStart(fromId, payload);
      if (captured && captured.saved) {
        console.log('referral captured', String(fromId), '←', captured.referrerId);
        try {
          await telegramSendPhoto(msg.chat.id, REFERRAL_INVITE_TEXT, REFERRAL_INVITE_PHOTO);
          skipDefaultStart = true;
        } catch (inviteErr) {
          console.error('referral invite notify failed', fromId, inviteErr);
          try {
            await telegramSendMessage(msg.chat.id, REFERRAL_INVITE_TEXT, null);
            skipDefaultStart = true;
          } catch (inviteTextErr) {
            console.error('referral invite text failed', fromId, inviteTextErr);
          }
        }
      } else if (captured && captured.reason === 'not-new') {
        try {
          await telegramSendPhoto(msg.chat.id, REFERRAL_NOT_NEW_TEXT, REFERRAL_NOT_NEW_PHOTO);
          skipDefaultStart = true;
        } catch (notifyErr) {
          console.error('referral not-new photo failed', fromId, notifyErr);
          try {
            await telegramSendMessage(msg.chat.id, REFERRAL_NOT_NEW_TEXT, null);
            skipDefaultStart = true;
          } catch (textErr) {
            console.error('referral not-new text failed', fromId, textErr);
          }
        }
      } else if (captured && captured.reason === 'self') {
        try {
          await telegramSendPhoto(msg.chat.id, REFERRAL_SELF_TEXT, REFERRAL_SELF_PHOTO);
          skipDefaultStart = true;
        } catch (selfErr) {
          console.error('referral self photo failed', fromId, selfErr);
          try {
            await telegramSendMessage(msg.chat.id, REFERRAL_SELF_TEXT, null);
            skipDefaultStart = true;
          } catch (selfTextErr) {
            console.error('referral self text failed', fromId, selfTextErr);
          }
        }
      }
    } catch (refErr) {
      console.error('referral capture failed', fromId, refErr);
    }
    if (!skipDefaultStart) {
      await telegramSendMessage(msg.chat.id, START_TEXT, null);
    }
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
  try {
    const now = Date.now();
    if (FORCE_TEST_MODE === 'legacy') {
      const expiresAt = legacyTrialExpiresAt();
      await subscriptionRef(testId).set({
        active: expiresAt > now,
        trial: true,
        trialDays: LEGACY_TRIAL_DAYS,
        trialPlan: TRIAL_PLAN_TAG,
        forever: false,
        expiresAt: expiresAt,
        createdAt: now,
        updatedAt: now,
        note: 'force-legacy-same-as-all'
      });
      console.log('Test account forced legacy trial (same as old users)', testId, new Date(expiresAt).toISOString());
      return;
    }
    if (FORCE_TEST_MODE !== 'expired') return;
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
    console.error('Test account force mode failed', e);
  }
}

async function sendReferralInvitePreviewToTest() {
  const metaRef = db.ref('bot_meta/referralInvitePreviewV2');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('referral invite preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, REFERRAL_INVITE_TEXT, REFERRAL_INVITE_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('referral invite preview sent to', testId);
  } catch (e) {
    console.error('referral invite preview failed', e);
  }
}

async function sendReferralNotNewPreviewToTest() {
  const metaRef = db.ref('bot_meta/referralNotNewPreviewV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('referral not-new preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, REFERRAL_NOT_NEW_TEXT, REFERRAL_NOT_NEW_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('referral not-new preview sent to', testId);
  } catch (e) {
    console.error('referral not-new preview failed', e);
  }
}

async function sendReferralBonusReferrerPreviewToTest() {
  const metaRef = db.ref('bot_meta/referralBonusReferrerPreviewV2');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('referral bonus referrer preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, REFERRAL_BONUS_REFERRER_TEXT, REFERRAL_BONUS_REFERRER_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('referral bonus referrer preview sent to', testId);
  } catch (e) {
    console.error('referral bonus referrer preview failed', e);
  }
}

async function sendReferralBonusFriendPreviewToTest() {
  const metaRef = db.ref('bot_meta/referralBonusFriendPreviewV3');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('referral bonus friend preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, REFERRAL_BONUS_FRIEND_TEXT, REFERRAL_BONUS_FRIEND_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('referral bonus friend preview sent to', testId);
  } catch (e) {
    console.error('referral bonus friend preview failed', e);
  }
}

async function sendReferralSelfPreviewToTest() {
  const metaRef = db.ref('bot_meta/referralSelfPreviewV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('referral self preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, REFERRAL_SELF_TEXT, REFERRAL_SELF_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('referral self preview sent to', testId);
  } catch (e) {
    console.error('referral self preview failed', e);
  }
}

async function sendOnedayRemindPreviewToTest() {
  const metaRef = db.ref('bot_meta/onedayRemindPreviewV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('oneday remind preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, ONEDAY_REMIND_TEXT, ONEDAY_REMIND_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('oneday remind preview sent to', testId);
  } catch (e) {
    console.error('oneday remind preview failed', e);
  }
}

async function sendExpiredRemindPreviewToTest() {
  const metaRef = db.ref('bot_meta/expiredRemindPreviewV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('expired remind preview already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    await telegramSendPhoto(testId, EXPIRED_REMIND_TEXT, EXPIRED_REMIND_PHOTO);
    await metaRef.set({ at: Date.now(), to: testId });
    console.log('expired remind preview sent to', testId);
  } catch (e) {
    console.error('expired remind preview failed', e);
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
  extendLegacyTrialsPlusOneDay().catch(function (e) {
    console.error('legacy trial +1 day failed', e);
  });
  // Превью реферальных сообщений на тестовый аккаунт (по одному разу каждое)
  setTimeout(function () {
    sendReferralInvitePreviewToTest().catch(function (e) {
      console.error('referral invite preview boot failed', e);
    });
  }, 5000);
  setTimeout(function () {
    sendReferralNotNewPreviewToTest().catch(function (e) {
      console.error('referral not-new preview boot failed', e);
    });
  }, 7000);
  setTimeout(function () {
    sendReferralBonusReferrerPreviewToTest().catch(function (e) {
      console.error('referral bonus referrer preview boot failed', e);
    });
  }, 9000);
  setTimeout(function () {
    sendReferralBonusFriendPreviewToTest().catch(function (e) {
      console.error('referral bonus friend preview boot failed', e);
    });
  }, 11000);
  setTimeout(function () {
    sendReferralSelfPreviewToTest().catch(function (e) {
      console.error('referral self preview boot failed', e);
    });
  }, 13000);
  setTimeout(function () {
    sendOnedayRemindPreviewToTest().catch(function (e) {
      console.error('oneday remind preview boot failed', e);
    });
  }, 15000);
  setTimeout(function () {
    sendExpiredRemindPreviewToTest().catch(function (e) {
      console.error('expired remind preview boot failed', e);
    });
  }, 17000);
  // Извинение только бессрочным (им случайно ушло про 5 дней)
  setTimeout(function () {
    broadcastForeverOops().catch(function (e) {
      console.error('forever oops broadcast failed', e);
    });
  }, 6000);
  // Сторож канала — только если заданы GUARD_BOT_TOKEN + CHANNEL_ID (чек-лист не трогает)
  try {
    startChannelGuard();
  } catch (e) {
    console.error('Channel guard start failed', e);
  }
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
