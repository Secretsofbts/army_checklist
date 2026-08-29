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