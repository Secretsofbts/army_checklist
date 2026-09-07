// sync.js — общая логика облачной синхронизации через Firebase
const FIREBASE_URL = "https://army-checklist-default-rtdb.firebaseio.com";
let ARMY_USER_ID = null;
if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
  ARMY_USER_ID = window.Telegram.WebApp.initDataUnsafe.user.id;
}

function saveToCloudWithRetry(path, value, attempt) {
  attempt = attempt || 1;
  fetch(`${FIREBASE_URL}/${path}.json`, {
    method: 'PUT',
    body: JSON.stringify(value),
    keepalive: true
  }).catch(() => {
    if (attempt < 3) {
      setTimeout(() => saveToCloudWithRetry(path, value, attempt + 1), 1000 * attempt);
    }
  });
}

function setChecked(id, value) {
  localStorage.setItem(id, value);
  if (ARMY_USER_ID) {
    saveToCloudWithRetry(`users/${ARMY_USER_ID}/${id}`, value);
  }
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
  fetch(`${FIREBASE_URL}/users/${ARMY_USER_ID}.json`)
    .then(res => res.json())
    .then(data => {
      if (!data) return;
      let changed = false;
      document.querySelectorAll('[data-id]').forEach((row) => {
        const id = row.dataset.id;
        if (data[id] !== undefined && data[id] !== (localStorage.getItem(id) === 'true')) {
          const box = row.querySelector('input[type="checkbox"]');
          const span = row.querySelector('.text');
          if (box) box.checked = data[id];
          if (span) span.classList.toggle('done', data[id]);
          localStorage.setItem(id, data[id]);
          changed = true;
        }
      });
      if (changed && onChanged) onChanged();
    })
    .catch(() => {});
}

// Подтягивает бейджи статистики для страниц-хабов
function syncBadgesFromCloud(keys, applyFn) {
  if (!ARMY_USER_ID) return;
  fetch(`${FIREBASE_URL}/users/${ARMY_USER_ID}.json`)
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
  fetch(`${FIREBASE_URL}/users/${ARMY_USER_ID}.json`)
    .then(res => res.json())
    .then(data => {
      if (!data) return;
      Object.keys(data).forEach(function(k) {
        if (k.indexOf('progress:') === 0) {
          localStorage.setItem(k, JSON.stringify(data[k]));
        }
      });
      if (callback) callback();
    })
    .catch(() => {});
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
  }
};

// Вызывается на "довесочной" странице (например running-man.html) —
// пересчитывает её вклад во все года, куда она входит, и сразу шлёт в облако
function pushWeightedContributions(sourceKey) {
  Object.keys(YEAR_WEIGHTED_MAP).forEach((yearKey) => {
    const ids = YEAR_WEIGHTED_MAP[yearKey][sourceKey];
    if (!ids) return;
    let checked = 0;
    ids.forEach((id) => { if (localStorage.getItem(id) === 'true') checked++; });
    setProgress(yearKey + ':weighted:' + sourceKey, { checked, total: ids.length });
  });
}

// Считает итоговую цифру года: свои пункты + все довески
function getCombinedYearStats(yearKey) {
  let checked = 0, total = 0;
  const own = localStorage.getItem('progress:' + yearKey + ':own');
  if (own) {
    const d = JSON.parse(own);
    checked += d.checked;
    total += d.total;
  }
  const sources = YEAR_WEIGHTED_MAP[yearKey] || {};
  Object.keys(sources).forEach((src) => {
    const raw = localStorage.getItem('progress:' + yearKey + ':weighted:' + src);
    if (raw) {
      const d = JSON.parse(raw);
      checked += d.checked;
      total += d.total;
    }
  });
  return { checked, total };
}

checkForUpdate();