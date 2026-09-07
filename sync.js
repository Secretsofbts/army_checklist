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
    'other-shows-i-land': { allOf: ["video-3909","video-3910","video-3911","video-3912","video-3913","video-3914","video-3915","video-3917","video-3919","video-3920","video-3921","video-3922","video-3923"], weight: 1 },
    'other-shows-tokopedia': ["video-290","video-314","video-760","video-1164","video-1166"],
    'other-shows-made-collection': ["video-1980","video-1998","video-1997","video-1996","video-2028","video-2023","video-2031","video-2003","video-2002","video-2004","video-2001","video-2027","video-2024","video-2032"],
    'other-shows-mbti-lab': ["video-2655","video-2688"],
    'other-shows-in-the-seom': ["video-2595","video-2624","video-2710","video-2711"],
    'other-shows-cookie-run': ["video-3185","video-3187"],
    'other-shows-running-man': ["video-3292"],
    'other-shows-workout': ["video-2654","video-2689","video-2709"],
    'other-shows-kiss-the-radio': ["video-2876"],
    'other-shows-jimmy-fallon': ["video-3163","video-1094"],
    'other-shows-james-corden': ["video-946","video-2239"],
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
  }
};

// Вызывается на "довесочной" странице (например running-man.html) —
// пересчитывает её вклад во все года, куда она входит, и сразу шлёт в облако
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
  const own = localStorage.getItem('progress:' + yearKey + ':own');
  if (own) {
    const d = JSON.parse(own);
    checked += d.checked;
    total += d.total;
  }
  const sources = YEAR_WEIGHTED_MAP[yearKey] || {};
  Object.keys(sources).forEach((src) => {
    const entry = sources[src];
    const srcTotal = Array.isArray(entry) ? entry.length : entry.weight;
    total += srcTotal;
    const raw = localStorage.getItem('progress:' + yearKey + ':weighted:' + src);
    if (raw) {
      const d = JSON.parse(raw);
      checked += d.checked;
    }
  });
  return { checked, total };
}

  checkForUpdate();