  // sync.js — общая логика облачной синхронизации через Firebase
  const FIREBASE_URL = "https://army-checklist-default-rtdb.firebaseio.com";
  const ARMY_API_URL = "https://army-checklist.onrender.com";
  const ARMY_BOT_OPEN_URL = 'https://t.me/army_checklist_bot?startapp';
  const ARMY_BOT_ACTIVATE_URL = 'https://t.me/army_checklist_bot?start=notify';
  // Из Mini App: уйти в чат с ботом, чтобы было видно ответ на Start (иначе сообщение «за» приложением)
  function armyActivateBotAndShowChat(e) {
    if (e) {
      try { e.preventDefault(); } catch (err) {}
      try { e.stopPropagation(); } catch (err2) {}
    }
    const url = ARMY_BOT_ACTIVATE_URL;
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg && typeof tg.openTelegramLink === 'function') {
        tg.openTelegramLink(url);
        setTimeout(function () {
          try { tg.close(); } catch (closeErr) {}
        }, 80);
        return false;
      }
    } catch (err3) {}
    try {
      window.location.href = url;
    } catch (err4) {
      window.open(url, '_blank');
    }
    return false;
  }
  window.armyActivateBotAndShowChat = armyActivateBotAndShowChat;
  function telegramInitData() {
    const tg = window.Telegram && window.Telegram.WebApp;
    return (tg && tg.initData) || '';
  }
  // Только Telegram Mini App: в обычном браузере чек-лист не открываем
  const ARMY_OUTSIDE_TELEGRAM = !telegramInitData();
  function armyWriteTelegramOnlyGate(html) {
    try {
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      try { document.documentElement.innerHTML = html; } catch (e2) {}
    }
  }
  function armyShowTelegramOnlyGate() {
    var html =
      '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<title>Откройте в Telegram</title></head>' +
      '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#f2f0f7;font-family:Arial,sans-serif;padding:24px;box-sizing:border-box;">' +
      '<div style="max-width:340px;width:100%;background:#fff;border-radius:16px;padding:22px 18px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,0.08);text-align:center;">' +
      '<p style="margin:0 0 10px;font-size:18px;font-weight:700;color:#2b2440;line-height:1.35;">' +
      'Чек-лист открывается только в Telegram</p>' +
      '<p style="margin:0 0 16px;font-size:14px;color:#666;line-height:1.45;">' +
      'Откройте бота и нажмите кнопку приложения внизу — так сохраняются ваш прогресс и подписка 💜</p>' +
      '<a href="' + ARMY_BOT_OPEN_URL + '" style="display:block;text-decoration:none;border-radius:12px;' +
      'padding:12px 14px;font-size:15px;font-weight:700;background:#9b7fd4;color:#fff;">' +
      'Открыть в Telegram</a></div></body></html>';
    var platform = '';
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg && typeof tg.ready === 'function') tg.ready();
      platform = String((tg && tg.platform) || '').toLowerCase();
    } catch (e) {}
    // Mini App иногда отдаёт initData чуть позже скрипта. document.write в этот момент
    // оставляет белый экран (часто на странице оплаты / startapp).
    if (platform && platform !== 'unknown') {
      setTimeout(function () {
        if (!telegramInitData()) armyWriteTelegramOnlyGate(html);
      }, 800);
      return;
    }
    armyWriteTelegramOnlyGate(html);
  }
  if (ARMY_OUTSIDE_TELEGRAM) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', armyShowTelegramOnlyGate);
    } else {
      armyShowTelegramOnlyGate();
    }
  }
  function armyCloudFetch(path, options) {
    if (ARMY_OUTSIDE_TELEGRAM) {
      return Promise.reject(new Error('telegram-only'));
    }
    options = options || {};
    const clean = String(path || '').replace(/^\/+/, '').replace(/\.json$/, '');
    const api = String(ARMY_API_URL || '').replace(/\/$/, '');
    if (!api) {
      return fetch(FIREBASE_URL + '/' + clean + '.json', options);
    }
    const headers = Object.assign({}, options.headers || {});
    headers['X-Telegram-Init-Data'] = telegramInitData();
    if (options.body != null && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(api + '/cloud/' + clean, Object.assign({}, options, { headers: headers }));
  }
  window.armyCloudFetch = armyCloudFetch;
  window.FIREBASE_URL = FIREBASE_URL;
  window.ARMY_API_URL = ARMY_API_URL;
  window.telegramInitData = telegramInitData;
  window.ARMY_OUTSIDE_TELEGRAM = ARMY_OUTSIDE_TELEGRAM;
  var STAT_CHECKBOX_IDS = {};
  let ARMY_USER_ID = null;
  if (!ARMY_OUTSIDE_TELEGRAM && window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
    ARMY_USER_ID = window.Telegram.WebApp.initDataUnsafe.user.id;
  }

  // Галочки и прогресс на одном телефоне не должны смешиваться между аккаунтами Telegram.
  // В облаке ключи как раньше (video-..., progress:...), в localStorage — с префиксом id пользователя.
  (function isolateArmyLocalStorage() {
    if (!ARMY_USER_ID) return;
    const prefix = String(ARMY_USER_ID) + ':';
    const origGet = Storage.prototype.getItem;
    const origSet = Storage.prototype.setItem;
    const origRemove = Storage.prototype.removeItem;

    function isSharedMetaKey(key) {
      return key === 'siteVersion' ||
        key === 'seenContentVersion' ||
        key.indexOf('userNumber_') === 0 ||
        key.indexOf('userFirstSeen_') === 0 ||
        key.indexOf('hasDonated_') === 0;
    }

    function isProgressKey(key) {
      return key.indexOf('video-') === 0 ||
        key.indexOf('noline-') === 0 ||
        key.indexOf('progress:') === 0;
    }

    function shouldNamespace(key) {
      if (key == null) return false;
      key = String(key);
      if (key.indexOf(prefix) === 0) return false;
      if (isSharedMetaKey(key)) return false;
      return isProgressKey(key);
    }

    Storage.prototype.getItem = function (key) {
      if (this !== localStorage || !shouldNamespace(key)) {
        return origGet.call(this, key);
      }
      const namespaced = origGet.call(this, prefix + key);
      if (namespaced !== null) return namespaced;
      return origGet.call(this, key);
    };

    Storage.prototype.setItem = function (key, value) {
      if (this !== localStorage || !shouldNamespace(key)) {
        return origSet.call(this, key, value);
      }
      return origSet.call(this, prefix + key, value);
    };

    Storage.prototype.removeItem = function (key) {
      if (this !== localStorage || !shouldNamespace(key)) {
        return origRemove.call(this, key);
      }
      origRemove.call(this, prefix + key);
      return origRemove.call(this, key);
    };

    const snapshot = [];
    for (let i = 0; i < localStorage.length; i++) {
      snapshot.push(localStorage.key(i));
    }
    snapshot.forEach(function (key) {
      if (!key || key.indexOf(prefix) === 0 || isSharedMetaKey(key) || !isProgressKey(key)) return;
      const namespaced = prefix + key;
      if (origGet.call(localStorage, namespaced) === null) {
        origSet.call(localStorage, namespaced, origGet.call(localStorage, key));
      }
      origRemove.call(localStorage, key);
    });
  })();

  // Регистрация нового пользователя (один раз на каждого человека)
function registerUserIfNeeded() {
  if (!ARMY_USER_ID) return;
  const api = String(ARMY_API_URL || '').replace(/\/$/, '');
  if (api) {
    fetch(api + '/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': telegramInitData()
      },
      body: '{}'
    })
      .then(function (res) { return res.json(); })
      .then(function (existing) {
        if (existing && existing.number) {
          localStorage.setItem('userNumber_' + ARMY_USER_ID, existing.number);
          if (existing.firstSeen) localStorage.setItem('userFirstSeen_' + ARMY_USER_ID, existing.firstSeen);
        }
        if (existing && existing.nickname) {
          localStorage.setItem('nickname_' + ARMY_USER_ID, existing.nickname);
        }
      })
      .catch(function () {});
    return;
  }

  armyCloudFetch('user_registry/' + ARMY_USER_ID)
    .then(res => res.json())
    .then(existing => {
      if (existing && existing.number) {
        // уже был зарегистрирован раньше (с этого или другого устройства) — просто запоминаем локально
        localStorage.setItem('userNumber_' + ARMY_USER_ID, existing.number);
        localStorage.setItem('userFirstSeen_' + ARMY_USER_ID, existing.firstSeen);
        if (existing.nickname) localStorage.setItem('nickname_' + ARMY_USER_ID, existing.nickname);
        return;
      }
      // новый пользователь — узнаём текущий счётчик и увеличиваем
           armyCloudFetch('user_count')
        .then(res => res.json())
        .then(count => {
          const newNumber = (count || 0) + 1;
          const firstSeen = Date.now();
          armyCloudFetch('user_count', {
            method: 'PUT',
            body: JSON.stringify(newNumber),
            keepalive: true
          });
          armyCloudFetch('user_registry/' + ARMY_USER_ID, {
            method: 'PUT',
            body: JSON.stringify({ number: newNumber, firstSeen }),
            keepalive: true
          });
          localStorage.setItem('userNumber_' + ARMY_USER_ID, newNumber);
          localStorage.setItem('userFirstSeen_' + ARMY_USER_ID, firstSeen);
        });
    })
    .catch(() => {});
}
registerUserIfNeeded();

  // Проверка подписки: без оплаты — экран-заглушка. Галочки и прогресс НЕ стираем.
  // Без сиреневой «заглушки ожидания» на каждой странице — только экран оплаты, если доступа нет.
  function armyMountTopOverlay(el) {
    function go() {
      const host = document.body || document.documentElement;
      if (!host) return;
      host.appendChild(el);
      try {
        document.documentElement.style.overflow = 'hidden';
        if (document.body) document.body.style.overflow = 'hidden';
      } catch (e) {}
    }
    if (document.body || document.documentElement) go();
    else document.addEventListener('DOMContentLoaded', go);
  }

  function armyRemoveEl(id) {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function armyUnlockPageScroll() {
    try {
      document.documentElement.style.overflow = '';
      if (document.body) document.body.style.overflow = '';
    } catch (e) {}
  }

  function armySubCacheKey() {
    return ARMY_USER_ID ? ('armySubCache_' + ARMY_USER_ID) : 'armySubCache';
  }

  function readSubscriptionCache() {
    try {
      const raw = sessionStorage.getItem(armySubCacheKey());
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      if (Date.now() - (o.at || 0) > 180000) return null;
      if (o.ok && o.expiresAt && Number(o.expiresAt) <= Date.now()) {
        o.ok = false;
        o.status = 'expired';
      }
      return o;
    } catch (e) {
      return null;
    }
  }

  function writeSubscriptionCache(data) {
    try {
      sessionStorage.setItem(armySubCacheKey(), JSON.stringify({
        ok: !!(data && data.ok),
        forever: !!(data && data.forever),
        expiresAt: data && data.expiresAt ? data.expiresAt : null,
        trial: !!(data && data.trial),
        trialDays: data && data.trialDays != null ? data.trialDays : null,
        priceRub: (data && data.priceRub) || 200,
        oldPriceRub: (data && data.oldPriceRub) || null,
        promo: !!(data && data.promo),
        promoDaysLeft: (data && data.promoDaysLeft != null) ? data.promoDaysLeft : null,
        status: (data && data.status) || '',
        at: Date.now()
      }));
    } catch (e) {}
  }

  function armyPluralDaysPromo(n) {
    const num = Math.abs(parseInt(n, 10) || 0);
    const mod10 = num % 10;
    const mod100 = num % 100;
    if (mod10 === 1 && mod100 !== 11) return 'день';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
    return 'дней';
  }

  function armyTrialWelcomeKey() {
    return ARMY_USER_ID ? ('armyTrialWelcomeSeen_' + ARMY_USER_ID) : 'armyTrialWelcomeSeen';
  }

  function showTrialWelcome(info) {
    info = info || {};
    if (document.getElementById('army-trial-welcome') || document.getElementById('army-paywall')) return;

    const days = parseInt(info.trialDays, 10) || 10;
    const overlay = document.createElement('div');
    overlay.id = 'army-trial-welcome';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483645',
      'background:rgba(43,36,64,0.35)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px 18px', 'box-sizing:border-box',
      'font-family:Arial,sans-serif'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'width:100%', 'max-width:320px', 'background:#fff',
      'border-radius:18px', 'padding:26px 22px 22px',
      'box-shadow:0 12px 40px rgba(80,60,120,0.2)',
      'text-align:center'
    ].join(';');

    const emoji = document.createElement('div');
    emoji.textContent = '💜';
    emoji.style.cssText = 'font-size:28px;margin:0 0 10px';

    const title = document.createElement('div');
    title.textContent = 'Пробный период';
    title.style.cssText = 'font-size:18px;font-weight:700;color:#2b2440;margin:0 0 10px';

    const botStarted = !!info.botStarted;
    const text = document.createElement('div');
    text.textContent = 'Добро пожаловать! У вас есть ' + days + ' ' +
      (days === 1 ? 'день' : (days >= 2 && days <= 4 ? 'дня' : 'дней')) +
      ' бесплатного доступа ко всему чек-листу. Потом можно оформить подписку.';
    text.style.cssText = 'font-size:14px;line-height:1.45;color:#666;margin:0 0 ' +
      (botStarted ? '18px' : '14px');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Понятно';
    btn.style.cssText = [
      'width:100%', 'border:none', 'border-radius:12px', 'padding:13px 16px',
      'font-size:15px', 'font-weight:600', 'cursor:pointer',
      'background:#9b7fd4', 'color:#fff'
    ].join(';');
    btn.addEventListener('click', function () {
      try {
        localStorage.setItem(armyTrialWelcomeKey(), '1');
      } catch (e) {}
      armyRemoveEl('army-trial-welcome');
      armyUnlockPageScroll();
      setTimeout(maybeShowMenuHeartHint, 280);
    });

    card.appendChild(emoji);
    card.appendChild(title);
    card.appendChild(text);
    // Только тем, кто ещё не нажимал Start у бота
    if (!botStarted) {
      const notify = document.createElement('div');
      notify.textContent =
        'Пожалуйста, активируйте бота, чтобы получать важные уведомления (окончание доступа, чеки и новости)';
      notify.style.cssText = 'font-size:14px;line-height:1.45;color:#666;margin:0 0 12px';

      const startBtn = document.createElement('a');
      startBtn.href = ARMY_BOT_ACTIVATE_URL;
      startBtn.textContent = 'Активировать бота';
      startBtn.style.cssText = [
        'display:block', 'width:100%', 'box-sizing:border-box', 'text-decoration:none',
        'border-radius:12px', 'padding:12px 16px', 'margin:0 0 10px',
        'font-size:15px', 'font-weight:700', 'text-align:center',
        'background:#f0edf9', 'color:#5b3a8e', 'border:1px solid #d9cdf0',
        'cursor:pointer'
      ].join(';');
      startBtn.addEventListener('click', armyActivateBotAndShowChat);
      card.appendChild(notify);
      card.appendChild(startBtn);
    }
    card.appendChild(btn);
    overlay.appendChild(card);
    armyMountTopOverlay(overlay);
  }

  // v2: один раз показать подсказку всем текущим; дальше только тем, у кого ещё нет отметки (новые)
  function armyMenuHeartHintKey() {
    return ARMY_USER_ID ? ('armyMenuHeartHintSeen_v2_' + ARMY_USER_ID) : 'armyMenuHeartHintSeen_v2';
  }

  function ensureMenuHeartHintStyles() {
    if (document.getElementById('army-menu-heart-hint-style')) return;
    const style = document.createElement('style');
    style.id = 'army-menu-heart-hint-style';
    style.textContent =
      '@keyframes armyHeartPulse{' +
      '0%,100%{box-shadow:0 0 0 0 rgba(155,127,212,0.75),0 0 0 9999px rgba(43,36,64,0.55);transform:scale(1)}' +
      '50%{box-shadow:0 0 0 10px rgba(155,127,212,0.15),0 0 0 9999px rgba(43,36,64,0.55);transform:scale(1.08)}' +
      '}';
    document.head.appendChild(style);
  }

  function showMenuHeartHint() {
    const btn = document.getElementById('menu-btn');
    if (!btn || document.getElementById('army-menu-heart-hint')) return;
    if (document.getElementById('army-trial-welcome') || document.getElementById('army-paywall')) return;

    ensureMenuHeartHintStyles();

    const overlay = document.createElement('div');
    overlay.id = 'army-menu-heart-hint';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483644',
      'pointer-events:auto', 'font-family:Arial,sans-serif'
    ].join(';');

    const dim = document.createElement('div');
    dim.style.cssText = 'position:absolute;inset:0;background:rgba(43,36,64,0.55)';

    const spot = document.createElement('div');
    spot.style.cssText = [
      'position:fixed', 'border-radius:50%', 'pointer-events:none',
      'border:3px solid #9b7fd4', 'background:transparent',
      'animation:armyHeartPulse 1.4s ease-in-out infinite',
      'box-sizing:border-box', 'z-index:2147483645'
    ].join(';');

    const tip = document.createElement('div');
    tip.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'left:50%', 'transform:translateX(-50%)',
      'width:calc(100% - 40px)', 'max-width:300px',
      'background:#fff', 'border-radius:16px', 'padding:16px 18px',
      'box-shadow:0 12px 40px rgba(80,60,120,0.25)', 'text-align:center',
      'pointer-events:none'
    ].join(';');
    tip.innerHTML =
      '<div style="font-size:22px;margin:0 0 8px">💜</div>' +
      '<div style="font-size:16px;font-weight:700;color:#2b2440;margin:0 0 8px">Меню под сердечком</div>' +
      '<div style="font-size:14px;line-height:1.45;color:#666">Нажми на сердечко справа сверху — там личный кабинет и инструкция</div>';

    function place() {
      const r = btn.getBoundingClientRect();
      const size = Math.max(44, Math.max(r.width, r.height) + 18);
      const left = r.left + r.width / 2 - size / 2;
      const top = r.top + r.height / 2 - size / 2;
      spot.style.width = size + 'px';
      spot.style.height = size + 'px';
      spot.style.left = left + 'px';
      spot.style.top = top + 'px';
      // «дырка» в затемнении через большой box-shadow на круге
      spot.style.boxShadow = '0 0 0 0 rgba(155,127,212,0.7), 0 0 0 9999px rgba(43,36,64,0.55)';
      dim.style.display = 'none';
      const tipTop = top + size + 14;
      tip.style.top = Math.min(tipTop, window.innerHeight - 140) + 'px';
    }

    // Поднимаем сердечко поверх затемнения (иначе клик не дойдёт)
    const prev = {
      zIndex: btn.style.zIndex,
      position: btn.style.position,
      left: btn.style.left,
      top: btn.style.top,
      right: btn.style.right,
      filter: btn.style.filter,
      width: btn.style.width,
      height: btn.style.height
    };
    function elevateBtn() {
      const r = btn.getBoundingClientRect();
      btn.style.position = 'fixed';
      btn.style.left = r.left + 'px';
      btn.style.top = r.top + 'px';
      btn.style.right = 'auto';
      btn.style.width = Math.max(22, r.width) + 'px';
      btn.style.height = Math.max(22, r.height) + 'px';
      btn.style.zIndex = '2147483647';
      btn.style.filter = 'drop-shadow(0 0 6px rgba(155,127,212,0.95))';
    }

    function finish() {
      try {
        localStorage.setItem(armyMenuHeartHintKey(), '1');
      } catch (e) {}
      window.removeEventListener('resize', onResize);
      btn.removeEventListener('click', onHeartClick, true);
      btn.style.zIndex = prev.zIndex;
      btn.style.position = prev.position;
      btn.style.left = prev.left;
      btn.style.top = prev.top;
      btn.style.right = prev.right;
      btn.style.filter = prev.filter;
      btn.style.width = prev.width;
      btn.style.height = prev.height;
      armyRemoveEl('army-menu-heart-hint');
      armyUnlockPageScroll();
    }

    function onHeartClick() {
      finish();
    }

    function onResize() {
      // Сначала вернуть в поток, замерить, снова поднять
      btn.style.position = prev.position || 'absolute';
      btn.style.left = prev.left;
      btn.style.top = prev.top;
      btn.style.right = prev.right;
      btn.style.zIndex = prev.zIndex;
      place();
      elevateBtn();
      place();
    }

    // capture: вместе с открытием меню
    btn.addEventListener('click', onHeartClick, true);
    overlay.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    overlay.appendChild(dim);
    overlay.appendChild(spot);
    overlay.appendChild(tip);
    armyMountTopOverlay(overlay);
    place();
    elevateBtn();
    place();
    window.addEventListener('resize', onResize);
  }

  function maybeShowMenuHeartHint() {
    if (!ARMY_USER_ID) return;
    if (!document.getElementById('menu-btn')) return;
    if (document.getElementById('army-menu-heart-hint')) return;
    if (document.getElementById('army-trial-welcome') || document.getElementById('army-paywall')) {
      setTimeout(maybeShowMenuHeartHint, 400);
      return;
    }
    try {
      if (localStorage.getItem(armyMenuHeartHintKey()) === '1') return;
    } catch (e) {}
    showMenuHeartHint();
  }

  function maybeShowTrialWelcome(data) {
    if (!ARMY_USER_ID) return;
    // Только при активном пробном периоде, строго один раз — как у всех
    if (!(data && data.ok && data.trial)) return;
    if (data.forever || data.status === 'admin' || data.status === 'forever') return;
    try {
      // Тест «как новый»: новый welcomeResetToken сбрасывает «уже видела окошко»
      if (data.welcomeResetToken) {
        const tokenKey = 'armyTrialWelcomeToken_' + ARMY_USER_ID;
        const token = String(data.welcomeResetToken);
        if (localStorage.getItem(tokenKey) !== token) {
          localStorage.setItem(tokenKey, token);
          localStorage.removeItem(armyTrialWelcomeKey());
          localStorage.removeItem(armyMenuHeartHintKey());
        }
      }
      if (localStorage.getItem(armyTrialWelcomeKey()) === '1') return;
    } catch (e) {}
    // Убрать paywall из старого кэша — иначе showTrialWelcome сразу выходит
    armyRemoveEl('army-paywall');
    showTrialWelcome({
      trialDays: data.trialDays || 10,
      botStarted: !!data.botStarted
    });
  }

  function applyBotActivateMenu(data) {
    const el = document.getElementById('menu-bot-activate');
    if (!el) return;
    // Пока нет ответа — скрыт. Иначе на секунду вспыхивает ник бота у тех, кто уже нажал Start.
    el.style.display = (data && data.botStarted === false) ? '' : 'none';
    if (!el.getAttribute('data-army-activate-bound')) {
      el.setAttribute('data-army-activate-bound', '1');
      el.addEventListener('click', armyActivateBotAndShowChat);
    }
  }

  // На главной: пункт меню «активировать бота» сразу умеет закрывать Mini App
  (function bindMenuBotActivateEarly() {
    function bind() {
      const el = document.getElementById('menu-bot-activate');
      if (!el || el.getAttribute('data-army-activate-bound')) return;
      el.setAttribute('data-army-activate-bound', '1');
      el.addEventListener('click', armyActivateBotAndShowChat);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
  })();

  function armyDaysLeftWarnKey(days, expiresAt) {
    return 'armyDaysLeftWarn_' + days + '_' + ARMY_USER_ID + '_' + String(expiresAt || '');
  }

  function showDaysLeftWarn(daysLeft) {
    const id = 'army-daysleft-warn';
    if (document.getElementById(id) ||
        document.getElementById('army-paywall') ||
        document.getElementById('army-trial-welcome')) return;

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483645',
      'background:rgba(43,36,64,0.35)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px 18px', 'box-sizing:border-box',
      'font-family:Arial,sans-serif'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'width:100%', 'max-width:320px', 'background:#fff',
      'border-radius:18px', 'padding:26px 22px 22px',
      'box-shadow:0 12px 40px rgba(80,60,120,0.2)',
      'text-align:center'
    ].join(';');

    const emoji = document.createElement('div');
    emoji.textContent = '⏳';
    emoji.style.cssText = 'font-size:28px;margin:0 0 10px';

    const title = document.createElement('div');
    if (daysLeft === 1) title.textContent = 'Последний день';
    else title.textContent = 'Осталось ' + daysLeft + ' дня';
    title.style.cssText = 'font-size:18px;font-weight:700;color:#2b2440;margin:0 0 10px';

    const text = document.createElement('div');
    text.textContent = 'Доступ скоро закончится. Продлить подписку можно в личном кабинете.';
    text.style.cssText = 'font-size:14px;line-height:1.45;color:#666;margin:0 0 18px';

    const btnCabinet = document.createElement('button');
    btnCabinet.type = 'button';
    btnCabinet.textContent = 'В личный кабинет';
    btnCabinet.style.cssText = [
      'width:100%', 'border:none', 'border-radius:12px', 'padding:13px 16px',
      'font-size:15px', 'font-weight:600', 'cursor:pointer',
      'background:#9b7fd4', 'color:#fff', 'margin:0 0 8px'
    ].join(';');

    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.textContent = 'Понятно';
    btnOk.style.cssText = [
      'width:100%', 'border:none', 'border-radius:12px', 'padding:12px 16px',
      'font-size:14px', 'font-weight:600', 'cursor:pointer',
      'background:#ebe6f4', 'color:#5b4a7a'
    ].join(';');

    function dismiss(goCabinet) {
      armyRemoveEl(id);
      armyUnlockPageScroll();
      if (goCabinet) {
        try { location.href = 'statistics.html'; } catch (e2) {}
      }
    }

    btnCabinet.addEventListener('click', function () { dismiss(true); });
    btnOk.addEventListener('click', function () { dismiss(false); });

    card.appendChild(emoji);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(btnCabinet);
    card.appendChild(btnOk);
    overlay.appendChild(card);
    armyMountTopOverlay(overlay);
  }

  function armyMoscowDateKey(ms) {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  }

  function armyInclusiveDaysLeft(expiresAt) {
    const now = Date.now();
    if (!expiresAt || Number(expiresAt) <= now) return 0;
    const untilKey = armyMoscowDateKey(Number(expiresAt) - 1);
    const todayKey = armyMoscowDateKey(now);
    const until = new Date(untilKey + 'T12:00:00Z').getTime();
    const today = new Date(todayKey + 'T12:00:00Z').getTime();
    return Math.max(0, Math.round((until - today) / (24 * 60 * 60 * 1000)) + 1);
  }

  function maybeShowDaysLeftWarn(data) {
    if (!ARMY_USER_ID) return;
    if (!(data && data.ok) || data.forever || data.status === 'admin' || data.status === 'forever') return;
    if (!data.expiresAt) return;
    const leftDays = armyInclusiveDaysLeft(data.expiresAt);
    if (leftDays !== 1 && leftDays !== 3) return;
    const warnKey = armyDaysLeftWarnKey(leftDays, data.expiresAt);
    try {
      if (localStorage.getItem(warnKey) === '1') return;
      localStorage.setItem(warnKey, '1');
    } catch (e) {}
    showDaysLeftWarn(leftDays);
  }

  function armyCurrentHtmlFile() {
    try {
      const path = String((location && location.pathname) || '');
      let file = path.split('/').pop() || '';
      if (!file) file = 'index.html';
      if (file.indexOf('.html') === -1 && file.indexOf('.') === -1) {
        file = file ? (file + '.html') : 'index.html';
      }
      return file;
    } catch (e) {
      return '';
    }
  }

  // Страница оплаты и оферта всегда доступны даже без подписки
  function armyIsAlwaysOpenPage() {
    const file = armyCurrentHtmlFile();
    return file === 'payment.html' || file === 'oferta.html' ||
      file === 'referral.html' ||
      file === 'admin-receipts.html' || file === 'admin-stats.html';
  }

  function armyPayPageHref() {
    const file = 'payment.html?v=48';
    try {
      const path = String((location && location.pathname) || '');
      const last = (path.split('/').pop() || '');
      if (path.endsWith('/')) return path + file;
      if (/\.html$/i.test(last)) return path.replace(/[^/]+$/, file);
      if (path) return path.replace(/\/?$/, '/') + file;
    } catch (e) {}
    return file;
  }

  function showSubscriptionPaywall(info) {
    info = info || {};
    if (armyIsAlwaysOpenPage()) return;
    if (document.getElementById('army-paywall')) return;

    const overlay = document.createElement('div');
    overlay.id = 'army-paywall';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'background:linear-gradient(165deg,#ebe6f4 0%,#f7f5fb 45%,#efeaf8 100%)',
      'display:flex', 'align-items:flex-start', 'justify-content:center',
      'padding:72px 18px 24px', 'box-sizing:border-box',
      'overflow:auto', '-webkit-overflow-scrolling:touch',
      'font-family:Arial,sans-serif', 'visibility:visible'
    ].join(';');

    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'width:100%', 'max-width:340px',
      'display:flex', 'flex-direction:column', 'align-items:stretch', 'gap:12px'
    ].join(';');

    const hero = document.createElement('img');
    hero.src = 'paywall-bts.jpg';
    hero.alt = 'BTS';
    hero.style.cssText = [
      'width:100%', 'height:auto', 'display:block',
      'border-radius:16px',
      'box-shadow:0 8px 28px rgba(80,60,120,0.12)'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'width:100%', 'background:#fff',
      'border-radius:18px', 'padding:28px 22px 24px',
      'box-shadow:0 10px 40px rgba(80,60,120,0.12)',
      'text-align:center', 'box-sizing:border-box'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Откройте доступ к чек-листу';
    title.style.cssText = [
      'font-family:Arial,sans-serif',
      'font-size:18px', 'font-weight:700',
      'color:#2b2440', 'margin:0 0 16px', 'line-height:1.3',
      'text-align:center'
    ].join(';');

    const payLink = document.createElement('a');
    payLink.href = armyPayPageHref();
    payLink.textContent = 'Перейти к оплате';
    payLink.style.cssText = [
      'display:block', 'width:100%', 'box-sizing:border-box',
      'text-decoration:none', 'border-radius:12px', 'padding:14px 16px',
      'font-size:15px', 'font-weight:700', 'text-align:center',
      'background:#9b7fd4', 'color:#fff', 'margin:0 0 14px'
    ].join(';');

    const thanks = document.createElement('div');
    thanks.textContent = 'Спасибо, что пользуетесь ботом 💜';
    thanks.style.cssText = 'font-size:13px;line-height:1.4;color:#5b4a7a;font-weight:600';

    card.appendChild(title);
    card.appendChild(payLink);
    card.appendChild(thanks);
    wrap.appendChild(hero);
    wrap.appendChild(card);
    overlay.appendChild(wrap);
    armyMountTopOverlay(overlay);
  }

  function applySubscriptionResult(data) {
    if (!data || typeof data !== 'object') return;
    writeSubscriptionCache(data);
    applyBotActivateMenu(data);
    if (data.ok) {
      armyRemoveEl('army-paywall');
      armyUnlockPageScroll();
      maybeShowTrialWelcome(data);
      maybeShowMenuHeartHint();
      maybeShowDaysLeftWarn(data);
      return;
    }
    showSubscriptionPaywall(data);
  }

  function checkSubscriptionAccess() {
    if (ARMY_OUTSIDE_TELEGRAM) return;
    const api = String(ARMY_API_URL || '').replace(/\/$/, '');
    if (!api || !ARMY_USER_ID) return;
    const alwaysOpen = armyIsAlwaysOpenPage();

    const cached = readSubscriptionCache();
    if (!alwaysOpen && cached && cached.ok === false) {
      showSubscriptionPaywall(cached);
    }
    // Если доступ уже подтверждён кэшем — страницу не блокируем, только тихо обновляем.

    fetch(api + '/subscription', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': telegramInitData()
      }
    })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') return;
        if (alwaysOpen) {
          writeSubscriptionCache(data);
          applyBotActivateMenu(data);
          // Окошко новичка можно показать и на payment/referral
          if (data && data.ok && data.trial) maybeShowTrialWelcome(data);
          return;
        }
        applySubscriptionResult(data);
      })
      .catch(function () {});
  }
  checkSubscriptionAccess();

  function saveToCloudWithRetry(path, value, attempt) {
    attempt = attempt || 1;
    // Примитивы (false/true/число) оборачиваем: голый JSON false иногда теряется в WebView/сервере.
    var payload = value;
    if (value === null || typeof value !== 'object') {
      payload = { __army: value };
    }
    armyCloudFetch(path, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res || !res.ok) throw new Error('cloud-save');
    }).catch(function () {
      if (attempt < 3) {
        setTimeout(function () { saveToCloudWithRetry(path, value, attempt + 1); }, 1000 * attempt);
      }
    });
  }

  function localDateKey(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1);
    const day = String(d.getDate());
    return y + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function getCheckActivityState() {
    const empty = { days: {}, byId: {}, rewatchById: {}, rewatchLog: {}, markLog: {}, titlesById: {}, pagesById: {}, undoById: {}, bestStreak: 0, bestDayCount: 0 };
    const raw = localStorage.getItem('progress:checkActivity');
    if (!raw) return empty;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
      if (data.days && typeof data.days === 'object' && !Array.isArray(data.days)) {
        const byId = (data.byId && typeof data.byId === 'object' && !Array.isArray(data.byId)) ? data.byId : {};
        const rewatchById = (data.rewatchById && typeof data.rewatchById === 'object' && !Array.isArray(data.rewatchById)) ? data.rewatchById : {};
        const rewatchLog = (data.rewatchLog && typeof data.rewatchLog === 'object' && !Array.isArray(data.rewatchLog)) ? data.rewatchLog : {};
        const markLog = (data.markLog && typeof data.markLog === 'object' && !Array.isArray(data.markLog)) ? data.markLog : {};
        const titlesById = (data.titlesById && typeof data.titlesById === 'object' && !Array.isArray(data.titlesById)) ? data.titlesById : {};
        const pagesById = (data.pagesById && typeof data.pagesById === 'object' && !Array.isArray(data.pagesById)) ? data.pagesById : {};
        const undoById = (data.undoById && typeof data.undoById === 'object' && !Array.isArray(data.undoById)) ? data.undoById : {};
        return { days: data.days, byId: byId, rewatchById: rewatchById, rewatchLog: rewatchLog, markLog: markLog, titlesById: titlesById, pagesById: pagesById, undoById: undoById, bestStreak: parseInt(data.bestStreak, 10) || 0, bestDayCount: parseInt(data.bestDayCount, 10) || 0 };
      }
      const days = {};
      Object.keys(data).forEach(function (k) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) days[k] = parseInt(data[k], 10) || 0;
      });
      return { days: days, byId: {}, rewatchById: {}, rewatchLog: {}, markLog: {}, titlesById: {}, pagesById: {}, undoById: {}, bestStreak: 0, bestDayCount: 0 };
    } catch (e) {
      return empty;
    }
  }

  function truncateCheckTitle(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > 140 ? (t.slice(0, 137) + '…') : t;
  }

  function titleFromChecklistRow(id) {
    try {
      const row = document.querySelector('[data-id="' + String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
      if (!row) return '';

      // Сначала подпись пункта (.text), а не «Озвучка/Субтитры/🔗»
      const textEl = row.querySelector('.text');
      if (textEl) {
        const clone = textEl.cloneNode(true);
        const subs = clone.querySelectorAll('.sub');
        for (let i = 0; i < subs.length; i++) subs[i].remove();
        const fromText = truncateCheckTitle(clone.textContent || '');
        if (fromText) return fromText;
      }

      const nameEl = row.querySelector('.name');
      if (nameEl) {
        const fromName = truncateCheckTitle(nameEl.textContent || '');
        if (fromName) return fromName;
      }

      const links = row.querySelectorAll('a');
      for (let i = 0; i < links.length; i++) {
        const label = truncateCheckTitle(links[i].textContent || '');
        if (!label) continue;
        if (/^(озвучка|субтитры|ссылка|vk|youtube|🔗|link)$/i.test(label)) continue;
        return label;
      }

      const cloneRow = row.cloneNode(true);
      const drop = cloneRow.querySelectorAll('input, .links-wrap, .sub, button');
      for (let i = 0; i < drop.length; i++) drop[i].remove();
      return truncateCheckTitle(cloneRow.textContent || '');
    } catch (e) {
      return '';
    }
  }

  function currentChecklistPageInfo() {
    try {
      const path = String((location && location.pathname) || '');
      let file = path.split('/').pop() || '';
      if (!file || file === '') file = 'index.html';
      if (file.indexOf('.html') === -1 && file.indexOf('.') === -1) file = file ? (file + '.html') : 'index.html';
      if (file === 'statistics.html' || file === 'payment.html' || file === 'oferta.html' || file === 'referral.html' || file === 'index.html') {
        return null;
      }
      let name = '';
      const h1 = document.querySelector('h1');
      if (h1) name = truncateCheckTitle(h1.textContent || '');
      if (!name && document.title) name = truncateCheckTitle(String(document.title).replace(/\s*[|—–-]\s*BTS.*$/i, ''));
      if (!name) name = file.replace(/\.html$/i, '').replace(/-/g, ' ');
      return { href: file, name: name };
    } catch (e) {
      return null;
    }
  }

  function rememberCheckTitle(state, id) {
    if (!state.titlesById || typeof state.titlesById !== 'object') state.titlesById = {};
    if (!state.pagesById || typeof state.pagesById !== 'object') state.pagesById = {};
    const title = titleFromChecklistRow(id);
    if (title) state.titlesById[id] = title;
    const page = currentChecklistPageInfo();
    if (page && page.href) state.pagesById[id] = { href: page.href, name: page.name || page.href };
  }

  function prettyCheckId(id) {
    const s = String(id || '');
    if (s.indexOf('video-') === 0) return 'Видео ' + s.slice(6);
    if (s.indexOf('noline-') === 0) return s.slice(7).replace(/-/g, ' ');
    return s;
  }

  function getCheckMarksForDay(dayKey) {
    if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return [];
    const state = getCheckActivityState();
    const titles = state.titlesById || {};
    const pages = state.pagesById || {};
    const found = {};
    function add(id, asRewatch) {
      if (!(String(id).indexOf('video-') === 0 || String(id).indexOf('noline-') === 0)) return;
      if (localStorage.getItem(id) !== 'true') return;
      if (!found[id]) {
        const page = pages[id] && typeof pages[id] === 'object' ? pages[id] : null;
        found[id] = {
          id: id,
          title: titles[id] || prettyCheckId(id),
          count: 0,
          hasName: !!titles[id],
          pageHref: page && page.href ? String(page.href) : '',
          pageName: page && page.name ? String(page.name) : ''
        };
      }
      found[id].count += 1;
      if (asRewatch) found[id].rewatch = true;
    }
    Object.keys(state.markLog || {}).forEach(function (id) {
      const log = state.markLog[id] || [];
      log.forEach(function (d, idx) {
        if (d !== dayKey) return;
        add(id, idx > 0);
      });
    });
    Object.keys(state.byId || {}).forEach(function (id) {
      if (state.byId[id] !== dayKey) return;
      if (found[id]) return;
      add(id, false);
    });
    Object.keys(state.rewatchLog || {}).forEach(function (id) {
      const log = state.rewatchLog[id] || [];
      log.forEach(function (d) {
        if (d !== dayKey) return;
        if (found[id]) {
          found[id].rewatch = true;
          return;
        }
        add(id, true);
      });
    });
    return Object.keys(found).map(function (k) { return found[k]; }).sort(function (a, b) {
      return String(a.title).localeCompare(String(b.title), 'ru');
    });
  }

  function rebuildActivityDays(state) {
    const days = {};
    function add(d) {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      days[d] = (parseInt(days[d], 10) || 0) + 1;
    }
    if (!state.markLog) state.markLog = {};
    const ids = {};
    Object.keys(state.byId || {}).forEach(function (id) { ids[id] = true; });
    Object.keys(state.markLog).forEach(function (id) { ids[id] = true; });
    Object.keys(ids).forEach(function (id) {
      if (localStorage.getItem(id) !== 'true') return;
      const log = state.markLog[id];
      if (log && log.length) {
        log.forEach(add);
        return;
      }
      add(state.byId[id]);
      const extras = state.rewatchLog && state.rewatchLog[id];
      if (extras && extras.length) {
        extras.forEach(add);
      } else {
        const n = parseInt(state.rewatchById && state.rewatchById[id], 10) || 0;
        const base = state.byId[id];
        for (let i = 0; i < n; i++) add(base);
      }
    });
    state.days = days;
  }

  function getCheckActivity() {
    const state = getCheckActivityState();
    rebuildActivityDays(state);
    const days = {};
    Object.keys(state.days || {}).forEach(function (k) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      const n = parseInt(state.days[k], 10) || 0;
      if (n > 0) days[k] = n;
    });
    const today = localDateKey();
    let todayFromIds = 0;
    Object.keys(state.markLog || {}).forEach(function (id) {
      if (localStorage.getItem(id) !== 'true') return;
      (state.markLog[id] || []).forEach(function (d) {
        if (d === today) todayFromIds++;
      });
    });
    if (!todayFromIds) {
      Object.keys(state.byId || {}).forEach(function (id) {
        if (localStorage.getItem(id) !== 'true') return;
        if (state.byId[id] === today) todayFromIds++;
      });
    }
    if (todayFromIds > (days[today] || 0)) days[today] = todayFromIds;
    return days;
  }

  function shiftDate(date, days) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + days);
    return d;
  }

  function longestMarkedStreak(days) {
    const marked = Object.keys(days).filter(function (k) {
      return (parseInt(days[k], 10) || 0) > 0;
    }).sort();
    let record = 0;
    let run = 0;
    let prev = null;
    marked.forEach(function (k) {
      const d = k.split('-');
      const cur = new Date(parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10));
      if (prev && localDateKey(shiftDate(prev, 1)) === k) run += 1;
      else run = 1;
      if (run > record) record = run;
      prev = cur;
    });
    return record;
  }

  function currentMarkedStreak(days) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    function hasMarks(d) {
      return (parseInt(days[localDateKey(d)], 10) || 0) > 0;
    }
    let cursor = today;
    if (!hasMarks(today)) cursor = shiftDate(today, -1);
    let streak = 0;
    while (hasMarks(cursor)) {
      streak++;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  }

  function getCheckActivitySummary() {
    const days = getCheckActivity();
    let totalDays = 0;
    Object.keys(days).forEach(function (k) {
      if ((parseInt(days[k], 10) || 0) > 0) totalDays++;
    });
    const streak = currentMarkedStreak(days);
    let maxDay = 0;
    Object.keys(days).forEach(function (k) {
      const n = parseInt(days[k], 10) || 0;
      if (n > maxDay) maxDay = n;
    });
    const state = getCheckActivityState();
    const record = Math.max(longestMarkedStreak(days), streak);
    const bestDay = maxDay;
    let storedMax = 0;
    Object.keys(state.days || {}).forEach(function (k) {
      const n = parseInt(state.days[k], 10) || 0;
      if (n > storedMax) storedMax = n;
    });
    if (storedMax > maxDay || (state.bestDayCount || 0) > maxDay || (state.bestStreak || 0) > record) {
      state.days = days;
      state.bestDayCount = maxDay;
      state.bestStreak = record;
      saveCheckActivityState(state);
    }
    return { totalDays: totalDays, streak: streak, record: record, bestDay: bestDay };
  }

  function adoptOldCheckedIds(state) {
    if (!state.byId) state.byId = {};
    const prefix = ARMY_USER_ID ? String(ARMY_USER_ID) + ':' : '';
    for (let i = 0; i < localStorage.length; i++) {
      let key = localStorage.key(i);
      if (!key) continue;
      if (prefix && key.indexOf(prefix) === 0) key = key.slice(prefix.length);
      else if (ARMY_USER_ID && /^\d+:/.test(key)) continue;
      if (!(key.indexOf('video-') === 0 || key.indexOf('noline-') === 0)) continue;
      if (localStorage.getItem(key) === 'true' && !state.byId[key]) state.byId[key] = 'old';
    }
  }

  function saveCheckActivityState(state) {
    adoptOldCheckedIds(state);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 400);
    const cutoffKey = localDateKey(cutoff);
    Object.keys(state.days).forEach(function (day) {
      if (day < cutoffKey) delete state.days[day];
    });
    Object.keys(state.byId).forEach(function (id) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(state.byId[id]) && state.byId[id] < cutoffKey) delete state.byId[id];
    });
    Object.keys(state.byId).forEach(function (id) {
      if (localStorage.getItem(id) !== 'true') {
        delete state.byId[id];
        if (state.rewatchById) delete state.rewatchById[id];
        if (state.rewatchLog) delete state.rewatchLog[id];
        if (state.markLog) delete state.markLog[id];
      }
    });
    if (!state.rewatchById || typeof state.rewatchById !== 'object') state.rewatchById = {};
    if (!state.rewatchLog || typeof state.rewatchLog !== 'object') state.rewatchLog = {};
    if (!state.markLog || typeof state.markLog !== 'object') state.markLog = {};
    if (!state.titlesById || typeof state.titlesById !== 'object') state.titlesById = {};
    if (!state.pagesById || typeof state.pagesById !== 'object') state.pagesById = {};
    if (!state.undoById || typeof state.undoById !== 'object') state.undoById = {};
    Object.keys(state.undoById).forEach(function (id) {
      const snap = state.undoById[id];
      if (!snap || typeof snap !== 'object' || Date.now() > (parseInt(snap.until, 10) || 0)) delete state.undoById[id];
    });
    Object.keys(state.rewatchById).forEach(function (id) {
      if (!state.byId[id]) delete state.rewatchById[id];
    });
    Object.keys(state.rewatchLog).forEach(function (id) {
      if (!state.byId[id]) delete state.rewatchLog[id];
    });
    Object.keys(state.markLog).forEach(function (id) {
      if (!state.byId[id]) delete state.markLog[id];
    });
    Object.keys(state.titlesById).forEach(function (id) {
      if (!state.byId[id]) delete state.titlesById[id];
    });
    Object.keys(state.pagesById).forEach(function (id) {
      if (!state.byId[id]) delete state.pagesById[id];
    });
    rebuildActivityDays(state);
    state.bestStreak = Math.max(longestMarkedStreak(state.days), currentMarkedStreak(state.days));
    let maxDay = 0;
    Object.keys(state.days).forEach(function (k) {
      const n = parseInt(state.days[k], 10) || 0;
      if (n > maxDay) maxDay = n;
    });
    state.bestDayCount = maxDay;
    setProgress('checkActivity', { days: state.days, byId: state.byId, rewatchById: state.rewatchById, rewatchLog: state.rewatchLog, markLog: state.markLog, titlesById: state.titlesById, pagesById: state.pagesById, undoById: state.undoById, bestStreak: state.bestStreak, bestDayCount: state.bestDayCount });
  }

  function dropActivityDay(state, key) {
    const n = (parseInt(state.days[key], 10) || 0) - 1;
    if (n <= 0) delete state.days[key];
    else state.days[key] = n;
  }

  const ACTIVITY_UNDO_MS = 5000;

  function bumpCheckActivity(id, nowTrue, wasTrue) {
    if (wasTrue === nowTrue) return;
    if (!(String(id).indexOf('video-') === 0 || String(id).indexOf('noline-') === 0)) return;
    const state = getCheckActivityState();
    const today = localDateKey();
    if (!state.undoById || typeof state.undoById !== 'object') state.undoById = {};
    if (nowTrue) {
      const snap = state.undoById[id];
      const canUndo = snap && typeof snap === 'object' && Date.now() <= (parseInt(snap.until, 10) || 0);
      delete state.undoById[id];
      if (canUndo) {
        if (snap.byId) state.byId[id] = snap.byId;
        if (!state.markLog) state.markLog = {};
        if (snap.markLog && snap.markLog.length) state.markLog[id] = snap.markLog.slice();
        else if (snap.byId && /^\d{4}-\d{2}-\d{2}$/.test(snap.byId)) state.markLog[id] = [snap.byId];
        if (snap.rewatchById) {
          if (!state.rewatchById) state.rewatchById = {};
          state.rewatchById[id] = snap.rewatchById;
        }
        if (snap.rewatchLog && snap.rewatchLog.length) {
          if (!state.rewatchLog) state.rewatchLog = {};
          state.rewatchLog[id] = snap.rewatchLog.slice();
        }
        rememberCheckTitle(state, id);
        saveCheckActivityState(state);
        return;
      }
      if (state.byId[id]) {
        // Старая отметка без названия/раздела — допишем при повторном заходе на страницу
        const hadTitle = !!(state.titlesById && state.titlesById[id]);
        const hadPage = !!(state.pagesById && state.pagesById[id] && state.pagesById[id].href);
        if (!hadTitle || !hadPage) {
          rememberCheckTitle(state, id);
          const gotTitle = !!(state.titlesById && state.titlesById[id]);
          const gotPage = !!(state.pagesById && state.pagesById[id] && state.pagesById[id].href);
          if ((!hadTitle && gotTitle) || (!hadPage && gotPage)) saveCheckActivityState(state);
        }
        return;
      }
      state.byId[id] = today;
      if (!state.markLog) state.markLog = {};
      state.markLog[id] = [today];
      rememberCheckTitle(state, id);
    } else {
      state.undoById[id] = {
        until: Date.now() + ACTIVITY_UNDO_MS,
        byId: state.byId[id] || null,
        markLog: (state.markLog && state.markLog[id]) ? state.markLog[id].slice() : [],
        rewatchById: (state.rewatchById && state.rewatchById[id]) ? state.rewatchById[id] : 0,
        rewatchLog: (state.rewatchLog && state.rewatchLog[id]) ? state.rewatchLog[id].slice() : []
      };
      delete state.byId[id];
      if (state.rewatchById) delete state.rewatchById[id];
      if (state.rewatchLog) delete state.rewatchLog[id];
      if (state.markLog) delete state.markLog[id];
    }
    saveCheckActivityState(state);
  }

  function extraRewatchesForId(state, id) {
    const byRewatch = parseInt(state.rewatchById && state.rewatchById[id], 10) || 0;
    const log = (state.rewatchLog && state.rewatchLog[id]) || [];
    const marks = (state.markLog && state.markLog[id]) || [];
    let fromMarks = 0;
    if (state.byId && state.byId[id] === 'old') {
      marks.forEach(function (d) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) fromMarks++;
      });
    } else if (marks.length) {
      fromMarks = Math.max(0, marks.length - 1);
    }
    return Math.max(byRewatch, log.length, fromMarks);
  }

  function paintRewatchBadges() {
    const state = getCheckActivityState();
    document.querySelectorAll('[data-id]').forEach(function (row) {
      const id = row.dataset.id || '';
      if (!(id.indexOf('video-') === 0 || id.indexOf('noline-') === 0)) return;
      const extra = extraRewatchesForId(state, id);
      const box = row.querySelector('input[type="checkbox"]');
      if (!box) return;
      let hit = box.parentElement;
      if (!hit || !hit.classList || !(hit.classList.contains('army-check-hit') || hit.classList.contains('army-check-col'))) {
        hit = document.createElement('span');
        hit.className = 'army-check-hit';
        box.parentNode.insertBefore(hit, box);
        hit.appendChild(box);
      } else {
        hit.className = 'army-check-hit';
      }
      let badge = hit.querySelector('.army-rewatch-n');
      if (!box.checked || extra < 1) {
        if (badge) badge.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'army-rewatch-n';
        hit.appendChild(badge);
      }
      badge.textContent = '×' + (extra + 1);
    });
  }

  function recordCheckRewatch(id) {
    if (!(String(id).indexOf('video-') === 0 || String(id).indexOf('noline-') === 0)) return;
    const state = getCheckActivityState();
    const today = localDateKey();
    if (!state.byId) state.byId = {};
    if (!state.byId[id]) state.byId[id] = 'old';
    if (!state.rewatchById) state.rewatchById = {};
    if (!state.rewatchLog) state.rewatchLog = {};
    if (!state.markLog) state.markLog = {};
    state.rewatchById[id] = (parseInt(state.rewatchById[id], 10) || 0) + 1;
    if (!state.rewatchLog[id]) state.rewatchLog[id] = [];
    state.rewatchLog[id].push(today);
    if (!state.markLog[id] || !state.markLog[id].length) {
      state.markLog[id] = [];
      if (/^\d{4}-\d{2}-\d{2}$/.test(state.byId[id])) state.markLog[id].push(state.byId[id]);
    }
    state.markLog[id].push(today);
    rememberCheckTitle(state, id);
    saveCheckActivityState(state);
    paintRewatchBadges();
  }

  // Недавние локальные клики по галочкам: облако не должно их сразу перезаписать старым значением
  var recentLocalChecks = Object.create(null);
  var RECENT_CHECK_MS = 20000;

  function rememberLocalCheck(id, nowTrue) {
    recentLocalChecks[id] = { value: !!nowTrue, at: Date.now() };
  }

  function shouldKeepLocalCheck(id) {
    const rec = recentLocalChecks[id];
    if (!rec) return false;
    if (Date.now() - rec.at > RECENT_CHECK_MS) {
      delete recentLocalChecks[id];
      return false;
    }
    return true;
  }

  function setChecked(id, value) {
    const nowTrue = value === true || value === 'true';
    const wasTrue = localStorage.getItem(id) === 'true';
    localStorage.setItem(id, value);
    rememberLocalCheck(id, nowTrue);
    bumpCheckActivity(id, nowTrue, wasTrue);
    if (ARMY_USER_ID) {
      saveToCloudWithRetry(`users/${ARMY_USER_ID}/${id}`, nowTrue);
    }
    paintRewatchBadges();
  }

  function setupCheckboxRewatchHold() {
    const HOLD_MS = 500;
    let timer = null;
    let startX = 0;
    let startY = 0;
    let holdBox = null;
    let suppressToggle = false;

    function isWatchCheckbox(box) {
      if (!box || box.type !== 'checkbox' || box.disabled) return false;
      const row = box.closest('[data-id]');
      if (!row) return false;
      const id = row.dataset.id || '';
      return id.indexOf('video-') === 0 || id.indexOf('noline-') === 0;
    }

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function cancelHold() {
      clearTimer();
      if (!suppressToggle) holdBox = null;
    }

    function point(e) {
      if (e.touches && e.touches[0]) return e.touches[0];
      if (e.changedTouches && e.changedTouches[0]) return e.changedTouches[0];
      return e;
    }

    function onDown(e) {
      let box = e.target;
      if (box && box.closest && box.closest('.army-rewatch-n')) return;
      if (!box || box.type !== 'checkbox') {
        const hit = box && box.closest && box.closest('.army-check-hit');
        box = hit ? hit.querySelector('input[type="checkbox"]') : null;
      }
      if (!isWatchCheckbox(box) || !box.checked) return;
      if (e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) return;
      const p = point(e);
      startX = p.clientX;
      startY = p.clientY;
      holdBox = box;
      suppressToggle = false;
      clearTimer();
      timer = setTimeout(function () {
        timer = null;
        if (!holdBox || !holdBox.checked) return;
        const row = holdBox.closest('[data-id]');
        const id = row && row.dataset.id;
        if (!id) return;
        suppressToggle = true;
        recordCheckRewatch(id);
        try {
          if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
            Telegram.WebApp.HapticFeedback.impactOccurred('light');
          }
        } catch (err) {}
        holdBox.classList.add('army-rewatch');
        const el = holdBox;
        setTimeout(function () { el.classList.remove('army-rewatch'); }, 700);
      }, HOLD_MS);
    }

    function onMove(e) {
      if (!holdBox || suppressToggle) return;
      const p = point(e);
      if (Math.abs(p.clientX - startX) > 14 || Math.abs(p.clientY - startY) > 14) cancelHold();
    }

    function onUp(e) {
      clearTimer();
      if (suppressToggle) {
        if (e.cancelable) e.preventDefault();
        if (holdBox) holdBox.checked = true;
        setTimeout(function () {
          suppressToggle = false;
          holdBox = null;
        }, 400);
      } else {
        holdBox = null;
      }
    }

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', cancelHold, true);
    document.addEventListener('touchend', function (e) {
      if (!suppressToggle) return;
      if (e.cancelable) e.preventDefault();
    }, { capture: true, passive: false });
    document.addEventListener('click', function (e) {
      const badge = e.target.closest && e.target.closest('.army-rewatch-n');
      if (badge) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const row = badge.closest('[data-id]');
        const id = row && row.dataset.id;
        if (id) recordCheckRewatch(id);
        return;
      }
      if (!suppressToggle) return;
      if (!isWatchCheckbox(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.target.checked = true;
    }, true);
    document.addEventListener('change', function (e) {
      if (!suppressToggle) return;
      if (!isWatchCheckbox(e.target)) return;
      e.stopImmediatePropagation();
      e.target.checked = true;
      const row = e.target.closest('[data-id]');
      const span = row && row.querySelector('.text');
      if (span) span.classList.add('done');
    }, true);
    document.addEventListener('contextmenu', function (e) {
      if (isWatchCheckbox(e.target) && e.target.checked) e.preventDefault();
    }, true);

    const css = document.createElement('style');
    css.textContent = 'input[type=checkbox]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}input[type=checkbox].army-rewatch{outline:2px solid #9b7fd4;outline-offset:2px;}[data-id]{overflow:visible;}.army-check-hit{position:relative;display:inline-block;flex-shrink:0;width:18px;height:18px;vertical-align:middle;overflow:visible;}.army-check-hit input[type=checkbox]{margin:0;}.army-rewatch-n{position:absolute;right:-7px;top:-9px;left:auto;font-size:8px;font-weight:700;color:#888 !important;line-height:1;padding:0;background:transparent;cursor:pointer;-webkit-user-select:none;user-select:none;z-index:5;}';
    document.head.appendChild(css);
    paintRewatchBadges();
    let paintTimer = null;
    const obs = new MutationObserver(function () {
      clearTimeout(paintTimer);
      paintTimer = setTimeout(paintRewatchBadges, 80);
    });
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  }

  function backfillMissingCheckTitles() {
    try {
      const state = getCheckActivityState();
      if (!state.titlesById || typeof state.titlesById !== 'object') state.titlesById = {};
      if (!state.pagesById || typeof state.pagesById !== 'object') state.pagesById = {};
      let changed = false;
      Object.keys(state.byId || {}).forEach(function (id) {
        if (localStorage.getItem(id) !== 'true') return;
        if (!document.querySelector('[data-id="' + String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')) return;
        const hadTitle = !!state.titlesById[id];
        const hadPage = !!(state.pagesById[id] && state.pagesById[id].href);
        if (hadTitle && hadPage) return;
        rememberCheckTitle(state, id);
        if ((!hadTitle && state.titlesById[id]) || (!hadPage && state.pagesById[id] && state.pagesById[id].href)) {
          changed = true;
        }
      });
      if (changed) saveCheckActivityState(state);
    } catch (e) {}
  }

  function setupCheckActivityUi() {
    setupCheckboxRewatchHold();
    backfillMissingCheckTitles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupCheckActivityUi);
  } else {
    setupCheckActivityUi();
  }

  function setProgress(key, value) {
    const fullKey = 'progress:' + key;
    localStorage.setItem(fullKey, JSON.stringify(value));
    if (ARMY_USER_ID) {
      saveToCloudWithRetry(`users/${ARMY_USER_ID}/${fullKey}`, value);
    }
  }

  // Подтягивает облачные данные и обновляет чекбоксы на странице (без задержки экрана)
  function syncChecklistFromCloud(onChanged) {
    if (!ARMY_USER_ID) return;
    armyCloudFetch('users/' + ARMY_USER_ID)
      .then(res => res.json())
      .then(data => {
        if (!data) return;
        let changed = false;
        document.querySelectorAll('[data-id]').forEach((row) => {
          const id = row.dataset.id;
          if (data[id] === undefined) return;
          const cloudTrue = data[id] === true || data[id] === 'true';
          const localTrue = localStorage.getItem(id) === 'true';
          if (shouldKeepLocalCheck(id)) {
            // Только что нажали — не откатываем облаком. Если облако уже совпало — забываем защиту.
            if (cloudTrue === localTrue) delete recentLocalChecks[id];
            return;
          }
          if (cloudTrue !== localTrue) {
            const box = row.querySelector('input[type="checkbox"]');
            const span = row.querySelector('.text');
            if (box) box.checked = cloudTrue;
            if (span) span.classList.toggle('done', cloudTrue);
            localStorage.setItem(id, cloudTrue);
            changed = true;
          }
        });
        paintRewatchBadges();
        if (changed && onChanged) onChanged();
      })
      .catch(() => {});
  }

  // Подтягивает бейджи статистики для страниц-хабов
  function syncBadgesFromCloud(keys, applyFn) {
    if (!ARMY_USER_ID) return;
    armyCloudFetch('users/' + ARMY_USER_ID)
      .then(res => res.json())
      .then(data => {
        if (!data) return;
        keys.forEach((key) => {
          const cloudVal = data['progress:' + key];
          if (cloudVal) applyFn(key, cloudVal);
        });
      })
      .catch(() => {});
  }
     function refreshLocalStorageFromCloud(callback) {
    if (!ARMY_USER_ID) return;
    armyCloudFetch('users/' + ARMY_USER_ID)
      .then(res => res.json())
      .then(data => {
        if (!data) { if (callback) callback(); return; }
        Object.keys(data).forEach(function(k) {
          if (k.indexOf('progress:') === 0) {
            localStorage.setItem(k, JSON.stringify(data[k]));
          }
        });
        paintRewatchBadges();
        if (callback) callback();
      })
      .catch(() => {});
  }

  // Полностью перезаписывает ВСЮ локальную память данными этого аккаунта из облака —
  // и отдельные галочки (video-...), и итоговые цифры (progress:...)
  function refreshEverythingFromCloud(callback) {
    if (!ARMY_USER_ID) { if (callback) callback(); return; }
    armyCloudFetch('users/' + ARMY_USER_ID)
      .then(res => res.json())
      .then(data => {
        if (!data) { if (callback) callback(); return; }
        Object.keys(data).forEach(function(k) {
          if (k.indexOf('progress:') === 0) {
            localStorage.setItem(k, JSON.stringify(data[k]));
          } else {
            if (shouldKeepLocalCheck(k)) {
              const cloudTrue = data[k] === true || data[k] === 'true';
              const localTrue = localStorage.getItem(k) === 'true';
              if (cloudTrue === localTrue) delete recentLocalChecks[k];
              return;
            }
            localStorage.setItem(k, data[k] === true || data[k] === 'true');
          }
        });
        paintRewatchBadges();
        if (callback) callback();
      })
      .catch(() => { if (callback) callback(); });
  }
  // Проверка версии сайта — если на сервере версия выше, чем у пользователя, страница перезагрузится один раз
  function checkForUpdate() {
    fetch('version.json?t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        const serverVersion = data.v;
        const localVersion = localStorage.getItem('siteVersion');
        if (localVersion !== null && parseInt(localVersion) < serverVersion) {
          localStorage.setItem('siteVersion', serverVersion);
          location.reload(true);
        } else if (localVersion === null) {
          localStorage.setItem('siteVersion', serverVersion);
        }
      })
      .catch(() => {});
  }
  // ===== Статистика по годам: "свои" пункты + "довески" с других страниц =====
  // Тут перечислено: для года 2013-2015 — какие страницы-довески туда входят
  // и какие именно видео (по id) из этой страницы туда считаются
  const YEAR_WEIGHTED_MAP = {
  'other-shows-2013-2015': {
    'other-shows-wide-open-studio': ["video-3247","video-3248"],
    'other-shows-kiss-the-radio': ["video-1246","video-1243","video-1247","video-1249","video-1245","video-1244"],
    'other-shows-after-school-club': ["video-3151","video-3152","video-3153","video-3156","video-3157","video-3154","video-3155","video-3158","video-3160","video-3161"],
    'other-shows-weekly-idol': ["video-1695","video-1696","video-1697"],
    'other-shows-yinyuetai': ["video-2257","video-2258","video-2259"],
    'other-shows-idols-true-colors': ["video-2225","video-111"],
    'other-shows-bts-idol-show': ["video-2265","video-2266"],
    'other-shows-yaman-tv': ["video-1785","video-1786"],
    'other-shows-lucky-draw': ["video-2226","video-2227","video-2228","video-2229","video-2230"],
    'other-shows-running-man': ["video-1752"],
    'other-shows-hello-talkshow': ["video-3229"],
    'other-shows-cultwo': ["video-3223"],
    'other-shows-problematic-men': ["video-4942","video-3281","video-3282","video-3283","video-3284","video-3285","video-3286","video-3287","video-3288","video-3289","video-3290"]
  },
    'other-shows-2016-2019': {
    'other-shows-law-of-jungle': ["video-3231","video-3232","video-3233","video-3234","video-3235"],
    'other-shows-star-show-360': { allOf: ["video-2237","video-4826","video-4827"], weight: 1 },
    'other-shows-star-bromance-minwoo-jungkook': ["video-896","video-897","video-898","video-899","video-900"],
    'other-shows-star-bromance-taehyung-minche': ["video-1022","video-1023","video-1024","video-1026","video-1025"],
    'other-shows-star-king': ["video-3236","video-3237","video-3238"],
    'other-shows-hello-talkshow': ["video-2249"],
    'other-shows-running-man': ["video-1753"],
    'other-shows-take-care-of-my-fridge': ["video-2240","video-2241"],
    'other-shows-cultwo': ["video-3224","video-3225","video-3226"],
    'other-shows-james-corden': ["video-947"]
  },
     'other-shows-2020-2022': {
    'other-shows-maplestory-bts': ["video-218","video-220","video-243"],
    'other-shows-maplestory-jin': ["video-3007","video-3011","video-3017"],
    'other-shows-i-land-ep7': { allOf: ["video-3909","video-3910","video-3911","video-3912","video-3913","video-3914","video-3915","video-3917","video-3919","video-3920","video-3921","video-3922","video-3923"], weight: 1 },
    'other-shows-i-land-ep12': { allOf: ["video-3924","video-3925","video-3926","video-3927"], weight: 1 },    'other-shows-tokopedia': ["video-290","video-314","video-760","video-1164","video-1166"],
    'other-shows-made-collection': ["video-1980","video-1998","video-1997","video-1996","video-2028","video-2023","video-2031","video-2003","video-2002","video-2004","video-2001","video-2027","video-2024","video-2032"],
    'other-shows-mbti-lab': ["video-2655","video-2688"],
    'other-shows-in-the-seom': ["video-2595","video-2624","video-2710","video-2711"],
    'other-shows-cookie-run': ["video-3185","video-3187"],
    'other-shows-running-man': ["video-3292"],
    'other-shows-workout': ["video-2654","video-2689","video-2709"],
    'other-shows-kiss-the-radio': ["video-2876"],
    'other-shows-jimmy-fallon': ["video-3163","video-1094"],
    'other-shows-james-corden': ["video-948","video-946","video-2239"],    
    'other-shows-lee-hyun-manager': ["video-991","video-1032"],
    'other-shows-game-of-money': ["video-3129","video-3140"],
    'other-shows-drinking-party': ["video-3298","video-3299","video-3304","video-3305"],
       'other-shows-useless-knowledge-dictionary': ["video-3549","video-3583","video-3709","video-3710","video-3742"]
  },
  'other-shows-2023-2024': {
    'other-shows-useless-knowledge-dictionary': ["video-3758","video-3771","video-3775","video-3896"],
    'other-shows-kitchen-yoon': ["video-3737","video-3757","video-3772","video-3794","video-3808","video-3828","video-3874","video-3933","video-3950","video-3985","video-4008","video-3708","video-3761","video-4270","video-4282"],
    'other-shows-jimmy-fallon-chimin': { allOf: ["video-3801","video-3805","video-3812","video-3809"], weight: 1 },
    'other-shows-jimmy-fallon-yoongi': { allOf: ["video-4004","video-3994","video-3999","video-4000"], weight: 1 },
    'other-shows-spotify-taehyung': ["video-4998","video-4213"],
    'other-shows-running-man': ["video-4224","video-4404","video-4425"],
    'other-shows-jimmy-fallon-jungkook': { allOf: ["video-4314","video-4311","video-4312"], weight: 1 },
    'other-shows-halfstar-hotel': ["video-4776","video-4801"],
    'other-shows-jimmy-fallon-jin': { allOf: ["video-4891","video-59797","video-59822","video-4890","video-4961"], weight: 1 },
      'other-shows-handsome-guys': ["video-4954","video-4958"]
  },
  'other-shows-2025': {
    'other-shows-handsome-guys': ["video-4987","video-4988","video-series23"],
    'other-shows-live-alone': ["video-5016","video-5036"],
    'other-shows-take-care-of-my-fridge-2025': ["video-5024","video-5621"],
    'other-shows-jimmy-fallon-hoseok': { allOf: ["video-5045","video-5046","video-5047","video-5033"], weight: 1 },
    'other-shows-kian-guesthouse': ["video-5079","video-5084","video-5099","video-5111","video-5113","video-5117","video-5118","video-5119","video-5128"],
    'other-shows-jimmy-fallon-jin-2025': { allOf: ["video-5132","video-5130","video-5131"], weight: 1 },
        'other-shows-omniscient-interfering-view': ["video-5169","video-5228"]
  },
  'other-shows-2026': {
    'other-shows-jimmy-fallon-bts-2026': { allOf: ["video-5465","video-5466","video-5467","video-5468","video-5447","video-5446"], weight: 1 },
    'other-shows-rolling-stone': ["video-5553","video-5491","video-5492","video-5488","video-5483","video-5489","video-5490","video-5482"]
  }
};

// Вызывается на "довесочной" странице (например running-man.html) —
// пересчитывает её вклад во все года, куда она входит, и сразу шлёт в облако
const YEAR_OWN_TOTALS = {
  'other-shows-2013-2015': 9,
  'other-shows-2016-2019': 17,
  'other-shows-2020-2022': 12,
  'other-shows-2023-2024': 26,
  'other-shows-2025': 10,
   'other-shows-2026': 13
};

  const STAT_TOTALS = {
    'jungkook-2016-2022': 19,
    'jungkook-2023-2024': 34,
    'jungkook-2025-2026': 27,
    'taehyung-2015-2022': 25,
    'taehyung-2023-2024': 33,
    'taehyung-2025': 25,
    'taehyung-2026': 8,
    'comeback': 28,
    'jin-2015-2022': 29,
    'jin-2023-2025': 18,
    'jin-2026-HB': 1,
    'namjoon-2015-2022': 30,
    'namjoon-2023-2025': 17,
    'namjoon-2026-HB': 2,
    'hoseok-2015-2022': 24,
    'hoseok-2023-2025': 41,
    'hoseok-2026-HB': 4,
    'radio': 11,
    'jimin-2015-2022': 23,
    'jimin-2023-2026': 18,
    'yoongi-2015-2022': 25,
    'yoongi-2023-2026': 15,
    'ot7-2015-2017': 32,
    'ot7-2018-2022': 27,
    'ot7-2023-2026': 13,
    'somepeople-2015': 16,
    'somepeople-2016': 16,
    'somepeople-2017-2019': 12,
    'somepeople-2020-2022': 19,
    'somepeople-2023-2025': 20,
    'somepeople-2026': 6,
    'vlog-jungkook': 14,
    'vlog-v': 13,
    'vlog-jin': 13,
    'vlog-jimin': 23,
    'vlog-namjoon': 25,
    'vlog-suga': 18,
    'vlog-jhope': 18,
    'vlog-ot7': 5,
    'vlog-somepeople': 28,
    'eatjin': 24,
    'logon': 24,
    'vlogsbts-jimin': 3,
    'vlogsbts-jin': 6,
    'vlogsbts-taehyung': 10,
      'vlogsbts-jungkook': 7,
    'vlogsbts-jungkook-with-gcf': 15,
    'vlogsbts-namjoon': 8,
    'vlogsbts-yoongi': 9,
    'vlogsbts-hoseok': 3,
    'gcf': 9,
      'normal-log': 7,
  'run-bts-1-25': 26,
  'run-bts-26-50': 25,
  'run-bts-51-80': 30,
  'run-bts-81-111': 32,
  'run-bts-112-135': 24,
  'run-bts-136-155': 22,
  'run-bts-156-165': 10,
  'run-jin-1-25': 25,
  'run-jin-26-36': 11,
  'run-bts-2-0-1-25': 7,
  'bon-voyage-s1': 9,
  'bon-voyage-s2': 8,
  'bon-voyage-s3': 10,
  'bon-voyage-s4': 9,
  'in-the-soop-s1': 16,
  'in-the-soop-s2': 11,
  'in-the-soop-friendcation': 4,
  'are-you-sure-s1': 11,
  'are-you-sure-s2': 14,
  'bts-gayo': 15,
  'american-hustle-life-episodes': 8,
  'rookie-king': 8,
  'suchwita': 27,
  'universe-bt21-s1': 13,
  'universe-bt21-s2': 9,
  'universe-bt21-s2-animation': 10,
  'universe-bt21-s3': 11,
  'universe-bt21-s3-animation': 8,
    'universe-bt21-inside-manga': 15,
  'clips-2013-2015': 15,
  'clips-2016-2018': 30,
  'clips-2019-2021': 20,
  'clips-2022-2023': 21,
  'clips-2024-2025': 11,
  'clips-2026-2027': 2,
  'clips-japan': 13,
  'clips-mixtape': 11,
  'clips-standalone': 39,
  'bombs-2013-june': 4,
  'bombs-2013-july': 17,
  'bombs-2013-august': 12,
  'bombs-2013-september': 2,
  'bombs-2013-october': 15,
  'bombs-2013-november': 11,
  'bombs-2024': 13,
  'bombs-2025': 6,
  'bombs-2026': 3,
  'bts-episode-1-50': 50,
  'bts-episode-51-100': 50,
  'bts-episode-101-150': 50,
  'bts-episode-151-194': 44,
  'bts-episode-other-jimin': 10,
  'bts-episode-other-jungkook': 12,
  'bts-episode-other-hoseok': 11,
  'bts-episode-other-yoongi': 5,
  'bts-episode-other-namjoon': 1,
  'bts-episode-other-jin': 11,
  'bts-episode-other-taehyung': 8,
  'bts-episode-other-somepeople': 24,
  'reaction-to-self': 31,
  'photo-folio-jungkook': 2,
  'photo-folio-namjoon': 3,
  'photo-folio-jimin': 2,
  'photo-folio-common': 2,
  'photo-folio-jin': 2,
  'photo-folio-taehyung': 2,
  'photo-folio-hoseok': 2,
  'photo-folio-yoongi': 4,
  'photo-folio-extra': 2,
    'album-review': 11,
  'message-from-jin': 15,
    'td-stories': 5,
  'bts-memories-2014': 9,
  'bts-memories-2015': 13,
  'bts-memories-2016': 16,
  'bts-memories-2017': 22,
  'bts-memories-2018': 36,
  'bts-memories-2019': 35,
  'bts-memories-2020': 48,
    'bts-memories-7moments': 8,
  'season-summer': 5,
  'season-winter': 2,
  'season-greeting': 8,
    'bts-now': 3,
  'halloween': 8,
  'hwarang': 32,
  'beginns-youth': 12,
  'translations-2cool4skool': 9,
  'translations-orul82': 10,
  'translations-skoolluvaffair': 2,
  'translations-golden': 49,
  'translations-hots': 15,
  'mcountdown-2013': 11,
  'mcountdown-2014': 17,
  'mcountdown-2015': 8,
  'mcountdown-2016': 12,
  'mcountdown-2017': 10,
  'mcountdown-2018': 4,
  'mcountdown-2019': 3,
  'mcountdown-2020': 2,
  'mcountdown-2022': 2,
  'mcountdown-2023': 3,
    'mcountdown-2025': 1,
  'sleepy-interview': 7,
  'interviews-2026': 2,
  'learn-korean': 20,
    'fm-0613': 16,
  'bts-festa-2014': 5,
  'bts-festa-2015': 7,
  'bts-festa-2016': 18,
  'bts-festa-2017': 11,
  'bts-festa-2018': 14,
  'bts-festa-2019': 10,
  'bts-festa-2020': 10,
  'bts-festa-2021': 12,
  'bts-festa-2022': 16,
  'bts-festa-2023': 16,
  'bts-festa-2024': 9,
  'bts-festa-2025': 11,
    'bts-festa-2026': 13,
  'concert-hyyh-on-stage': 4,
  'concert-hyyh-epilogue': 5,
  'concert-hyyh-epilogue-japan': 3,
  'concert-wings-seoul': 6,
  'concert-wings-final': 5,
  'concert-wings-japan': 4,
  'concert-wt-love-yourself-seoul': 7,
  'concert-wt-love-yourself-europe': 2,
  'concert-wt-love-yourself-ny': 2,
  'concert-lysy-seoul-final-dvd': 12,
  'concert-arirang-tour': 11,
  'concert-runseokjin-ep-tour': 2,
  'fm-3rd-muster': 3,
    'fm-jp-vol3': 8,
  'other-shows-star-bromance-minwoo-jungkook': 5,
      'other-shows-star-bromance-taehyung-minche': 5,
    'other-shows-running-man': 6,
  'other-shows-kiss-the-radio': 7,
  'other-shows-hello-talkshow': 2,
  'other-shows-useless-knowledge-dictionary': 9,
  'other-shows-handsome-guys': 5,
  'other-shows-cultwo': 4,
  'other-shows-james-corden': 4,
  'documentaries-break-the-silence': 9,
  'documentaries-bring-the-soul': 8,
  'documentaries-bts-monuments': 8,
  'documentaries-burn-the-stage': 9,
  'documentaries-hope-on-the-street': 6,
  'documentaries-jhope-in-the-box': 8,
  'documentaries-jimin-production-diary': 11,
  'documentaries-jungkook-i-am-still': 3,
  'documentaries-suga-road-to-dday': 7
};
 const VLIVE_TRANSLATION_MEMBERS = [
  { name: 'Чонгук', keys: ['jungkook-2016-2022','jungkook-2023-2024','jungkook-2025-2026'] },
  { name: 'Тэхён', keys: ['taehyung-2015-2022','taehyung-2023-2024','taehyung-2025','taehyung-2026'] },
  { name: 'Джин', keys: ['jin-2015-2022','jin-2023-2025','jin-2026-HB'] },
  { name: 'Намджун', keys: ['namjoon-2015-2022','namjoon-2023-2025','namjoon-2026-HB'] },
  { name: 'Хосок', keys: ['hoseok-2015-2022','hoseok-2023-2025','hoseok-2026-HB'] },
  { name: 'Чимин', keys: ['jimin-2015-2022','jimin-2023-2026'] },
  { name: 'Юнги', keys: ['yoongi-2015-2022','yoongi-2023-2026'] },
  { name: 'Несколько человек', keys: ['somepeople-2015','somepeople-2016','somepeople-2017-2019','somepeople-2020-2022','somepeople-2023-2025','somepeople-2026'] },
  { name: 'ОТ7 (все вместе)', keys: ['ot7-2015-2017','ot7-2018-2022','ot7-2023-2026'] },
  { name: 'Радио', keys: ['radio'] },
  { name: 'Comeback', keys: ['comeback'] }
];
 const YOUTUBE_TRANSLATION_MEMBERS = [
  { name: 'Чонгук', keys: ['vlog-jungkook'] },
  { name: 'Тэхён', keys: ['vlog-v'] },
  { name: 'Джин', keys: ['vlog-jin','eatjin'] },
  { name: 'Чимин', keys: ['vlog-jimin'] },
  { name: 'Намджун', keys: ['vlog-namjoon','logon'] },
  { name: 'Юнги', keys: ['vlog-suga'] },
  { name: 'Хосок', keys: ['vlog-jhope'] },
  { name: 'ОТ7', keys: ['vlog-ot7'] },
  { name: 'Несколько человек', keys: ['vlog-somepeople'] }
];
 function flattenBranchKeys(nodes) {
  const keys = [];
  (nodes || []).forEach(function (node) {
    if (node.children && node.children.length) {
      flattenBranchKeys(node.children).forEach(function (key) { keys.push(key); });
    } else if (node.keys && node.keys.length) {
      node.keys.forEach(function (key) { keys.push(key); });
    }
  });
  return keys;
}
 const SECTION_TREE = [
  {
    name: 'Трансляции',
    children: [
      { name: 'с Vlive и Weverse', children: VLIVE_TRANSLATION_MEMBERS },
      { name: 'с ютуба', children: YOUTUBE_TRANSLATION_MEMBERS }
    ]
  }
 ];
 SECTION_TREE.forEach(function fillBranchKeys(node) {
   if (node.children && node.children.length) {
     node.children.forEach(fillBranchKeys);
     node.keys = flattenBranchKeys(node.children);
   }
 });
 const SECTION_GROUPS = {
  'Различные шоу': [
    'run-bts-1-25','run-bts-26-50','run-bts-51-80','run-bts-81-111','run-bts-112-135','run-bts-136-155','run-bts-156-165',
    'run-jin-1-25','run-jin-26-36','run-bts-2-0-1-25',
    'bon-voyage-s1','bon-voyage-s2','bon-voyage-s3','bon-voyage-s4',
    'in-the-soop-s1','in-the-soop-s2','in-the-soop-friendcation',
    'are-you-sure-s1','are-you-sure-s2',
    'bts-gayo','american-hustle-life-episodes','rookie-king','suchwita',
    'universe-bt21-s1','universe-bt21-s2','universe-bt21-s2-animation','universe-bt21-s3','universe-bt21-s3-animation','universe-bt21-inside-manga'
  ],
  'BangtanTV': [
    'clips-2013-2015','clips-2016-2018','clips-2019-2021','clips-2022-2023','clips-2024-2025','clips-2026-2027','clips-japan','clips-mixtape','clips-standalone',
    'bombs-2013-june','bombs-2013-july','bombs-2013-august','bombs-2013-september','bombs-2013-october','bombs-2013-november','bombs-2024','bombs-2025','bombs-2026',
    'bts-episode-1-50','bts-episode-51-100','bts-episode-101-150','bts-episode-151-194',
    'bts-episode-other-jimin','bts-episode-other-jungkook','bts-episode-other-hoseok','bts-episode-other-yoongi','bts-episode-other-namjoon','bts-episode-other-jin','bts-episode-other-taehyung','bts-episode-other-somepeople',
    'reaction-to-self',
    'photo-folio-jungkook','photo-folio-namjoon','photo-folio-jimin','photo-folio-common','photo-folio-jin','photo-folio-taehyung','photo-folio-hoseok','photo-folio-yoongi','photo-folio-extra',
    'album-review','message-from-jin',
    'vlogsbts-jimin','vlogsbts-jin','vlogsbts-taehyung','vlogsbts-jungkook','vlogsbts-namjoon','vlogsbts-yoongi','vlogsbts-hoseok',
    'gcf','normal-log'
  ],
  'BTS Memories': [
    'bts-memories-2014','bts-memories-2015','bts-memories-2016','bts-memories-2017','bts-memories-2018','bts-memories-2019','bts-memories-2020','bts-memories-7moments'
  ],
  'Спецвыпуски': [
    'season-summer','season-winter','season-greeting','bts-now'
  ],
  'Документальные проекты': [
    'documentaries-break-the-silence','documentaries-bring-the-soul','documentaries-bts-monuments','documentaries-burn-the-stage','documentaries-hope-on-the-street','documentaries-jhope-in-the-box','documentaries-jimin-production-diary','documentaries-jungkook-i-am-still','documentaries-suga-road-to-dday'
  ],
  'Всякое другое': [
    'sleepy-interview','interviews-2026','learn-korean','fm-0613','halloween','hwarang','beginns-youth','td-stories',
    'translations-2cool4skool','translations-orul82','translations-skoolluvaffair','translations-golden','translations-hots',
    'mcountdown-2013','mcountdown-2014','mcountdown-2015','mcountdown-2016','mcountdown-2017','mcountdown-2018','mcountdown-2019','mcountdown-2020','mcountdown-2022','mcountdown-2023','mcountdown-2025'
  ],
  'BTS FESTA': [
    'bts-festa-2014','bts-festa-2015','bts-festa-2016','bts-festa-2017','bts-festa-2018','bts-festa-2019','bts-festa-2020','bts-festa-2021','bts-festa-2022','bts-festa-2023','bts-festa-2024','bts-festa-2025','bts-festa-2026'
  ]
};

function countTrueIds(ids) {
  let n = 0;
  (ids || []).forEach((id) => { if (localStorage.getItem(id) === 'true') n++; });
  return n;
}

function progressForKey(key) {
  const known = getStatTotal(key);
  const ids = (typeof STAT_CHECKBOX_IDS !== 'undefined' && STAT_CHECKBOX_IDS[key]) ? STAT_CHECKBOX_IDS[key] : null;
  const raw = localStorage.getItem('progress:' + key);
  const data = raw ? JSON.parse(raw) : null;
  if (ids && ids.length) {
    return { checked: countTrueIds(ids), total: known !== null ? known : ids.length };
  }
  if (known !== null) {
    return { checked: data ? data.checked : 0, total: known };
  }
  if (data) return { checked: data.checked, total: data.total };
  return { checked: 0, total: 0 };
}

function computeSectionProgress(keys) {
  const seen = {};
  let checked = 0, total = 0;
  const withoutIds = [];
  keys.forEach((key) => {
    const ids = (typeof STAT_CHECKBOX_IDS !== 'undefined') ? STAT_CHECKBOX_IDS[key] : null;
    if (ids && ids.length) {
      ids.forEach((id) => {
        if (seen[id]) return;
        seen[id] = true;
        total++;
        if (localStorage.getItem(id) === 'true') checked++;
      });
    } else {
      withoutIds.push(key);
    }
  });
  withoutIds.forEach((key) => {
    const s = progressForKey(key);
    total += s.total;
    checked += s.checked;
  });
  return { checked, total };
}

function computeOtherShowsProgress() {
  let checked = 0, total = 0;
  ['other-shows-2013-2015','other-shows-2016-2019','other-shows-2020-2022','other-shows-2023-2024','other-shows-2025','other-shows-2026'].forEach((yearKey) => {
    const stats = getCombinedYearStats(yearKey);
    checked += stats.checked;
    total += stats.total;
  });
  return { checked, total };
}

function getStatTotal(key) {
    return STAT_TOTALS.hasOwnProperty(key) ? STAT_TOTALS[key] : null;
  }

  function getKnownTotalForKey(key) {
    for (const yearKey in YEAR_WEIGHTED_MAP) {
      const entry = YEAR_WEIGHTED_MAP[yearKey][key];
      if (entry) {
        return Array.isArray(entry) ? entry.length : entry.weight;
      }
    }
    return null;
  }

function pushWeightedContributions(sourceKey) {
  Object.keys(YEAR_WEIGHTED_MAP).forEach((yearKey) => {
    const entry = YEAR_WEIGHTED_MAP[yearKey][sourceKey];
    if (!entry) return;
    let checked, total;
    if (Array.isArray(entry)) {
      total = entry.length;
      checked = 0;
      entry.forEach((id) => { if (localStorage.getItem(id) === 'true') checked++; });
    } else if (entry.allOf) {
      total = entry.weight;
      const allDone = entry.allOf.every((id) => localStorage.getItem(id) === 'true');
      checked = allDone ? entry.weight : 0;
    }
    setProgress(yearKey + ':weighted:' + sourceKey, { checked, total });
  });
}

  // Считает итоговую цифру года: свои пункты + все довески
// "Всего" всегда известно заранее из YEAR_WEIGHTED_MAP — не зависит от того, заходил ли человек на страницу-довесок
function getCombinedYearStats(yearKey) {
  let checked = 0, total = 0;
  const ownIds = (typeof STAT_CHECKBOX_IDS !== 'undefined') ? STAT_CHECKBOX_IDS[yearKey] : null;
  const own = localStorage.getItem('progress:' + yearKey + ':own');
  if (ownIds && ownIds.length) {
    total += YEAR_OWN_TOTALS[yearKey] != null ? YEAR_OWN_TOTALS[yearKey] : ownIds.length;
    checked += countTrueIds(ownIds);
  } else if (own) {
    const d = JSON.parse(own);
    checked += d.checked;
    total += YEAR_OWN_TOTALS[yearKey] != null ? YEAR_OWN_TOTALS[yearKey] : d.total;
  } else if (YEAR_OWN_TOTALS[yearKey]) {
    total += YEAR_OWN_TOTALS[yearKey];
  }
  const sources = YEAR_WEIGHTED_MAP[yearKey] || {};
  Object.keys(sources).forEach((src) => {
    const entry = sources[src];
    if (Array.isArray(entry)) {
      total += entry.length;
      checked += countTrueIds(entry);
    } else if (entry && entry.allOf) {
      total += entry.weight;
      const allDone = entry.allOf.every((id) => localStorage.getItem(id) === 'true');
      if (allDone) checked += entry.weight;
    }
  });
  return { checked, total };
}

  if (!ARMY_OUTSIDE_TELEGRAM) {
    checkForUpdate();
  }

  function armyQueryParam(raw, key) {
    if (!raw) return '';
    try {
      return new URLSearchParams(String(raw).replace(/^\?/, '').replace(/^#/, '')).get(key) || '';
    } catch (e) {
      return '';
    }
  }

  function armyStartParam() {
    const tg = window.Telegram && window.Telegram.WebApp;
    const found = [];
    try {
      found.push(armyQueryParam(location.hash, 'tgWebAppStartParam'));
      found.push(armyQueryParam(location.hash, 'startapp'));
      found.push(armyQueryParam(location.search, 'tgWebAppStartParam'));
      found.push(armyQueryParam(location.search, 'startapp'));
    } catch (e) {}
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) {
      found.push(String(tg.initDataUnsafe.start_param));
    }
    if (tg && tg.initData) {
      found.push(armyQueryParam(tg.initData, 'start_param'));
    }
    for (let i = 0; i < found.length; i++) {
      const p = String(found[i] || '').trim();
      if (p && /^[a-zA-Z0-9_-]{1,64}$/.test(p)) return p;
    }
    return '';
  }

  function armyStartTarget(param) {
    const aliases = {
      'runseokjin': 'concert-runseokjin-ep-tour.html',
      'jin-tour': 'concert-runseokjin-ep-tour.html',
      'arirang': 'concert-arirang-tour.html',
      'concerts-2025': 'concerts-2025-2026.html',
      'concerts': 'concerts.html',
      'statistics': 'statistics.html',
      'cabinet': 'statistics.html',
      'kabinet': 'statistics.html',
      'stats': 'my-stats.html',
      'mystats': 'my-stats.html',
      'my-stats': 'my-stats.html',
      'payment': 'payment.html',
      'pay': 'payment.html',
      'oplata': 'payment.html',
      'friend': 'referral.html',
      'referral': 'referral.html',
      'invite': 'referral.html',
      'receipts': 'admin-receipts.html',
      'admin-receipts': 'admin-receipts.html',
      'cheki': 'admin-receipts.html',
      'admin-stats': 'admin-stats.html',
      'adminstats': 'admin-stats.html'
    };
    const key = String(param || '').toLowerCase();
    let target = aliases[key];
    if (!target) target = key.replace(/\.html$/, '') + '.html';
    if (!/^[a-z0-9_-]+\.html$/.test(target)) return '';
    return target;
  }

  function armyAbsPage(file) {
    let path = location.pathname || '/';
    const last = (path.split('/').pop() || '').toLowerCase();
    if (path.endsWith('/')) return path + file;
    if (last.endsWith('.html')) return path.replace(/[^/]+$/, file);
    return path + '/' + file;
  }

  function armyCurrentFile() {
    const parts = location.pathname.split('/').filter(Boolean);
    return (parts[parts.length - 1] || '').toLowerCase();
  }

  function armyOpenFromStartParam() {
    const param = armyStartParam();
    if (!param) return;
    const target = armyStartTarget(param);
    if (!target) return;
    const current = armyCurrentFile();
    if (current === target) {
      try { sessionStorage.setItem('armyStartLanded', param); } catch (e) {}
      return;
    }
    var forcePayOrCabinet = (target === 'payment.html' || target === 'statistics.html' || target === 'referral.html');
    if (!isArmyHomePage() && !forcePayOrCabinet) return;
    let landed = '';
    try { landed = sessionStorage.getItem('armyStartLanded') || ''; } catch (e) {}
    if (landed === param) return;
    if (window.__armyStartOpening === param) return;
    window.__armyStartOpening = param;
    location.replace(armyAbsPage(target));
    setTimeout(function () {
      if (isArmyHomePage() && window.__armyStartOpening === param) {
        window.__armyStartOpening = '';
      }
    }, 400);
  }

  function isArmyHomePage() {
    const file = armyCurrentFile();
    return !file || file === 'index.html' || file === 'army_checklist';
  }

  function armyScheduleStartOpen() {
    armyOpenFromStartParam();
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && typeof tg.ready === 'function') {
      try { tg.ready(); } catch (e) {}
      if (typeof tg.onEvent === 'function') {
        tg.onEvent('activated', armyOpenFromStartParam);
      }
    }
    window.addEventListener('hashchange', armyOpenFromStartParam);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') armyOpenFromStartParam();
    });
    [50, 150, 300, 600, 1000, 1600, 2500, 4000].forEach(function (ms) {
      setTimeout(armyOpenFromStartParam, ms);
    });
  }
  armyScheduleStartOpen();

  function armyCameFromStartLink() {
    try { return !!sessionStorage.getItem('armyStartDone'); } catch (e) { return false; }
  }

  function armyParentHref() {
    const link = document.querySelector('a.back[href]');
    if (link) {
      const href = link.getAttribute('href');
      if (href && href !== '#') return href;
    }
    return 'index.html';
  }

  function armyNavigateBack() {
    if (window.__armyLeaving) return;
    window.__armyLeaving = true;
    const href = armyParentHref();
    setTimeout(function () {
      location.assign(href);
    }, 0);
    setTimeout(function () {
      window.__armyLeaving = false;
    }, 1200);
  }

  function armyEnsureSwipeHistory() {
    if (isArmyHomePage()) return;
    if (window.__armySwipeHistory) return;
    window.__armySwipeHistory = true;
    try {
      history.pushState({ armyLock: 1 }, '', location.href);
    } catch (e) {}
    window.addEventListener('popstate', function () {
      if (window.__armyLeaving) return;
      armyNavigateBack();
    });
  }

  function setupTelegramHistoryBack() {
    if (window.__armyTgBackSetup) return;
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.BackButton) return;
    window.__armyTgBackSetup = true;
    try {
      tg.ready();
      tg.expand();
    } catch (e) {}
    tg.BackButton.onClick(armyNavigateBack);
    if (isArmyHomePage()) tg.BackButton.hide();
    else tg.BackButton.show();
  }

  function setupIosEdgeBackSwipe() {
    if (window.__armyIosEdgeBack) return;
    if (isArmyHomePage()) return;
    const tg = window.Telegram && window.Telegram.WebApp;
    const platform = tg && tg.platform ? String(tg.platform).toLowerCase() : '';
    if (platform === 'tdesktop' || platform === 'macos') return;
    window.__armyIosEdgeBack = true;
    let startX = 0;
    let startY = 0;
    let edge = '';
    let tracking = false;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) {
        tracking = false;
        edge = '';
        return;
      }
      const t = e.touches[0];
      const w = window.innerWidth || 0;
      if (t.clientX <= 56) edge = 'left';
      else if (w && t.clientX >= w - 56) edge = 'right';
      else {
        tracking = false;
        edge = '';
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
        tracking = false;
        edge = '';
        return;
      }
      const goingBack = (edge === 'left' && dx > 12) || (edge === 'right' && dx < -12);
      if (goingBack) {
        try { e.preventDefault(); } catch (err) {}
      }
    }, { passive: false });
    document.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      const from = edge;
      edge = '';
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dy) >= 50) return;
      if (from === 'left' && dx > 70) armyNavigateBack();
      if (from === 'right' && dx < -70) armyNavigateBack();
    }, { passive: true });
  }

  function setupArmyBackNav() {
    if (ARMY_OUTSIDE_TELEGRAM) return;
    setupTelegramHistoryBack();
    setupIosEdgeBackSwipe();
    armyEnsureSwipeHistory();
  }

  if (!ARMY_OUTSIDE_TELEGRAM) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupArmyBackNav);
    } else {
      setupArmyBackNav();
    }
  }