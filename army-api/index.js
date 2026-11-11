const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');
const NalogAPI = require('moy-nalog');
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
// Форс выключен — тест идёт по реальной подписке (после оплаты Stars и т.п.).
const FORCE_TEST_MODE = 'off';
const FORCE_TEST_IDS = String(process.env.FORCE_TEST_IDS || '2055929706')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const FORCE_TEST_MODES = { legacy: 1, days3: 1, new10: 1, paid1: 1, expired: 1 };
const DAY_MS = 24 * 60 * 60 * 1000;
// Comeback: +5 дней, если давно не заходил и доступа нет. Пока только тест.
const COMEBACK_DAYS = 5;
const COMEBACK_IDLE_DAYS = 60;
const COMEBACK_TEST_ONLY = true;
const COMEBACK_TEXT =
  'Вас давно не было в чек-листе, поэтому снова есть ' + COMEBACK_DAYS +
  ' дней доступа — чтобы вспомнить или ознакомиться с функционалом 💜';
// Старым (уже были в реестре до запуска): общий срок с завтра после якоря.
// Было 5 → +1 (6) → ещё +1 (7), пока ЮKassa не подключена.
// Совершенно новым: 10 дней с первого захода.
const LEGACY_TRIAL_DAYS_ORIGINAL = 5;
const LEGACY_TRIAL_DAYS_BEFORE = 6;
const LEGACY_TRIAL_DAYS = 7;
const NEW_TRIAL_DAYS = 10;
const TRIAL_PLAN_TAG = 'legacy7-fixed-new10';
// Момент «запуска оплаты» (фиксированная дата, иначе при рестарте Render всё сбросится).
// Можно переопределить в Render: SUBSCRIPTION_LAUNCH_AT = миллисекунды Unix.
const SUBSCRIPTION_LAUNCH_AT = Number(process.env.SUBSCRIPTION_LAUNCH_AT) ||
  Date.parse('2026-11-06T21:00:00+03:00');
// Якорь для старых: «завтра» считается от этого дня (7.11 вечер → старт 8.11).
const LEGACY_TRIAL_ANCHOR_AT = Number(process.env.LEGACY_TRIAL_ANCHOR_AT) ||
  Date.parse('2026-11-07T21:00:00+03:00');
// Цены тарифов (карта). Акция 100 ₽ / 30 дн. — один раз, окно акции 15 дней.
const FULL_PRICE_RUB = 200;
const PROMO_PRICE_RUB = 100;
// Временный тест авточека: тестовый id платит акцию за 10 ₽
const TEST_PROMO_PRICE_RUB = 10;
const PROMO_ACCESS_DAYS = 30;
const PROMO_DAYS = 15;
const FOREVER_PRICE_RUB = 5000;
const PLAN_PRICES = {
  30: 200,
  60: 350,
  90: 500,
  180: 1000
};
// Старт акции: сегодня вечером → завтра в счётчике ~14 дней из 15.
const PROMO_COUNTDOWN_START_AT = Number(process.env.PROMO_COUNTDOWN_START_AT) ||
  Date.parse('2026-11-11T22:00:00+03:00');
const PAYMENT_LIVE_AT = (function () {
  const raw = String(process.env.PAYMENT_LIVE_AT || '').trim();
  if (!raw) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : 0;
})();
// ЮKassa (карта). Ключи — в Render Environment.
const YOOKASSA_SHOP_ID = String(process.env.YOOKASSA_SHOP_ID || '').trim();
const YOOKASSA_SECRET_KEY = String(process.env.YOOKASSA_SECRET_KEY || '').trim();
const YOOKASSA_RETURN_URL = String(process.env.YOOKASSA_RETURN_URL || '').trim() ||
  'https://secretsofbts.github.io/army_checklist/payment.html?paid=1';
// Авточеки самозанятой через неофициальный API «Мой налог» (lknpd.nalog.ru)
const MOY_NALOG_LOGIN = String(process.env.MOY_NALOG_LOGIN || process.env.MOY_NALOG_INN || '').trim();
const MOY_NALOG_PASSWORD = String(process.env.MOY_NALOG_PASSWORD || '').trim();
const MOY_NALOG_SERVICE_NAME = String(process.env.MOY_NALOG_SERVICE_NAME || '').trim() ||
  'Доступ к чек-листу BTS';

function yookassaReady() {
  return !!(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY);
}

function moyNalogReady() {
  return !!(MOY_NALOG_LOGIN && MOY_NALOG_PASSWORD);
}

let moyNalogClient = null;
function getMoyNalogClient() {
  if (!moyNalogReady()) return null;
  if (!moyNalogClient) {
    // autologin:false — логинимся явно, чтобы ловить ошибку «Не найдено»
    moyNalogClient = new NalogAPI({
      login: MOY_NALOG_LOGIN,
      password: MOY_NALOG_PASSWORD,
      autologin: false
    });
  }
  return moyNalogClient;
}

function resetMoyNalogClient() {
  moyNalogClient = null;
}

function friendlyMoyNalogError(raw) {
  const msg = String(raw || '').trim();
  const low = msg.toLowerCase();
  if (low === 'не найдено' || low.indexOf('не найдено') !== -1) {
    return 'Не найдено: проверьте MOY_NALOG_LOGIN (ИНН 12 цифр) и MOY_NALOG_PASSWORD (пароль от lknpd.nalog.ru), не телефон';
  }
  if (low.indexOf('парол') !== -1 || low.indexOf('auth') !== -1 || low.indexOf('авториз') !== -1) {
    return 'Ошибка входа в «Мой налог»: ' + msg;
  }
  return msg || 'moy-nalog-error';
}

async function ensureMoyNalogAuth(api) {
  if (!api) throw new Error('not-configured');
  try {
    await api.auth(MOY_NALOG_LOGIN, MOY_NALOG_PASSWORD);
  } catch (e) {
    resetMoyNalogClient();
    throw new Error(friendlyMoyNalogError((e && e.message) || e));
  }
}

/** ISO с фиксированным +03:00 — на Render сервер в UTC, иначе в чеке не МСК. */
function dateToMoscowISO(date) {
  const value = new Date(date || Date.now());
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Некорректная дата');
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(value);
  const map = {};
  parts.forEach(function (p) {
    if (p.type !== 'literal') map[p.type] = p.value;
  });
  return (
    map.year + '-' + map.month + '-' + map.day +
    'T' + map.hour + ':' + map.minute + ':' + map.second +
    '+03:00'
  );
}

/** Как addIncome из moy-nalog, но время операции всегда по Москве. */
async function moyNalogAddIncomeMoscow(api, params) {
  params = params || {};
  const name = String(params.name || '').trim();
  const unit = Number(Number(params.amount).toFixed(2));
  const count = Number(params.quantity) || 1;
  if (!name || !Number.isFinite(unit) || !Number.isFinite(count)) {
    throw new TypeError('bad-income-params');
  }
  const total = Number((unit * count).toFixed(2));
  const opIso = dateToMoscowISO(params.date || new Date());
  const reqIso = dateToMoscowISO(new Date());
  const response = await api.call('income', {
    paymentType: 'CASH',
    ignoreMaxTotalIncomeRestriction: false,
    client: {
      contactPhone: null,
      displayName: null,
      incomeType: 'FROM_INDIVIDUAL',
      inn: null
    },
    requestTime: reqIso,
    operationTime: opIso,
    services: [{ name: name, amount: unit, quantity: count }],
    totalAmount: total.toFixed(2)
  });
  if (!response || !response.approvedReceiptUuid) {
    return { error: response };
  }
  const id = String(response.approvedReceiptUuid);
  const inn = String(api.INN || '');
  const base = String(api.apiUrl || 'https://lknpd.nalog.ru/api/v1');
  return {
    id: id,
    approvedReceiptUuid: id,
    printUrl: base + '/receipt/' + inn + '/' + id + '/print',
    jsonUrl: base + '/receipt/' + inn + '/' + id + '/json'
  };
}

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
  const live = yookassaReady() || !!(PAYMENT_LIVE_AT && now >= PAYMENT_LIVE_AT);
  return {
    priceRub: FULL_PRICE_RUB,
    oldPriceRub: null,
    promo: promoActive,
    promoPriceRub: PROMO_PRICE_RUB,
    promoAccessDays: PROMO_ACCESS_DAYS,
    promoEndsAt: promoEndsAt,
    promoDaysLeft: promoActive ? promoDaysLeft : 0,
    promoUsed: false,
    plans: PLAN_PRICES,
    foreverPriceRub: FOREVER_PRICE_RUB,
    paymentLive: live
  };
}

function isForceTestUser(uid) {
  return !!(uid && FORCE_TEST_IDS.indexOf(String(uid)) !== -1);
}

function promoPriceForUser(uid) {
  return isForceTestUser(uid) ? TEST_PROMO_PRICE_RUB : PROMO_PRICE_RUB;
}

// Акция 100 ₽ / −50% Stars — только на первую оплату. Повторно всегда полная цена.
function hasUsedPromoPrice(data, uid) {
  data = data || {};
  // Тестовый аккаунт: смотрим только флаг promoUsed (чтобы можно было снова дать акцию для проверки)
  if (isForceTestUser(uid)) {
    return data.promoUsed === true;
  }
  if (data.promoUsed === true) return true;
  // Уже была платная подписка (не пробный)
  if (data.trial === false && typeof data.expiresAt === 'number') return true;
  if (data.lastStarsPayment) return true;
  return false;
}

function pricingInfoForUser(data, now, uid) {
  const base = pricingInfo(now);
  const used = hasUsedPromoPrice(data, uid);
  // Окно акции на экране: только пока акция идёт и человек ещё не платил
  const showPromo = !!(base.promo && !used);
  const promoPrice = promoPriceForUser(uid);
  return Object.assign({}, base, {
    promo: showPromo,
    promoDaysLeft: showPromo ? base.promoDaysLeft : 0,
    promoUsed: used,
    promoPriceRub: promoPrice,
    // priceRub — цена акции, если она доступна; иначе обычные 30 дней
    priceRub: showPromo ? promoPrice : FULL_PRICE_RUB,
    oldPriceRub: showPromo ? FULL_PRICE_RUB : null
  });
}

function resolveYooKassaPlan(body, priceInfo) {
  body = body || {};
  priceInfo = priceInfo || {};
  const wantPromo = !!(body.promo || body.plan === 'promo');
  const wantForever = !!(body.forever || body.plan === 'forever');
  if (wantForever) {
    return {
      forever: true,
      days: 0,
      amountRub: FOREVER_PRICE_RUB,
      promo: false,
      label: 'бессрочный доступ'
    };
  }
  if (wantPromo) {
    if (!priceInfo.promo) {
      return { error: 'promo-unavailable' };
    }
    const promoAmount = Math.max(
      1,
      Math.round(Number(priceInfo.promoPriceRub) || PROMO_PRICE_RUB)
    );
    return {
      forever: false,
      days: PROMO_ACCESS_DAYS,
      amountRub: promoAmount,
      promo: true,
      label: PROMO_ACCESS_DAYS + ' дн. (акция)'
    };
  }
  const days = parseInt(body.days, 10);
  if (!PLAN_PRICES[days]) {
    return { error: 'bad-plan' };
  }
  return {
    forever: false,
    days: days,
    amountRub: PLAN_PRICES[days],
    promo: false,
    label: days + ' дн.'
  };
}

/** Ожидаемая сумма за тариф (для сверки при выдаче дней). */
function expectedAmountForPlan(days, forever, promo, promoAmountRub) {
  if (forever) return FOREVER_PRICE_RUB;
  if (promo) {
    const p = Math.round(Number(promoAmountRub) || 0);
    if (p > 0) return p;
    return PROMO_PRICE_RUB;
  }
  const d = parseInt(days, 10);
  if (PLAN_PRICES[d] != null) return PLAN_PRICES[d];
  return null;
}

/**
 * Дни/forever по факту оплаты: сначала metadata, если сумма не сходится — по amountRub.
 */
function resolveGrantPlanFromPayment(meta, prev, amountRub) {
  meta = meta || {};
  prev = prev || {};
  const amount = Math.round(Number(amountRub) || 0);
  let forever = String(meta.forever || '') === '1' || prev.forever === true;
  let promo = String(meta.promo || '') === '1' || prev.promo === true;
  let days = forever ? 0 : Math.max(1, parseInt(meta.days != null ? meta.days : prev.days, 10) || 30);

  const expected = expectedAmountForPlan(
    days,
    forever,
    promo,
    prev.amountRub || meta.amountRub
  );
  if (expected != null && amount === expected) {
    return { forever: forever, days: days, promo: promo };
  }

  // Сумма не совпала с заявленным тарифом — восстановить по сумме
  console.error('yookassa plan/amount mismatch, resolve by amount', {
    days: days,
    forever: forever,
    promo: promo,
    amount: amount,
    expected: expected
  });
  if (amount === FOREVER_PRICE_RUB) {
    return { forever: true, days: 0, promo: false };
  }
  if (amount === PROMO_PRICE_RUB || amount === TEST_PROMO_PRICE_RUB) {
    return { forever: false, days: PROMO_ACCESS_DAYS, promo: true };
  }
  const keys = Object.keys(PLAN_PRICES);
  for (let i = 0; i < keys.length; i++) {
    const d = parseInt(keys[i], 10);
    if (PLAN_PRICES[d] === amount) {
      return { forever: false, days: d, promo: false };
    }
  }
  // Не узнали сумму — оставляем metadata (лучше выдать дни, чем потерять оплату)
  return { forever: forever, days: days, promo: promo };
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

function attachPricingFields(out, price) {
  out.priceRub = price.priceRub;
  out.oldPriceRub = price.oldPriceRub;
  out.promo = price.promo;
  out.promoEndsAt = price.promoEndsAt;
  out.promoDaysLeft = price.promoDaysLeft;
  out.promoUsed = !!price.promoUsed;
  out.promoPriceRub = price.promoPriceRub;
  out.promoAccessDays = price.promoAccessDays;
  out.plans = price.plans;
  out.foreverPriceRub = price.foreverPriceRub;
  out.paymentLive = !!price.paymentLive;
  return out;
}

function buildSubscriptionStatus(uid, data, isAdmin) {
  const now = Date.now();
  data = data || {};
  const price = pricingInfoForUser(data, now, uid);
  if (isAdmin) {
    return attachPricingFields({
      ok: true,
      status: 'admin',
      forever: true,
      expiresAt: null,
      trial: false
    }, price);
  }
  if (data.forever) {
    return attachPricingFields({
      ok: true,
      status: 'forever',
      forever: true,
      expiresAt: null,
      trial: false
    }, price);
  }
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0;
  const trialDays = typeof data.trialDays === 'number' ? data.trialDays : null;
  if (expiresAt > now) {
    return attachPricingFields({
      ok: true,
      status: data.trial ? 'trial' : 'active',
      forever: false,
      expiresAt: expiresAt,
      trial: !!data.trial,
      trialDays: trialDays
    }, price);
  }
  return attachPricingFields({
    ok: false,
    status: 'expired',
    forever: false,
    expiresAt: expiresAt || null,
    trial: !!data.trial,
    trialDays: trialDays
  }, price);
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
    const note = String(existing.note || '');
    // Comeback / спец. выдачи не перетирать legacy-пробным
    if (note.indexOf('comeback') === 0) return existing;
    const isForce = note.indexOf('force-') === 0;
    // Хвост от тестового форса не считаем «бывшей оплатой» — иначе навсегда expired
    if (isForce) {
      if (FORCE_TEST_IDS.indexOf(String(uid)) !== -1 && !FORCE_TEST_MODES[FORCE_TEST_MODE]) {
        const expiresAt = paidExpiresAtFrom(now, 30);
        const restored = {
          active: true,
          trial: false,
          forever: false,
          expiresAt: expiresAt,
          paidDays: 30,
          createdAt: (existing && existing.createdAt) || now,
          updatedAt: now,
          note: 'stars-paid-restored-after-force',
          promoUsed: true,
          promoUsedAt: (existing && existing.promoUsedAt) || now
        };
        await ref.set(restored);
        return restored;
      }
      const entry = buildTrialEntry(firstSeen, now, existing);
      await ref.set(entry);
      return entry;
    }
    // Кто уже был на платной (даже если срок вышел) — новый пробный не даём
    if (existing.trial === false && typeof existing.expiresAt === 'number') {
      return existing;
    }
    const legacyMismatch =
      !!existing.trial &&
      isLegacyUser(firstSeen) &&
      existing.expiresAt !== legacyTrialExpiresAt();
    const needsRefresh =
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

function hasActiveAccess(data, now) {
  now = now || Date.now();
  if (!data) return false;
  if (data.forever) return true;
  return typeof data.expiresAt === 'number' && data.expiresAt > now;
}

async function touchLastVisit(uid, data) {
  const now = Date.now();
  try {
    await subscriptionRef(uid).update({ lastVisitAt: now, updatedAt: now });
  } catch (e) {
    console.error('touchLastVisit failed', uid, e);
  }
  try {
    await db.ref('user_registry/' + uid).update({ lastVisitAt: now });
  } catch (e) {
    // реестра может не быть — не критично
  }
  if (data && typeof data === 'object') data.lastVisitAt = now;
  return data;
}

/**
 * Вернуть 5 дней «comeback», если доступа нет и человек не заходил COMEBACK_IDLE_DAYS.
 * Только один раз за всё время (comebackUsed) — повторно после ещё 60 дней уже не даём.
 * Пока COMEBACK_TEST_ONLY — только FORCE_TEST_IDS.
 */
async function maybeApplyComebackGrant(uid, data) {
  uid = String(uid || '');
  data = data || {};
  if (!uid) return data;
  if (COMEBACK_TEST_ONLY && FORCE_TEST_IDS.indexOf(uid) === -1) return data;
  if (ADMIN_IDS.indexOf(uid) !== -1 || FOREVER_IDS.indexOf(uid) !== -1) return data;
  if (data.forever) return data;
  // Уже получал comeback когда-то — больше никогда
  if (data.comebackUsed === true || data.comebackGrantedAt) return data;

  const now = Date.now();
  if (hasActiveAccess(data, now)) return data;

  const lastVisit = typeof data.lastVisitAt === 'number' ? data.lastVisitAt : 0;
  const idleNeed = COMEBACK_IDLE_DAYS * DAY_MS;
  // lastVisit=0 → считаем, что «очень давно» (или подготовка теста)
  if (lastVisit && (now - lastVisit) < idleNeed) return data;

  // 5 полных дней → в кабинете 6 (сегодня + 5). Истекает в полночь МСК после 5-го полного дня.
  const expiresAt = moscowMidnightPlusDays(now, COMEBACK_DAYS + 1);
  const entry = {
    active: true,
    trial: true,
    trialDays: COMEBACK_DAYS,
    trialPlan: TRIAL_PLAN_TAG,
    forever: false,
    expiresAt: expiresAt,
    createdAt: data.createdAt || now,
    updatedAt: now,
    lastVisitAt: now,
    comebackGrantedAt: now,
    comebackUsed: true,
    note: 'comeback-5',
    promoUsed: data.promoUsed === true,
    promoUsedAt: data.promoUsedAt || null
  };
  await subscriptionRef(uid).set(entry);
  try {
    await telegramSendMessage(uid, COMEBACK_TEXT, undefined);
  } catch (e) {
    console.error('comeback notify failed', uid, e);
  }
  console.log('comeback grant once', uid, expiresAt);
  return entry;
}

/** Разово подготовить тестовый аккаунт: истёк доступ + «не заходил» 61 день. */
async function prepareComebackTestPreview() {
  if (!COMEBACK_TEST_ONLY) return;
  const metaRef = db.ref('bot_meta/comebackTestPrepV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('comeback test prep already done', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  const now = Date.now();
  const ref = subscriptionRef(testId);
  const snap = await ref.get();
  const prev = snap.exists() ? (snap.val() || {}) : {};
  const entry = {
    active: false,
    trial: false,
    forever: false,
    expiresAt: now - DAY_MS,
    createdAt: prev.createdAt || now,
    updatedAt: now,
    lastVisitAt: now - (COMEBACK_IDLE_DAYS + 1) * DAY_MS,
    note: 'comeback-prep',
    promoUsed: prev.promoUsed === true,
    promoUsedAt: prev.promoUsedAt || null
  };
  await ref.set(entry);
  await metaRef.set({ at: now, to: testId, lastVisitAt: entry.lastVisitAt, expiresAt: entry.expiresAt });
  console.log('comeback test prep done', testId);
}

/** Разово поправить тестовый comeback: в кабинете должно быть 6 дней (5 полных). */
async function fixComebackTestToSixDays() {
  if (!COMEBACK_TEST_ONLY) return;
  const metaRef = db.ref('bot_meta/comebackFix6V1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('comeback fix6 already done', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  const now = Date.now();
  const expiresAt = moscowMidnightPlusDays(now, COMEBACK_DAYS + 1);
  await subscriptionRef(testId).update({
    active: true,
    trial: true,
    trialDays: COMEBACK_DAYS,
    trialPlan: TRIAL_PLAN_TAG,
    forever: false,
    expiresAt: expiresAt,
    updatedAt: now,
    lastVisitAt: now,
    comebackGrantedAt: now,
    comebackUsed: true,
    note: 'comeback-5'
  });
  try {
    await telegramSendMessage(
      testId,
      'Поправила срок: снова ' + COMEBACK_DAYS + ' полных дней доступа (в кабинете будет 6) 💜',
      undefined
    );
  } catch (e) {
    console.error('comeback fix6 notify failed', e);
  }
  await metaRef.set({ at: now, to: testId, expiresAt: expiresAt });
  console.log('comeback fix6 done', testId, expiresAt);
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

// Ещё +1 день только старым (общий срок 6→7). Новых с 10 днями не трогаем.
async function extendTrialsPlusOneDayPaymentPending() {
  const metaRef = db.ref('bot_meta/trialExtendPlus1PaymentPendingV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('Legacy trial +1 day (payment pending) already done');
    return;
  }
  const oldLegacyExp = moscowMidnightPlusDays(LEGACY_TRIAL_ANCHOR_AT, 1 + LEGACY_TRIAL_DAYS_BEFORE);
  const newLegacyExp = legacyTrialExpiresAt();
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
    if (prev.forever || !prev.trial) {
      skipped += 1;
      continue;
    }
    const note = String(prev.note || '');
    if (note.indexOf('force-') === 0) {
      skipped += 1;
      continue;
    }
    const exp = typeof prev.expiresAt === 'number' ? prev.expiresAt : 0;
    // Только общий старый срок. Новых с 10 днями не трогаем.
    const isLegacyTrial = exp === oldLegacyExp || note.indexOf('legacy-trial') === 0;
    if (!isLegacyTrial) {
      skipped += 1;
      continue;
    }
    await subscriptionRef(uid).set({
      active: newLegacyExp > now,
      trial: true,
      trialDays: LEGACY_TRIAL_DAYS,
      trialPlan: TRIAL_PLAN_TAG,
      forever: false,
      expiresAt: newLegacyExp,
      createdAt: prev.createdAt || now,
      updatedAt: now,
      note: 'legacy-trial-plus1-paywait'
    });
    count += 1;
  }
  await metaRef.set({
    at: now,
    count: count,
    skipped: skipped,
    oldLegacyExp: oldLegacyExp,
    newLegacyExp: newLegacyExp
  });
  console.log('Legacy trial +1 day (payment pending)', {
    count: count,
    skipped: skipped,
    oldLegacyExp: oldLegacyExp,
    newLegacyExp: newLegacyExp
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
        // Не затираем уже оплаченный доступ (Stars / ручная выдача)
        if (
          prev &&
          prev.note !== 'force-expired-test' &&
          typeof prev.expiresAt === 'number' &&
          prev.expiresAt > now
        ) {
          return res.json(buildSubscriptionStatus(uid, prev, false));
        }
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
    let data = await ensureSubscriptionRecord(uid);
    data = await maybeApplyComebackGrant(uid, data);
    // lastVisit обновляем после comeback-проверки (иначе «только что зашёл» собьёт паузу 60 дней)
    await touchLastVisit(uid, data);
    return res.json(buildSubscriptionStatus(uid, data, false));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'subscription' });
  }
});

function startOfMoscowDay(ms) {
  const d = new Date(ms || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  return Date.parse(map.year + '-' + map.month + '-' + map.day + 'T00:00:00+03:00');
}

async function logPaymentEvent(ev) {
  ev = ev || {};
  const at = typeof ev.at === 'number' ? ev.at : Date.now();
  const userId = String(ev.userId || '').trim();
  if (!userId) return;
  const row = {
    at: at,
    userId: userId,
    method: String(ev.method || 'unknown'),
    days: Math.max(0, parseInt(ev.days, 10) || 0),
    stars: Math.max(0, parseInt(ev.stars, 10) || 0),
    amountRub: Math.max(0, Number(ev.amountRub) || 0),
    chargeId: ev.chargeId ? String(ev.chargeId) : null,
    payload: ev.payload ? String(ev.payload).slice(0, 128) : null,
    test: !!ev.test
  };
  const key = (row.chargeId || (userId + '_' + at + '_' + row.method)).replace(/[.#$/\[\]]/g, '_');
  try {
    await db.ref('payments/' + key).set(row);
  } catch (e) {
    console.error('payment log failed', e);
  }
}

function emptyPayBucket() {
  return {
    payments: 0,
    yookassa: 0,
    starsPayments: 0,
    people: 0,
    stars: 0,
    amountRub: 0,
    byDays: {},
    manual: 0,
    referralBonuses: 0
  };
}

function isTestPayment(p) {
  if (!p) return true;
  if (p.test) return true;
  const payload = String(p.payload || '');
  const chargeId = String(p.chargeId || '');
  if (payload.indexOf('stars_test:') === 0) return true;
  if (chargeId.indexOf('simulate_') === 0) return true;
  return false;
}

function addPayToBucket(bucket, p) {
  if (!p || isTestPayment(p)) return;
  if (String(p.method) === 'manual') {
    bucket.manual += 1;
    return;
  }
  bucket.payments += 1;
  if (String(p.method) === 'yookassa') bucket.yookassa += 1;
  else if (String(p.method) === 'stars') bucket.starsPayments += 1;
  bucket.stars += Math.max(0, parseInt(p.stars, 10) || 0);
  bucket.amountRub += Math.max(0, Number(p.amountRub) || 0);
  const d = String(Math.max(0, parseInt(p.days, 10) || 0));
  if (d !== '0') bucket.byDays[d] = (bucket.byDays[d] || 0) + 1;
}

async function collectPaymentStats() {
  const now = Date.now();
  const dayStart = startOfMoscowDay(now);
  const weekStart = dayStart - 6 * DAY_MS;
  const monthStart = dayStart - 29 * DAY_MS;

  const list = [];
  const seen = {};

  function pushPay(p) {
    if (!p || !p.userId) return;
    if (isTestPayment(p)) return;
    const method = String(p.method || 'unknown');
    // Карты: один платёж ЮKassa = один chargeId, без дублей от webhook/sync
    const charge = p.chargeId ? ('c:' + method + ':' + p.chargeId) : null;
    const fallback = 'u:' + p.userId + ':' + p.at + ':' + method + ':' + p.days;
    const key = charge || fallback;
    if (seen[key]) return;
    seen[key] = true;
    list.push(p);
  }

  const paySnap = await db.ref('payments').get();
  if (paySnap.exists()) {
    const all = paySnap.val() || {};
    Object.keys(all).forEach(function (k) {
      const row = all[k];
      // Карты считаем только из yookassa_payments — иначе дубли от webhook/sync
      if (row && String(row.method) === 'yookassa') return;
      pushPay(row);
    });
  }

  // ЮKassa: источник правды по картам
  const ykSnap = await db.ref('yookassa_payments').get();
  if (ykSnap.exists()) {
    const all = ykSnap.val() || {};
    Object.keys(all).forEach(function (paymentId) {
      const row = all[paymentId] || {};
      if (!(row.processed && row.granted === true)) return;
      const at = typeof row.processedAt === 'number'
        ? row.processedAt
        : (typeof row.createdAt === 'number' ? row.createdAt : 0);
      pushPay({
        at: at,
        userId: row.userId,
        method: 'yookassa',
        days: row.days || 30,
        stars: 0,
        amountRub: row.amountRub || 0,
        chargeId: paymentId,
        payload: 'yookassa:' + paymentId,
        test: false
      });
    });
  }

  // Старые оплаты Stars, пока писался только lastStarsPayment
  const subSnap = await db.ref('subscriptions').get();
  if (subSnap.exists()) {
    const all = subSnap.val() || {};
    Object.keys(all).forEach(function (uid) {
      const last = all[uid] && all[uid].lastStarsPayment;
      if (!last || typeof last.at !== 'number') return;
      const payload = String(last.payload || '');
      pushPay({
        at: last.at,
        userId: uid,
        method: 'stars',
        days: last.days || 0,
        stars: last.stars || 0,
        amountRub: 0,
        chargeId: last.chargeId || null,
        payload: payload || null,
        test: payload.indexOf('stars_test:') === 0
      });
    });
  }

  const day = emptyPayBucket();
  const week = emptyPayBucket();
  const month = emptyPayBucket();
  const allTime = emptyPayBucket();
  const peopleDay = {};
  const peopleWeek = {};
  const peopleMonth = {};
  const peopleAll = {};

  list.forEach(function (p) {
    if (!p || isTestPayment(p)) return;
    const at = typeof p.at === 'number' ? p.at : 0;
    addPayToBucket(allTime, p);
    if (String(p.method) !== 'manual') peopleAll[p.userId] = true;
    if (at >= monthStart) {
      addPayToBucket(month, p);
      if (String(p.method) !== 'manual') peopleMonth[p.userId] = true;
    }
    if (at >= weekStart) {
      addPayToBucket(week, p);
      if (String(p.method) !== 'manual') peopleWeek[p.userId] = true;
    }
    if (at >= dayStart) {
      addPayToBucket(day, p);
      if (String(p.method) !== 'manual') peopleDay[p.userId] = true;
    }
  });
  day.people = Object.keys(peopleDay).length;
  week.people = Object.keys(peopleWeek).length;
  month.people = Object.keys(peopleMonth).length;
  allTime.people = Object.keys(peopleAll).length;

  const refSnap = await db.ref('referrals').get();
  let refDay = 0;
  let refWeek = 0;
  let refMonth = 0;
  let refAll = 0;
  if (refSnap.exists()) {
    const refs = refSnap.val() || {};
    Object.keys(refs).forEach(function (friendId) {
      const r = refs[friendId] || {};
      if (!r.rewarded) return;
      refAll += 1;
      const at = typeof r.rewardedAt === 'number' ? r.rewardedAt : 0;
      if (at >= monthStart) refMonth += 1;
      if (at >= weekStart) refWeek += 1;
      if (at >= dayStart) refDay += 1;
    });
  }
  day.referralBonuses = refDay;
  week.referralBonuses = refWeek;
  month.referralBonuses = refMonth;
  allTime.referralBonuses = refAll;

  return {
    day: day,
    week: week,
    month: month,
    all: allTime,
    ranges: {
      dayFrom: dayStart,
      weekFrom: weekStart,
      monthFrom: monthStart
    }
  };
}

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

// Статистика оплат — только админ
app.get('/admin/payment-stats', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  try {
    const stats = await collectPaymentStats();
    return res.json({ ok: true, stats: stats });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'payment-stats' });
  }
});

// Последние оплаты ЮKassa (id, сумма, email) — только админ
app.get('/admin/yookassa-recent', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const snap = await db.ref('yookassa_payments').get();
    const all = snap.exists() ? (snap.val() || {}) : {};
    const list = Object.keys(all).map(function (pid) {
      const row = all[pid] || {};
      // Только реально оплаченные (созданные, но не оплаченные — не показываем)
      if (!(row.processed && row.granted === true)) return null;
      // Старые «ручные» оплаты скрыты из списка чеков — дни и статистика остаются
      if (row.omitFromReceipts) return null;
      return {
        paymentId: pid,
        userId: row.userId || null,
        amountRub: row.amountRub || 0,
        days: row.days || 0,
        email: row.email || null,
        processed: !!row.processed,
        granted: row.granted === true,
        receiptDone: !!row.receiptDone,
        receiptDoneAt: row.receiptDoneAt || null,
        receiptDoneBy: row.receiptDoneBy || null,
        receiptUrl: row.receiptUrl || null,
        receiptUuid: row.receiptUuid || null,
        receiptError: row.receiptError || null,
        receiptSentTg: !!row.receiptSentTg,
        receiptSentTgAt: row.receiptSentTgAt || null,
        receiptNotifyError: row.receiptNotifyError || null,
        createdAt: row.createdAt || 0,
        processedAt: row.processedAt || 0
      };
    }).filter(Boolean).sort(function (a, b) {
      return (b.processedAt || b.createdAt || 0) - (a.processedAt || a.createdAt || 0);
    }).slice(0, limit);
    return res.json({ ok: true, payments: list });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'yookassa-recent' });
  }
});

// Отметить «чек выдан» — только админ
app.post('/admin/yookassa-receipt-done', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  const paymentId = String((req.body && req.body.paymentId) || '').trim();
  if (!paymentId) return res.status(400).json({ error: 'paymentId' });
  const done = !(req.body && req.body.done === false);
  try {
    const ref = db.ref('yookassa_payments/' + paymentId);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ error: 'not-found' });
    const patch = {
      receiptDone: done,
      receiptDoneAt: done ? Date.now() : null,
      receiptDoneBy: String(user.id)
    };
    await ref.update(patch);
    return res.json({ ok: true, paymentId: paymentId, receiptDone: done });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'receipt-done' });
  }
});

// Выпустить авточек «Мой налог» по одной оплате — только админ
app.post('/admin/yookassa-receipt-issue', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  if (!moyNalogReady()) {
    return res.status(503).json({ error: 'moy-nalog-not-configured' });
  }
  const paymentId = String((req.body && req.body.paymentId) || '').trim();
  if (!paymentId) return res.status(400).json({ error: 'paymentId' });
  try {
    const snap = await db.ref('yookassa_payments/' + paymentId).get();
    if (!snap.exists()) return res.status(404).json({ error: 'not-found' });
    const row = snap.val() || {};
    const result = await issueMoyNalogReceiptForPayment({
      paymentId: paymentId,
      amountRub: row.amountRub,
      days: row.days || 30,
      userId: row.userId || '',
      operationAt: row.processedAt || row.createdAt || Date.now(),
      force: !!(req.body && req.body.force)
    });
    return res.json({ ok: !!result.ok, result: result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'receipt-issue' });
  }
});

app.get('/admin/moy-nalog-status', async function (req, res) {
  const user = authUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  return res.json({
    ok: true,
    ready: moyNalogReady(),
    loginSet: !!MOY_NALOG_LOGIN,
    passwordSet: !!MOY_NALOG_PASSWORD,
    serviceName: MOY_NALOG_SERVICE_NAME
  });
});

async function yookassaApi(method, path, body, idempotenceKey) {
  const auth = Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64');
  const headers = {
    Authorization: 'Basic ' + auth,
    'Content-Type': 'application/json'
  };
  if (idempotenceKey) headers['Idempotence-Key'] = String(idempotenceKey);
  const res = await fetch('https://api.yookassa.ru/v3' + path, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok) {
    const desc = data && (data.description || data.message) ? (data.description || data.message) : ('HTTP ' + res.status);
    const err = new Error('yookassa: ' + desc);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function grantPaidDaysFromYooKassa(uid, days, meta) {
  meta = meta || {};
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const prev = snap.exists() ? (snap.val() || {}) : {};
  const now = Date.now();
  if (prev.forever) {
    return { skipped: true, reason: 'forever' };
  }
  const amountRub = Math.max(0, Number(meta.amountRub) || 0);
  const forever = !!meta.forever;
  let entry;
  let paidDays = 0;
  if (forever) {
    entry = {
      active: true,
      trial: false,
      forever: true,
      expiresAt: null,
      paidDays: null,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
      note: 'yookassa-forever',
      promoUsed: true,
      promoUsedAt: (prev && prev.promoUsedAt) || now,
      comebackUsed: prev.comebackUsed === true,
      comebackGrantedAt: prev.comebackGrantedAt || null,
      lastCardPayment: {
        at: now,
        days: 0,
        forever: true,
        amountRub: amountRub,
        paymentId: meta.paymentId || null
      }
    };
  } else {
    paidDays = Math.max(1, parseInt(days, 10) || 30);
    const base = Math.max(now, typeof prev.expiresAt === 'number' ? prev.expiresAt : 0);
    const expiresAt = paidExpiresAtFrom(base, paidDays);
    entry = {
      active: true,
      trial: false,
      forever: false,
      expiresAt: expiresAt,
      paidDays: paidDays,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
      note: 'yookassa-paid',
      promoUsed: true,
      promoUsedAt: (prev && prev.promoUsedAt) || now,
      comebackUsed: prev.comebackUsed === true,
      comebackGrantedAt: prev.comebackGrantedAt || null,
      lastCardPayment: {
        at: now,
        days: paidDays,
        amountRub: amountRub,
        paymentId: meta.paymentId || null
      }
    };
  }
  await ref.set(entry);
  await logPaymentEvent({
    at: now,
    userId: uid,
    method: 'yookassa',
    days: forever ? 0 : paidDays,
    stars: 0,
    amountRub: amountRub,
    chargeId: meta.paymentId || null,
    payload: forever ? 'yookassa:forever' : ('yookassa:' + paidDays),
    test: false
  });
  try {
    await applyReferralBonusOnFirstPaid(uid);
  } catch (e) {
    console.error('yookassa referral bonus failed', uid, e);
  }
  return {
    skipped: false,
    forever: forever,
    expiresAt: forever ? null : entry.expiresAt,
    paidDays: forever ? null : paidDays
  };
}

/**
 * Авточек в «Мой налог» после успешной оплаты.
 * Не бросает наружу: оплата и дни уже выданы, чек — отдельно.
 * Если чек уже есть (receiptUuid / receiptDone) — повторно не создаём.
 */
async function issueMoyNalogReceiptForPayment(meta) {
  meta = meta || {};
  const paymentId = String(meta.paymentId || '').trim();
  const amountRub = Number(meta.amountRub) || 0;
  const days = Math.max(1, parseInt(meta.days, 10) || 30);
  const userId = String(meta.userId || '').trim();
  const force = !!meta.force;
  if (!paymentId || amountRub <= 0) {
    return { ok: false, reason: 'bad-meta' };
  }
  if (!moyNalogReady()) {
    return { ok: false, reason: 'not-configured' };
  }

  const lockRef = db.ref('yookassa_payments/' + paymentId);
  const snap = await lockRef.get();
  if (!snap.exists()) {
    return { ok: false, reason: 'not-found' };
  }
  let prev = snap.val() || {};

  const skipTgNotify = !!meta.skipTgNotify;

  async function resendReceiptTgIfNeeded(row) {
    let sentTg = !!row.receiptSentTg;
    if (skipTgNotify) return sentTg;
    if (!sentTg && userId && row.receiptUrl) {
      try {
        await telegramSendMessage(
          userId,
          receiptLinkHtml(row.receiptUrl),
          null,
          null,
          { parseMode: 'HTML' }
        );
        sentTg = true;
        await lockRef.update({
          receiptSentTg: true,
          receiptSentTgAt: Date.now(),
          receiptNotifyError: null
        });
      } catch (e) {
        const notifyMsg = String((e && e.message) || e).slice(0, 300);
        console.error('moy-nalog notify retry failed', userId, notifyMsg);
        await lockRef.update({
          receiptSentTg: false,
          receiptNotifyError: notifyMsg
        });
      }
    }
    return sentTg;
  }

  // Чек уже есть — если в ТГ не ушёл, досылаем ссылку
  if (!force && (prev.receiptUuid || prev.receiptDone) && prev.receiptUrl) {
    const sentTg = await resendReceiptTgIfNeeded(prev);
    return {
      ok: true,
      reason: 'already',
      printUrl: prev.receiptUrl || null,
      receiptId: prev.receiptUuid || null,
      sentTg: sentTg
    };
  }

  // Уже дергали addIncome по этой оплате — второй раз в налоговую НЕ идём
  // (иначе появляются дубли в «Мой налог»). Повтор только с force.
  if (!force && prev.receiptIncomeRequested) {
    if (prev.receiptUrl) {
      const sentTg = await resendReceiptTgIfNeeded(prev);
      return {
        ok: true,
        reason: 'already',
        printUrl: prev.receiptUrl,
        receiptId: prev.receiptUuid || null,
        sentTg: sentTg
      };
    }
    return {
      ok: false,
      reason: 'already-requested',
      error: prev.receiptError || 'Чек в налоговую уже запрашивали по этой оплате'
    };
  }

  if (!force && prev.receiptPending) {
    const pendingAt = Number(prev.receiptPendingAt) || 0;
    if (pendingAt && (Date.now() - pendingAt) < 2 * 60 * 1000) {
      return { ok: false, reason: 'pending' };
    }
  }

  // Атомарный захват: только один процесс может вызвать addIncome
  let claimed = false;
  try {
    const tx = await lockRef.transaction(function (cur) {
      const row = cur || {};
      if (!force) {
        if (row.receiptUuid || row.receiptDone || row.receiptIncomeRequested) {
          return; // abort
        }
        if (row.receiptPending) {
          const pendingAt = Number(row.receiptPendingAt) || 0;
          if (pendingAt && (Date.now() - pendingAt) < 2 * 60 * 1000) {
            return; // abort
          }
        }
      }
      row.receiptPending = true;
      row.receiptPendingAt = Date.now();
      row.receiptIncomeRequested = true;
      row.receiptIncomeRequestedAt = Date.now();
      row.receiptError = null;
      return row;
    });
    claimed = !!(tx && tx.committed);
    if (tx && tx.snapshot) prev = tx.snapshot.val() || prev;
  } catch (e) {
    console.error('moy-nalog claim failed', paymentId, e);
    return { ok: false, reason: 'claim-failed' };
  }
  if (!claimed) {
    if (prev.receiptUrl) {
      const sentTg = await resendReceiptTgIfNeeded(prev);
      return {
        ok: true,
        reason: 'already',
        printUrl: prev.receiptUrl,
        receiptId: prev.receiptUuid || null,
        sentTg: sentTg
      };
    }
    return { ok: false, reason: 'pending' };
  }

  const api = getMoyNalogClient();
  if (!api) {
    await lockRef.update({ receiptPending: null, receiptError: 'not-configured' });
    return { ok: false, reason: 'not-configured' };
  }

  const serviceName = meta.forever
    ? (MOY_NALOG_SERVICE_NAME + ' (бессрочно)')
    : (MOY_NALOG_SERVICE_NAME + ' на ' + days + ' дн.');
  let opDate = new Date();
  if (meta.operationAt) {
    const d = new Date(meta.operationAt);
    if (!Number.isNaN(d.getTime())) opDate = d;
  } else if (prev.processedAt) {
    const d = new Date(prev.processedAt);
    if (!Number.isNaN(d.getTime())) opDate = d;
  }

  let receipt;
  try {
    await ensureMoyNalogAuth(api);
    receipt = await moyNalogAddIncomeMoscow(api, {
      name: serviceName,
      amount: amountRub,
      quantity: 1,
      date: opDate
    });
  } catch (e) {
    const msg = friendlyMoyNalogError((e && e.message) || e).slice(0, 500);
    console.error('moy-nalog addIncome failed', paymentId, msg);
    resetMoyNalogClient();
    const authFail = /не найдено|вход|парол|авториз|auth|login|token/i.test(msg);
    // Ошибка входа — чек в налоговую скорее не ушёл, можно повторить после правки пароля.
    // Любая другая ошибка после запроса — флаг оставляем, чтобы не плодить дубли.
    await lockRef.update({
      receiptPending: null,
      receiptError: msg,
      receiptErrorAt: Date.now(),
      receiptIncomeRequested: authFail ? null : true
    });
    return { ok: false, reason: 'api', error: msg };
  }

  if (!receipt || receipt.error || !receipt.printUrl) {
    const msg = 'no-receipt: ' + JSON.stringify(receipt && receipt.error ? receipt.error : receipt).slice(0, 400);
    console.error('moy-nalog no receipt', paymentId, msg);
    await lockRef.update({
      receiptPending: null,
      receiptError: msg,
      receiptErrorAt: Date.now()
    });
    return { ok: false, reason: 'no-receipt', error: msg };
  }

  const receiptId = String(receipt.id || receipt.approvedReceiptUuid || '');
  const printUrl = String(receipt.printUrl || '');
  await lockRef.update({
    receiptPending: null,
    receiptDone: true,
    receiptDoneAt: Date.now(),
    receiptDoneBy: 'auto-moy-nalog',
    receiptUuid: receiptId,
    receiptUrl: printUrl,
    receiptError: null
  });

  let sentTg = false;
  if (!skipTgNotify && userId && printUrl) {
    try {
      await telegramSendMessage(
        userId,
        receiptLinkHtml(printUrl),
        null,
        null,
        { parseMode: 'HTML' }
      );
      sentTg = true;
      await lockRef.update({
        receiptSentTg: true,
        receiptSentTgAt: Date.now(),
        receiptNotifyError: null
      });
    } catch (e) {
      const notifyMsg = String((e && e.message) || e).slice(0, 300);
      console.error('moy-nalog notify failed', userId, notifyMsg);
      await lockRef.update({
        receiptSentTg: false,
        receiptNotifyError: notifyMsg
      });
    }
  }
  console.log('moy-nalog receipt ok', paymentId, receiptId, 'tg=' + sentTg, 'skipTg=' + skipTgNotify);
  return { ok: true, printUrl: printUrl, receiptId: receiptId, sentTg: sentTg };
}

async function processYooKassaSucceededPayment(payment, opts) {
  opts = opts || {};
  if (!payment || payment.status !== 'succeeded') {
    return { ok: false, reason: 'not-succeeded', status: payment && payment.status };
  }
  const paymentId = String(payment.id || '');
  if (!paymentId) return { ok: false, reason: 'no-id' };

  const lockRef = db.ref('yookassa_payments/' + paymentId);
  const lockSnap = await lockRef.get();
  const prev = lockSnap.exists() ? (lockSnap.val() || {}) : {};
  const meta = payment.metadata || {};
  const uid = String(meta.userId || prev.userId || '');
  const amountRub = Math.round(Number((payment.amount && payment.amount.value) || meta.amountRub || prev.amountRub || 0));

  // Уже выдали дни — не начисляем повторно, но чек/ТГ всё ещё можно дослать
  if (prev.processed && !opts.force) {
    let receipt = null;
    try {
      const forever = !!(prev.forever || String(meta.forever || '') === '1');
      const days = forever ? 0 : (parseInt(prev.days, 10) || parseInt(meta.days, 10) || 30);
      receipt = await issueMoyNalogReceiptForPayment({
        paymentId: paymentId,
        amountRub: amountRub || Number(prev.amountRub) || 0,
        days: days,
        forever: forever,
        userId: uid || String(prev.userId || ''),
        operationAt: (payment && payment.captured_at) || prev.processedAt || Date.now()
      });
      if (!receipt.ok && receipt.reason !== 'already' && receipt.reason !== 'not-configured') {
        console.error('moy-nalog after already-paid', paymentId, receipt);
      }
    } catch (e) {
      console.error('moy-nalog after already-paid error', paymentId, e);
    }
    return {
      ok: true,
      reason: 'already',
      userId: uid || prev.userId || null,
      grantedBefore: prev.granted === true,
      amountRub: amountRub || prev.amountRub || null,
      receipt: receipt
    };
  }

  if (!uid) {
    await lockRef.update({ status: 'succeeded', error: 'no-user', at: Date.now() });
    return { ok: false, reason: 'no-user' };
  }

  // Сумма: только предупреждение, не блокируем выдачу (из‑за этого уже терялись дни)
  if (prev.amountRub && Number(prev.amountRub) !== amountRub) {
    console.error('yookassa amount mismatch (continue)', paymentId, prev.amountRub, amountRub);
  }

  // Дни строго по тарифу: metadata + сверка с оплаченной суммой
  const planGrant = resolveGrantPlanFromPayment(meta, prev, amountRub);
  const forever = !!planGrant.forever;
  const days = forever ? 0 : planGrant.days;

  const granted = await grantPaidDaysFromYooKassa(uid, days, {
    paymentId: paymentId,
    amountRub: amountRub,
    forever: forever
  });
  await lockRef.update({
    status: 'succeeded',
    processed: true,
    processedAt: Date.now(),
    userId: uid,
    days: days,
    forever: forever,
    promo: !!planGrant.promo,
    amountRub: amountRub,
    granted: !granted.skipped
  });
  // Сначала чек — чтобы ссылку вставить в то же сообщение об успешной оплате
  let receipt = null;
  try {
    receipt = await issueMoyNalogReceiptForPayment({
      paymentId: paymentId,
      amountRub: amountRub,
      days: forever ? 0 : days,
      forever: forever,
      userId: uid,
      operationAt: (payment && payment.captured_at) || Date.now(),
      skipTgNotify: true
    });
    if (!receipt.ok && receipt.reason !== 'already' && receipt.reason !== 'not-configured') {
      console.error('moy-nalog after pay', paymentId, receipt);
    }
  } catch (e) {
    console.error('moy-nalog after pay error', paymentId, e);
  }
  if (!granted.skipped) {
    try {
      const receiptUrl = (receipt && receipt.ok && receipt.printUrl) ? receipt.printUrl : null;
      const thanks = await sendPaidThanksToUser(uid, forever ? 'forever' : days, receiptUrl);
      if (!thanks.sent) console.error('yookassa thanks failed', uid, thanks);
      else if (thanks.withReceipt) {
        await lockRef.update({
          receiptSentTg: true,
          receiptSentTgAt: Date.now(),
          receiptNotifyError: null
        });
      }
    } catch (e) {
      console.error('yookassa thanks error', uid, e);
    }
  }
  console.log('yookassa payment ok', uid, forever ? 'forever' : days, amountRub, paymentId);
  return { ok: true, granted: granted, receipt: receipt };
}

// Статус ЮKassa (без авторизации) — чтобы кнопка оплаты включалась сразу
app.get('/payment/yookassa/status', function (req, res) {
  const ready = yookassaReady();
  return res.json({ ok: true, ready: ready, paymentLive: ready, shopId: ready ? YOOKASSA_SHOP_ID : null });
});

// Создать платёж ЮKassa: promo / 30|60|90|180 / forever
app.post('/payment/yookassa/create', async function (req, res) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  if (!yookassaReady()) return res.status(503).json({ error: 'yookassa-not-ready' });
  try {
    const uid = String(user.id);
    const subSnap = await subscriptionRef(uid).get();
    const subData = subSnap.exists() ? subSnap.val() : null;
    const price = pricingInfoForUser(subData, Date.now(), uid);
    const plan = resolveYooKassaPlan(req.body || {}, price);
    if (plan.error) {
      return res.status(400).json({ error: plan.error });
    }
    const amountRub = Number(plan.amountRub) || 0;
    const amountValue = amountRub.toFixed(2);
    const days = plan.forever ? 0 : plan.days;
    // Свой выбор способа: sbp / bank_card / yoo_money — тогда ЮKassa
    // сразу открывает нужный сценарий (СБП не уезжает вниз в общем виджете).
    const rawMethod = String((req.body && (req.body.method || req.body.paymentMethod)) || '')
      .trim()
      .toLowerCase();
    const allowedMethods = { sbp: 1, bank_card: 1, yoo_money: 1 };
    const paymentMethod = allowedMethods[rawMethod] ? rawMethod : '';

    const body = {
      amount: { value: amountValue, currency: 'RUB' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: YOOKASSA_RETURN_URL
      },
      description: 'Подписка на чек-лист BTS, ' + plan.label,
      metadata: {
        userId: uid,
        days: String(days),
        forever: plan.forever ? '1' : '0',
        amountRub: String(amountRub),
        promo: plan.promo ? '1' : '0',
        method: paymentMethod || 'any'
      }
    };
    if (paymentMethod) {
      body.payment_method_data = { type: paymentMethod };
    }

    const idempotenceKey = crypto.randomUUID();
    const payment = await yookassaApi('POST', '/payments', body, idempotenceKey);
    const confirmationUrl = payment && payment.confirmation && payment.confirmation.confirmation_url;
    if (!confirmationUrl) {
      return res.status(502).json({ error: 'no-confirmation-url', payment: payment });
    }
    await db.ref('yookassa_payments/' + payment.id).set({
      userId: uid,
      days: days,
      forever: !!plan.forever,
      amountRub: amountRub,
      promo: !!plan.promo,
      method: paymentMethod || null,
      status: payment.status || 'pending',
      createdAt: Date.now(),
      confirmationUrl: confirmationUrl
    });
    return res.json({
      ok: true,
      paymentId: payment.id,
      confirmationUrl: confirmationUrl,
      amountRub: amountRub,
      days: days,
      forever: !!plan.forever,
      promo: !!plan.promo,
      method: paymentMethod || null
    });
  } catch (e) {
    console.error('yookassa create failed', e && e.data ? e.data : e);
    return res.status(500).json({
      error: 'yookassa-create',
      message: String(e.message || e)
    });
  }
});

async function syncRecentYooKassaPayments(limit) {
  if (!yookassaReady()) return { ok: false, reason: 'not-ready', processed: 0 };
  const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
  const data = await yookassaApi('GET', '/payments?limit=' + lim + '&status=succeeded', null, null);
  const items = (data && data.items) || [];
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const payment = items[i];
    try {
      const r = await processYooKassaSucceededPayment(payment);
      results.push({
        paymentId: payment && payment.id,
        reason: r && r.reason,
        ok: !!(r && r.ok),
        granted: !!(r && r.granted && !r.granted.skipped),
        userId: (r && r.userId) || (payment.metadata && payment.metadata.userId) || null,
        grantedBefore: r && r.grantedBefore
      });
    } catch (e) {
      results.push({
        paymentId: payment && payment.id,
        ok: false,
        error: String((e && e.message) || e)
      });
    }
  }
  return { ok: true, checked: items.length, results: results };
}

/**
 * Разово убрать старые оплаты из списка «Чеки» (до авточеков).
 * Сами записи и дни доступа не трогаем — только omitFromReceipts.
 */
/**
 * Разово: +30 дней первому оплатившему (6921049406).
 */
async function grantBonusDaysToFirstPayer() {
  const targetId = '6921049406';
  const bonusDays = 30;
  const metaRef = db.ref('bot_meta/firstPayerBonus30V1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('first payer bonus already done', metaSnap.val());
    return;
  }
  const result = await extendSubscriptionByDays(targetId, bonusDays);
  if (result.skipped) {
    await metaRef.set({ at: Date.now(), to: targetId, skipped: true, reason: result.reason || 'skipped' });
    console.log('first payer bonus skipped', targetId, result);
    return;
  }
  try {
    await telegramSendMessage(
      targetId,
      'Спасибо, что были среди первых 💜\n\nВам начислено ещё +' + bonusDays + ' дней доступа.',
      undefined
    );
  } catch (e) {
    console.error('first payer bonus notify failed', targetId, e);
  }
  await metaRef.set({
    at: Date.now(),
    to: targetId,
    days: bonusDays,
    expiresAt: result.expiresAt || null
  });
  console.log('first payer bonus done', targetId, result);
}

async function hideOldNonAutoReceiptPayments() {
  // V3: убрать из списка неудачный тест (чек не сформирован) и прочие без авточека
  const metaRef = db.ref('bot_meta/receiptsListClearedV3');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('receipts list clear V3 already done', metaSnap.val());
    return;
  }
  const snap = await db.ref('yookassa_payments').get();
  const all = snap.exists() ? (snap.val() || {}) : {};
  const hidden = [];
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length; i++) {
    const paymentId = keys[i];
    const row = all[paymentId] || {};
    // В списке чеков оставляем только реальные авточеки «Мой налог»
    if (String(row.receiptDoneBy || '') === 'auto-moy-nalog' && row.receiptUrl) continue;
    if (row.omitFromReceipts) continue;
    await db.ref('yookassa_payments/' + paymentId).update({
      omitFromReceipts: true,
      omitFromReceiptsAt: Date.now()
    });
    hidden.push(paymentId);
  }
  await metaRef.set({ at: Date.now(), hidden: hidden.length, ids: hidden });
  console.log('receipts list cleared old non-auto V3', hidden.length, hidden);
}

async function forceReprocessKnownYooKassaPayments() {
  if (!yookassaReady()) return;
  const metaRef = db.ref('bot_meta/yookassaForceReprocessV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('yookassa force reprocess already done', metaSnap.val());
    return;
  }
  const ids = [
    '3286c358-000f-5000-b000-18305de47b2d',
    '3286c345-000f-5001-9000-1a9e484fb186'
  ];
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const paymentId = ids[i];
    try {
      const lockSnap = await db.ref('yookassa_payments/' + paymentId).get();
      const prev = lockSnap.exists() ? (lockSnap.val() || {}) : {};
      // Уже реально выдали дни — не начисляем второй раз
      if (prev.processed && prev.granted === true) {
        results.push({
          paymentId: paymentId,
          ok: true,
          reason: 'already-granted',
          userId: prev.userId || null
        });
        continue;
      }
      const payment = await yookassaApi('GET', '/payments/' + paymentId, null, null);
      const r = await processYooKassaSucceededPayment(payment, { force: true });
      results.push({
        paymentId: paymentId,
        ok: !!(r && r.ok),
        reason: r && r.reason,
        userId: (payment.metadata && payment.metadata.userId) || prev.userId || null,
        skipped: !!(r && r.granted && r.granted.skipped),
        paidDays: r && r.granted && r.granted.paidDays
      });
    } catch (e) {
      results.push({
        paymentId: paymentId,
        ok: false,
        error: String((e && e.message) || e)
      });
    }
  }
  await metaRef.set({ at: Date.now(), results: results });
  console.log('yookassa force reprocess done', results);
}

// Догонка платежей (если webhook не дошёл). С авторизацией Telegram.
app.post('/payment/yookassa/sync', async function (req, res) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  if (!yookassaReady()) return res.status(503).json({ error: 'yookassa-not-ready' });
  try {
    const uid = String(user.id);
    const wantId = String((req.body && req.body.paymentId) || '').trim();
    if (wantId) {
      const payment = await yookassaApi('GET', '/payments/' + wantId, null, null);
      const metaUid = payment && payment.metadata && String(payment.metadata.userId || '');
      const lockSnap = await db.ref('yookassa_payments/' + wantId).get();
      const prevUid = lockSnap.exists() ? String((lockSnap.val() || {}).userId || '') : '';
      if (metaUid && metaUid !== uid && prevUid && prevUid !== uid && !user.isAdmin) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const r = await processYooKassaSucceededPayment(payment);
      return res.json({ ok: true, mode: 'one', result: r });
    }
    // Все свежие succeeded + свои записи в Firebase
    const recent = await syncRecentYooKassaPayments(30);
    const snap = await db.ref('yookassa_payments').get();
    const all = snap.exists() ? (snap.val() || {}) : {};
    const mine = [];
    Object.keys(all).forEach(function (pid) {
      const row = all[pid] || {};
      if (String(row.userId) === uid && !row.processed) mine.push(pid);
    });
    for (let i = 0; i < mine.length; i++) {
      try {
        const payment = await yookassaApi('GET', '/payments/' + mine[i], null, null);
        const r = await processYooKassaSucceededPayment(payment);
        mine[i] = { paymentId: mine[i], result: r };
      } catch (e) {
        mine[i] = { paymentId: mine[i], error: String((e && e.message) || e) };
      }
    }
    return res.json({ ok: true, mode: 'sync', recent: recent, mine: mine });
  } catch (e) {
    console.error('yookassa sync failed', e && e.data ? e.data : e);
    return res.status(500).json({ error: 'yookassa-sync', message: String(e.message || e) });
  }
});

// HTTP-уведомления ЮKassa
app.post('/yookassa/webhook', async function (req, res) {
  try {
    const event = req.body || {};
    console.log('yookassa webhook event', event.event, event.object && event.object.id, event.object && event.object.status);
    if (event.event !== 'payment.succeeded') {
      return res.status(200).json({ ok: true, ignored: true });
    }
    const object = event.object || {};
    const paymentId = String(object.id || '');
    if (!paymentId || !yookassaReady()) {
      console.error('yookassa webhook skip', { paymentId: paymentId, ready: yookassaReady() });
      return res.status(200).json({ ok: true });
    }
    // Перепроверяем платёж в API ЮKassa (не доверяем телу уведомления вслепую)
    let payment = object;
    try {
      payment = await yookassaApi('GET', '/payments/' + paymentId, null, null);
    } catch (e) {
      console.error('yookassa webhook fetch failed', paymentId, e);
      return res.status(500).json({ error: 'fetch' });
    }
    const result = await processYooKassaSucceededPayment(payment);
    console.log('yookassa webhook processed', paymentId, result);
    return res.status(200).json({ ok: true, result: result });
  } catch (e) {
    console.error('yookassa webhook error', e);
    return res.status(500).json({ error: 'webhook' });
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
        grantedBy: String(user.id),
        promoUsed: true,
        promoUsedAt: (prev && prev.promoUsedAt) || now
      };
    }
    await ref.set(entry);
    if (!forever) {
      await logPaymentEvent({
        at: now,
        userId: targetId,
        method: 'manual',
        days: entry.paidDays || days || 30,
        stars: 0,
        amountRub: 0,
        chargeId: null,
        payload: 'manual:' + String(user.id),
        test: false
      });
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
const PAYMENT_LINK = 'https://t.me/army_checklist_bot?startapp=payment';
const REFERRAL_LINK = 'https://t.me/army_checklist_bot?startapp=friend';
const HELP_TEXT =
  'Команды бота:\n' +
  '/app — открыть чек-лист\n' +
  '/cabinet — личный кабинет\n' +
  '/pay — страница оплаты\n' +
  '/friend — акция «Приведи друга»\n' +
  '/support — написать в поддержку\n' +
  '/help — это меню\n\n' +
  'Приложение также открывается кнопкой снизу «For ARMY 💜»';
const FRIEND_CMD_TEXT =
  'Акция «Приведи друга» 💜\n\n' +
  'Отправьте подруге свою ссылку. Если она раньше не пользовалась чек-листом и потом оплатит подписку — вам обоим по +30 дней.\n\n' +
  'Ваша ссылка:\n';
const START_TEXT =
  'Просто откройте приложение по кнопке снизу "For ARMY 💜"\n\n' +
  '/help\n\n' +
  'При возникновении вопросов — /support или слово «поддержка»';
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

function escapeHtmlTg(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function paidThanksCaption(days, receiptUrl) {
  let text;
  if (days === 'forever' || days === 0 || days === '0') {
    text =
      'Подписка успешно оплачена — доступ бессрочный ☺️\n\n' +
      'Спасибо, что поддерживаете данный проект и архив 🫶';
  } else {
    const n = Math.max(1, parseInt(days, 10) || 30);
    text =
      'Подписка успешно была оплачена и продлена на ' + n + ' ' + pluralDaysRu(n) + ' ☺️\n\n' +
      'Спасибо, что поддерживаете данный проект и архив 🫶';
  }
  const url = String(receiptUrl || '').trim();
  if (url) {
    text +=
      '\n\n<a href="' +
      escapeHtmlTg(url).replace(/"/g, '') +
      '">Ваш чек об оплате</a> 💜';
  }
  return text;
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

async function telegramSendMessage(chatId, text, button, replyToMsgId, opts) {
  // button === undefined → кнопка «Личный кабинет»
  // button === null → без кнопок
  opts = opts || {};
  if (button === undefined) button = { text: 'Личный кабинет', url: CABINET_LINK };
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  };
  if (opts.parseMode) payload.parse_mode = opts.parseMode;
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

// Админ reply на тикет: /stars 30  или  /stars 100 30
// Обычные цены Stars. На акции (−50% как в рублях) 30 дней = 50 вместо 100.
const STARS_FULL_BY_DAYS = {
  1: 1,
  30: 100,
  60: 180,
  90: 250,
  180: 450
};
const STARS_PROMO_BY_DAYS = {
  1: 1,
  30: 50,
  60: 90,
  90: 125,
  180: 225
};

function starsPriceForDays(days, now, subData, uid) {
  const d = Math.max(1, parseInt(days, 10) || 30);
  const price = subData !== undefined
    ? pricingInfoForUser(subData, now || Date.now(), uid)
    : pricingInfo(now || Date.now());
  const table = price.promo ? STARS_PROMO_BY_DAYS : STARS_FULL_BY_DAYS;
  if (table[d]) return { stars: table[d], days: d, promo: !!price.promo };
  return { stars: Math.max(1, d), days: d, promo: !!price.promo };
}

function parseStarsAdminCommand(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\/stars(?:@\w+)?(?:\s+(\d+))?(?:\s+(\d+))?$/i);
  if (!m) return null;
  const price = pricingInfo(Date.now());
  if (!m[1]) {
    const p30 = starsPriceForDays(30);
    return {
      help: true,
      text:
        'Как выставить счёт Stars (reply на сообщение человека):\n' +
        '• /stars 30 — 30 дней по цене этого человека (акция только если ещё не покупал)\n' +
        '• /stars 100 30 — явно 100 Stars за 30 дней\n' +
        '• /stars 50 30 — явно 50 Stars за 30 дней\n\n' +
        'Акция −50% один раз на первую оплату.\n' +
        (price.promo
          ? 'Окно акции открыто: 30→50 Stars (если человек ещё не покупал)\nОбычно: 30→100, 60→180, 90→250, 180→450'
          : 'Сейчас обычные цены: 30→100, 60→180, 90→250, 180→450')
    };
  }
  if (m[2]) {
    return {
      stars: Math.max(1, parseInt(m[1], 10) || 1),
      days: Math.max(1, parseInt(m[2], 10) || 30),
      promo: false,
      explicit: true
    };
  }
  const priced = starsPriceForDays(m[1]);
  return { stars: priced.stars, days: priced.days, promo: priced.promo, explicit: false };
}

async function sendStarsInvoiceToUser(userId, stars, days, meta) {
  const payload = ('stars:' + days + ':' + userId + ':' + Date.now()).slice(0, 128);
  const promoMark = meta && meta.promo ? ' (акция −50%)' : '';
  await telegramSendMessage(
    userId,
    'Вам выставили счёт на оплату 💜\n' +
      stars + ' Stars = ' + days + ' ' + pluralDaysRu(days) + promoMark + '.\n' +
      'Нажмите Pay на сообщении ниже.',
    null
  );
  await telegramSendStarsInvoice(userId, {
    title: days + ' ' + pluralDaysRu(days),
    description: 'Подписка на чек-лист по BTS',
    label: days + ' ' + pluralDaysRu(days),
    stars: stars,
    days: days,
    payload: payload
  });
  try {
    await db.ref('stars_invoices/' + userId + '/' + Date.now()).set({
      stars: stars,
      days: days,
      payload: payload,
      at: Date.now(),
      byAdmin: meta && meta.byAdmin ? String(meta.byAdmin) : null
    });
  } catch (e) {
    console.error('stars invoice log failed', e);
  }
  return { payload: payload, stars: stars, days: days };
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

  const starsCmd = parseStarsAdminCommand(answer);
  if (starsCmd) {
    if (starsCmd.help) {
      await telegramSendMessage(msg.chat.id, starsCmd.text, null);
      return true;
    }
    try {
      let stars = starsCmd.stars;
      let days = starsCmd.days;
      let promo = !!starsCmd.promo;
      if (!starsCmd.explicit) {
        const subSnap = await subscriptionRef(userId).get();
        const priced = starsPriceForDays(days, Date.now(), subSnap.exists() ? subSnap.val() : null, userId);
        stars = priced.stars;
        days = priced.days;
        promo = !!priced.promo;
      }
      await sendStarsInvoiceToUser(userId, stars, days, {
        byAdmin: msg.from.id,
        promo: promo
      });
      await telegramSendMessage(
        msg.chat.id,
        '✓ Счёт Stars отправлен пользователю ' + userId + ':\n' +
          stars + ' Stars → ' + days + ' ' + pluralDaysRu(days) +
          (promo ? ' (акция −50%, первый раз)' : ''),
        null
      );
    } catch (e) {
      console.error('admin stars invoice failed', userId, e);
      await telegramSendMessage(
        msg.chat.id,
        'Не удалось отправить счёт: ' + String(e.message || e),
        null
      );
    }
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

async function telegramSendPhoto(chatId, caption, photoPath, opts) {
  opts = opts || {};
  const filePath = photoPath || PAID_THANKS_PHOTO;
  if (!fs.existsSync(filePath)) {
    throw new Error('telegram-photo: file missing ' + filePath);
  }
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', String(caption || ''));
  form.append('disable_notification', 'false');
  if (opts.parseMode) form.append('parse_mode', String(opts.parseMode));
  form.append('photo', new Blob([buf], { type: 'image/jpeg' }), path.basename(filePath) || 'photo.jpg');
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendPhoto';
  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    const desc = data && data.description ? data.description : ('HTTP ' + res.status);
    throw new Error('telegram-photo: ' + desc);
  }
  return data;
}

async function sendPaidThanksToUser(uid, days, receiptUrl) {
  const hasLink = !!String(receiptUrl || '').trim();
  const caption = paidThanksCaption(days, receiptUrl);
  try {
    await telegramSendPhoto(uid, caption, PAID_THANKS_PHOTO, hasLink ? { parseMode: 'HTML' } : null);
    return { sent: true, days: Math.max(1, parseInt(days, 10) || 30), withReceipt: hasLink };
  } catch (e) {
    return { sent: false, reason: 'telegram', error: String(e.message || e) };
  }
}

function receiptLinkHtml(printUrl) {
  const url = String(printUrl || '').trim();
  if (!url) return '';
  return '<a href="' + escapeHtmlTg(url).replace(/"/g, '') + '">Ваш чек об оплате</a> 💜';
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
      errors.push({ uid: uid, error: String((e && e.message) || e) });
    }
  }
  if (errors.length) {
    console.error('subscription reminders partial errors', errors.slice(0, 20));
  }
  return {
    checked: ids.length,
    lastDaySent: lastDaySent,
    expiredSent: expiredSent,
    errorCount: errors.length,
    errors: errors.slice(0, 20)
  };
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

    // Ссылка с оплаты: t.me/...?start=support → сразу режим поддержки
    if (/^(support|podderzhka)$/i.test(String(payload || '').trim())) {
      try {
        await openSupportSession(String(fromId), {
          awaitingFirst: true,
          lastUserTextAt: Date.now()
        });
        await telegramSendMessage(msg.chat.id, SUPPORT_ASK_TEXT, null);
        return true;
      } catch (supportStartErr) {
        console.error('start support payload failed', fromId, supportStartErr);
      }
    }

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

async function handleMenuCommands(msg) {
  if (!msg || !msg.chat || !msg.from) return false;
  if (msg.chat.type !== 'private') return false;
  const text = String(msg.text || '').trim();
  // /stars без reply — только подсказка админу (счёт выставляется reply на тикет)
  if (isAdminTelegramId(msg.from.id)) {
    const starsAlone = parseStarsAdminCommand(text);
    if (starsAlone && starsAlone.help && !msg.reply_to_message) {
      try {
        await telegramSendMessage(msg.chat.id, starsAlone.text, null);
      } catch (e) {
        console.error('stars help failed', e);
      }
      return true;
    }
  }
  const m = text.match(/^\/(help|menu|app|checklist|cabinet|kabinet|pay|payment|oplata|friend|referral|invite)(?:@\w+)?(?:\s|$)/i);
  if (!m) return false;
  const cmd = String(m[1] || '').toLowerCase();
  try {
    if (cmd === 'help' || cmd === 'menu') {
      await telegramSendMessage(msg.chat.id, HELP_TEXT, null);
      return true;
    }
    if (cmd === 'app' || cmd === 'checklist') {
      await telegramSendMessage(msg.chat.id, 'Открыть чек-лист 👇', {
        text: 'For ARMY 💜',
        url: BOT_APP_LINK
      });
      return true;
    }
    if (cmd === 'cabinet' || cmd === 'kabinet') {
      await telegramSendMessage(msg.chat.id, 'Личный кабинет 👇', {
        text: 'Личный кабинет',
        url: CABINET_LINK
      });
      return true;
    }
    if (cmd === 'pay' || cmd === 'payment' || cmd === 'oplata') {
      await telegramSendMessage(msg.chat.id, 'Страница оплаты 👇', {
        text: 'Оплата подписки',
        url: PAYMENT_LINK
      });
      return true;
    }
    if (cmd === 'friend' || cmd === 'referral' || cmd === 'invite') {
      const uid = msg.from && msg.from.id;
      const link = uid
        ? ('https://t.me/army_checklist_bot?start=ref_' + uid)
        : REFERRAL_LINK;
      await telegramSendMessage(msg.chat.id, FRIEND_CMD_TEXT + link, {
        text: 'Приведи друга',
        url: REFERRAL_LINK
      });
      return true;
    }
  } catch (e) {
    console.error('menu command failed', cmd, e);
  }
  return true;
}

async function handleBotMessage(msg) {
  if (!msg) return;
  try {
    if (await handleSupportFlow(msg)) return;
    if (await handleMenuCommands(msg)) return;
    await handleStartCommand(msg);
  } catch (e) {
    console.error('bot message handle error', e);
  }
}

async function telegramApi(method, body) {
  const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    const desc = data && data.description ? data.description : ('HTTP ' + res.status);
    throw new Error('telegram ' + method + ': ' + desc);
  }
  return data;
}

async function telegramSendStarsInvoice(chatId, options) {
  options = options || {};
  const stars = Math.max(1, parseInt(options.stars, 10) || 1);
  const days = Math.max(1, parseInt(options.days, 10) || 30);
  const payload = String(options.payload || ('stars:' + days + ':' + chatId + ':' + Date.now())).slice(0, 128);
  return telegramApi('sendInvoice', {
    chat_id: chatId,
    title: String(options.title || 'Подписка').slice(0, 32),
    description: String(options.description || ('Доступ на ' + days + ' дн.')).slice(0, 255),
    payload: payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: String(options.label || (days + ' дней')).slice(0, 32), amount: stars }]
  });
}

async function answerPreCheckoutQuery(queryId, ok, errorMessage) {
  const body = {
    pre_checkout_query_id: String(queryId),
    ok: !!ok
  };
  if (!ok && errorMessage) body.error_message = String(errorMessage).slice(0, 200);
  return telegramApi('answerPreCheckoutQuery', body);
}

function parseStarsPayload(payload) {
  // stars:<days>:<uid>:<ts>  или stars_test:<days>:...
  const parts = String(payload || '').split(':');
  if (parts[0] !== 'stars' && parts[0] !== 'stars_test') return null;
  const days = Math.max(1, parseInt(parts[1], 10) || 30);
  const uid = String(parts[2] || '');
  return { days: days, uid: uid, test: parts[0] === 'stars_test' };
}

async function grantPaidDaysFromStars(uid, days, payment) {
  const ref = subscriptionRef(uid);
  const snap = await ref.get();
  const prev = snap.exists() ? (snap.val() || {}) : {};
  const now = Date.now();
  if (prev.forever) {
    return { skipped: true, reason: 'forever' };
  }
  const paidDays = Math.max(1, parseInt(days, 10) || 30);
  const base = Math.max(now, typeof prev.expiresAt === 'number' ? prev.expiresAt : 0);
  const expiresAt = paidExpiresAtFrom(base, paidDays);
  const entry = {
    active: true,
    trial: false,
    forever: false,
    expiresAt: expiresAt,
    paidDays: paidDays,
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
    note: 'stars-paid',
    promoUsed: true,
    promoUsedAt: (prev && prev.promoUsedAt) || now,
    lastStarsPayment: {
      at: now,
      days: paidDays,
      stars: payment && payment.total_amount,
      chargeId: payment && payment.telegram_payment_charge_id,
      payload: payment && payment.invoice_payload
    }
  };
  await ref.set(entry);
  const payloadStr = payment && payment.invoice_payload ? String(payment.invoice_payload) : '';
  await logPaymentEvent({
    at: now,
    userId: uid,
    method: 'stars',
    days: paidDays,
    stars: payment && payment.total_amount,
    amountRub: 0,
    chargeId: payment && payment.telegram_payment_charge_id,
    payload: payloadStr,
    test: payloadStr.indexOf('stars_test:') === 0
  });
  try {
    await applyReferralBonusOnFirstPaid(uid);
  } catch (e) {
    console.error('stars referral bonus failed', uid, e);
  }
  return { skipped: false, expiresAt: expiresAt, paidDays: paidDays };
}

async function handlePreCheckoutQuery(query) {
  if (!query || !query.id) return;
  try {
    const currency = String(query.currency || '');
    if (currency !== 'XTR') {
      await answerPreCheckoutQuery(query.id, false, 'Сейчас принимаем оплату только Stars');
      return;
    }
    const parsed = parseStarsPayload(query.invoice_payload);
    if (!parsed) {
      await answerPreCheckoutQuery(query.id, false, 'Неверный счёт, напишите /support');
      return;
    }
    await answerPreCheckoutQuery(query.id, true);
  } catch (e) {
    console.error('pre_checkout_query failed', e);
    try {
      await answerPreCheckoutQuery(query.id, false, 'Временная ошибка, попробуйте ещё раз');
    } catch (e2) {}
  }
}

async function handleSuccessfulStarsPayment(msg) {
  if (!msg || !msg.from || !msg.successful_payment) return false;
  const pay = msg.successful_payment;
  if (String(pay.currency || '') !== 'XTR') return false;
  const uid = String(msg.from.id);
  const parsed = parseStarsPayload(pay.invoice_payload);
  const days = parsed ? parsed.days : 30;
  try {
    const granted = await grantPaidDaysFromStars(uid, days, pay);
    console.log('stars payment ok', uid, days, pay.total_amount, granted);
    try {
      const thanks = await sendPaidThanksToUser(uid, days);
      if (!thanks.sent) {
        console.error('stars paid thanks photo failed', thanks);
        await telegramSendMessage(
          uid,
          'Оплата прошла 💜 Доступ продлён на ' + days + ' ' + pluralDaysRu(days) + '.',
          undefined
        );
      }
    } catch (e) {
      console.error('stars paid thanks failed', e);
    }
  } catch (e) {
    console.error('stars grant failed', uid, e);
    try {
      await telegramSendMessage(
        uid,
        'Оплата прошла, но доступ не открылся автоматически. Напишите /support — выдадим вручную 💜',
        null
      );
    } catch (e2) {}
  }
  return true;
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
    if (update.pre_checkout_query) {
      await handlePreCheckoutQuery(update.pre_checkout_query);
      return;
    }
    if (update.message && update.message.successful_payment) {
      await handleSuccessfulStarsPayment(update.message);
      return;
    }
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
    allowed_updates: ['message', 'pre_checkout_query'],
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

async function sendStarsTestInvoiceToTestUser() {
  const metaRef = db.ref('bot_meta/starsTestInvoiceV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('stars test invoice already sent', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  const days = 1;
  const stars = 1;
  const payload = 'stars_test:' + days + ':' + testId + ':' + Date.now();
  try {
    await telegramSendMessage(
      testId,
      'Тест оплаты Stars 💜\n\nНиже счёт на 1 Star. Если оплатите — тестовому аккаунту начислится 1 день доступа.',
      null
    );
    await telegramSendStarsInvoice(testId, {
      title: 'Тест: 1 день',
      description: 'Проверка оплаты Stars для чек-листа',
      label: '1 день',
      stars: stars,
      days: days,
      payload: payload
    });
    await metaRef.set({ at: Date.now(), to: testId, stars: stars, days: days });
    console.log('stars test invoice sent to', testId);
  } catch (e) {
    console.error('stars test invoice failed', e);
  }
}

// Если Stars купить нельзя — один раз имитируем успешную оплату на тестовом.
async function simulateStarsPaymentForTestUser() {
  const metaRef = db.ref('bot_meta/starsTestSimulatedV1');
  const metaSnap = await metaRef.get();
  if (metaSnap.exists()) {
    console.log('stars test simulate already done', metaSnap.val());
    return;
  }
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  const days = 1;
  const fakePay = {
    currency: 'XTR',
    total_amount: 1,
    telegram_payment_charge_id: 'simulate_' + Date.now(),
    invoice_payload: 'stars_test:' + days + ':' + testId + ':' + Date.now()
  };
  try {
    const granted = await grantPaidDaysFromStars(testId, days, fakePay);
    await metaRef.set({ at: Date.now(), to: testId, days: days, granted: granted });
    try {
      await telegramSendMessage(
        testId,
        'Тест: оплату Stars засчитали вручную (без покупки звезды) 💜\nДоступ на ' + days + ' ' + pluralDaysRu(days) + '.',
        undefined
      );
    } catch (e) {
      console.error('stars simulate notify failed', e);
    }
    try {
      await sendPaidThanksToUser(testId, days);
    } catch (e) {
      console.error('stars simulate thanks failed', e);
    }
    console.log('stars test simulate done', testId, granted);
  } catch (e) {
    console.error('stars test simulate failed', e);
  }
}

async function ensureBotCommands() {
  const userCommands = [
    { command: 'start', description: 'Как открыть приложение' },
    { command: 'app', description: 'Открыть чек-лист' },
    { command: 'cabinet', description: 'Личный кабинет' },
    { command: 'pay', description: 'Оплата подписки' },
    { command: 'friend', description: 'Акция «Приведи друга»' },
    { command: 'support', description: 'Написать в поддержку' },
    { command: 'help', description: 'Список команд' }
  ];
  const adminCommands = userCommands.concat([
    { command: 'stars', description: 'Счёт Stars (reply на тикет: /stars 30)' }
  ]);
  try {
    const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setMyCommands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: userCommands })
    });
    const data = await res.json().catch(function () { return null; });
    console.log('setMyCommands', data && data.ok ? 'ok' : data);
  } catch (e) {
    console.error('setMyCommands failed', e);
  }
  for (let i = 0; i < ADMIN_IDS.length; i++) {
    const adminId = ADMIN_IDS[i];
    if (!adminId) continue;
    try {
      const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setMyCommands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: adminCommands,
          scope: { type: 'chat', chat_id: Number(adminId) || adminId }
        })
      });
      const data = await res.json().catch(function () { return null; });
      console.log('setMyCommands admin', adminId, data && data.ok ? 'ok' : data);
    } catch (e) {
      console.error('setMyCommands admin failed', adminId, e);
    }
  }
}

async function applyForceTestAccountOnBoot() {
  const testId = FORCE_TEST_IDS[0] || '2055929706';
  try {
    const now = Date.now();
    // Форс выключен: если в базе остался force-* (часто expired) — вернуть 30 дней.
    // Оплата Stars раньше затиралась при каждом рестарте в режиме expired.
    if (!FORCE_TEST_MODES[FORCE_TEST_MODE]) {
      const snap = await subscriptionRef(testId).get();
      const prev = snap.exists() ? (snap.val() || {}) : null;
      const note = prev ? String(prev.note || '') : '';
      if (note.indexOf('force-') === 0) {
        const expiresAt = paidExpiresAtFrom(now, 30);
        await subscriptionRef(testId).set({
          active: true,
          trial: false,
          forever: false,
          expiresAt: expiresAt,
          paidDays: 30,
          createdAt: (prev && prev.createdAt) || now,
          updatedAt: now,
          note: 'stars-paid-restored-after-force',
          promoUsed: false,
          promoUsedAt: null
        });
        console.log('Test account restored 30 days after force off', testId, new Date(expiresAt).toISOString());
      } else {
        // Вернуть акцию на тестовом для повторной проверки авточека (V4, 10 ₽)
        const metaRef = db.ref('bot_meta/testPromoResetForYooKassaV4');
        const metaSnap = await metaRef.get();
        if (!metaSnap.exists()) {
          await subscriptionRef(testId).update({
            promoUsed: false,
            promoUsedAt: null,
            updatedAt: now
          });
          await metaRef.set({
            at: now,
            testId: testId,
            promoPriceRub: TEST_PROMO_PRICE_RUB
          });
          console.log(
            'Test account promo reset for YooKassa check V4',
            testId,
            TEST_PROMO_PRICE_RUB + ' RUB'
          );
        }
      }
      return;
    }
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

process.on('uncaughtException', function (err) {
  console.error('uncaughtException', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', function (err) {
  console.error('unhandledRejection', err && err.stack ? err.stack : err);
});

app.listen(PORT, function () {
  console.log('army-api listening on ' + PORT);
  console.log('yookassa', yookassaReady() ? 'ready shop=' + YOOKASSA_SHOP_ID : 'not configured');
  console.log('moy-nalog', moyNalogReady() ? 'ready login=' + MOY_NALOG_LOGIN : 'not configured');
  scheduleSubscriptionReminders();
  ensureTelegramWebhook();
  ensureBotCommands();
  // Догонка успешных платежей ЮKassa (если HTTP-уведомление не дошло)
  setTimeout(function () {
    syncRecentYooKassaPayments(30).then(function (r) {
      console.log('yookassa boot sync', r);
    }).catch(function (e) {
      console.error('yookassa boot sync failed', e && e.data ? e.data : e);
    });
  }, 4000);
  // Разово: два первых платежа были marked processed без видимой выдачи — перепровести force
  setTimeout(function () {
    forceReprocessKnownYooKassaPayments().catch(function (e) {
      console.error('yookassa force reprocess failed', e && e.data ? e.data : e);
    });
  }, 7000);
  // Разово: старые оплаты без авточека убрать из списка «Чеки»
  setTimeout(function () {
    hideOldNonAutoReceiptPayments().catch(function (e) {
      console.error('receipts list clear failed', e);
    });
  }, 9000);
  // Разово: +30 дней первому оплатившему
  setTimeout(function () {
    grantBonusDaysToFirstPayer().catch(function (e) {
      console.error('first payer bonus failed', e);
    });
  }, 11000);
  // Разово: подготовить тест comeback (+5 дней после 60 дней отсутствия)
  setTimeout(function () {
    prepareComebackTestPreview().catch(function (e) {
      console.error('comeback test prep failed', e);
    });
  }, 12000);
  // Разово: поправить тестовый срок comeback на 6 дней в счётчике
  setTimeout(function () {
    fixComebackTestToSixDays().catch(function (e) {
      console.error('comeback fix6 failed', e);
    });
  }, 13000);
  applyForceTestAccountOnBoot().catch(function (e) {
    console.error('force test account boot failed', e);
  });
  reconcileUserCount().catch(function (e) {
    console.error('user_count reconcile failed', e);
  });
  grantLegacyTrialsToAllRegistry().catch(function (e) {
    console.error('legacy trial bulk failed', e);
  });
  extendLegacyTrialsPlusOneDay().catch(function (e) {
    console.error('legacy trial +1 day failed', e);
  });
  extendTrialsPlusOneDayPaymentPending().catch(function (e) {
    console.error('trial +1 day payment pending failed', e);
  });
  // Превью в бот при старте отключены — не мешают деплою. Нужно снова — скажите.
  // Разовый тест Stars: счёт (если получится) + имитация оплаты без покупки звезды
  setTimeout(function () {
    sendStarsTestInvoiceToTestUser().catch(function (e) {
      console.error('stars test invoice boot failed', e);
    });
  }, 8000);
  setTimeout(function () {
    simulateStarsPaymentForTestUser().catch(function (e) {
      console.error('stars test simulate boot failed', e);
    });
  }, 10000);
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
