  // sync.js — общая логика облачной синхронизации через Firebase
  const FIREBASE_URL = "https://army-checklist-default-rtdb.firebaseio.com";
  var STAT_CHECKBOX_IDS = {};
  let ARMY_USER_ID = null;
  if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
    ARMY_USER_ID = window.Telegram.WebApp.initDataUnsafe.user.id;
  }
  // Регистрация нового пользователя (один раз на каждого человека)
function registerUserIfNeeded() {
  if (!ARMY_USER_ID) return;

  fetch(`${FIREBASE_URL}/user_registry/${ARMY_USER_ID}.json`)
    .then(res => res.json())
    .then(existing => {
      if (existing && existing.number) {
        // уже был зарегистрирован раньше (с этого или другого устройства) — просто запоминаем локально
        localStorage.setItem('userNumber_' + ARMY_USER_ID, existing.number);
        localStorage.setItem('userFirstSeen_' + ARMY_USER_ID, existing.firstSeen);
        return;
      }
      // новый пользователь — узнаём текущий счётчик и увеличиваем
           fetch(`${FIREBASE_URL}/user_count.json`)
        .then(res => res.json())
        .then(count => {
          const newNumber = (count || 0) + 1;
          const firstSeen = Date.now();
          fetch(`${FIREBASE_URL}/user_count.json`, {
            method: 'PUT',
            body: JSON.stringify(newNumber),
            keepalive: true
          });
          fetch(`${FIREBASE_URL}/user_registry/${ARMY_USER_ID}.json`, {
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
        if (!data) { if (callback) callback(); return; }
        Object.keys(data).forEach(function(k) {
          if (k.indexOf('progress:') === 0) {
            localStorage.setItem(k, JSON.stringify(data[k]));
          }
        });
        if (callback) callback();
      })
      .catch(() => {});
  }

  // Полностью перезаписывает ВСЮ локальную память данными этого аккаунта из облака —
  // и отдельные галочки (video-...), и итоговые цифры (progress:...)
  function refreshEverythingFromCloud(callback) {
    if (!ARMY_USER_ID) { if (callback) callback(); return; }
    fetch(`${FIREBASE_URL}/users/${ARMY_USER_ID}.json`)
      .then(res => res.json())
      .then(data => {
        if (!data) { if (callback) callback(); return; }
        Object.keys(data).forEach(function(k) {
          if (k.indexOf('progress:') === 0) {
            localStorage.setItem(k, JSON.stringify(data[k]));
          } else {
            localStorage.setItem(k, data[k]);
          }
        });
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
   'other-shows-2026': 12
};

  const STAT_TOTALS = {
    'jungkook-2016-2022': 19,
    'jungkook-2023-2024': 34,
    'jungkook-2025-2026': 27,
    'taehyung-2015-2022': 25,
    'taehyung-2023-2024': 33,
    'taehyung-2025': 25,
    'taehyung-2026': 6,
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
    'jimin-2023-2026': 17,
    'yoongi-2015-2022': 25,
    'yoongi-2023-2026': 15,
    'ot7-2015-2017': 32,
    'ot7-2018-2022': 27,
    'ot7-2023-2026': 12,
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
    'vlogsbts-taehyung': 9,
      'vlogsbts-jungkook': 7,
    'vlogsbts-jungkook-with-gcf': 15,
    'vlogsbts-namjoon': 6,
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
  'run-bts-2-0-1-25': 5,
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
  'bts-episode-other-somepeople': 21,
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
  'concert-arirang-tour': 10,
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
 const SECTION_GROUPS = {
  'Все трансляции': [
    'jungkook-2016-2022','jungkook-2023-2024','jungkook-2025-2026',
    'taehyung-2015-2022','taehyung-2023-2024','taehyung-2025','taehyung-2026',
    'comeback',
    'jin-2015-2022','jin-2023-2025','jin-2026-HB',
    'namjoon-2015-2022','namjoon-2023-2025','namjoon-2026-HB',
    'hoseok-2015-2022','hoseok-2023-2025','hoseok-2026-HB',
    'radio',
    'jimin-2015-2022','jimin-2023-2026',
    'yoongi-2015-2022','yoongi-2023-2026',
    'ot7-2015-2017','ot7-2018-2022','ot7-2023-2026',
    'somepeople-2015','somepeople-2016','somepeople-2017-2019','somepeople-2020-2022','somepeople-2023-2025','somepeople-2026'
  ],
  'Трансляции с YouTube': [
    'vlog-jungkook','vlog-v','vlog-jin','vlog-jimin','vlog-namjoon','vlog-suga','vlog-jhope','vlog-ot7','vlog-somepeople',
    'eatjin','logon',
    'vlogsbts-jimin','vlogsbts-jin','vlogsbts-taehyung','vlogsbts-jungkook','vlogsbts-namjoon','vlogsbts-yoongi','vlogsbts-hoseok',
    'gcf','normal-log'
  ],
  'Концерты BTS': [
    'concert-hyyh-on-stage','concert-hyyh-epilogue','concert-hyyh-epilogue-japan',
    'concert-wings-seoul','concert-wings-final','concert-wings-japan',
    'concert-wt-love-yourself-seoul','concert-wt-love-yourself-europe','concert-wt-love-yourself-ny',
    'concert-lysy-seoul-final-dvd','concert-arirang-tour',
    'fm-3rd-muster','fm-jp-vol3'
  ],
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
    'album-review','message-from-jin'
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
    'sleepy-interview','learn-korean','fm-0613','halloween','hwarang','beginns-youth','td-stories',
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

  checkForUpdate();