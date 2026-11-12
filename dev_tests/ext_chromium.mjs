// Erweiterung in Chromium (Playwright) gegen nachgebaute Seiten - ohne Netz, ohne Opera, eigenes
// Testprofil (dev_tests/out/chromium_profile):
// - YouTube: SponsorBlock (überspringen, aneinanderliegende Abschnitte in einem Sprung, „Rückgängig“,
//   stumm, Zeitleiste, Highlight-Knopf, ganzes Video), Originalton, Shorts ausblenden und
//   Shorts-Links als normales Video, Dislikes, Einstellungen live aus dem Popup
// - Twitch: der Ad-Spoofing-Schalter im Popup erreicht den laufenden Player-Worker ohne Neuladen
// - Einstellungen: alte Einstellungen (Ad-Spoofing aus) werden einmal auf den neuen Stand gebracht
// SponsorBlock und Return YouTube Dislike antworten aus dem Service Worker mit festen Daten.
//
//   python tools/build_extension.py        (einmal, damit extension/generated/ da ist)
//   node dev_tests/ext_chromium.mjs [--headed] [--browser PFAD]
// Braucht Playwright (npm i -g playwright; ohne eigenes Chromium: --browser mit einem Chromium-
// Browser, der --load-extension noch kennt - Chrome-Stable nicht).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const PROFILE = path.join(HERE, 'out', 'chromium_profile');
const ID = 'dQw4w9WgXcQ';
const args = process.argv.slice(2);
const browserPath = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : undefined;

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK    ' : 'FEHLER'} ${name}${ok || detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

async function until(fn, ms = 5000, step = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, step));
  }
  return last instanceof Error ? false : last;
}

// SponsorBlock-Antwort: Sponsor 5-15 und Eigenwerbung 15.2-18 (ein Sprung), stumm 24-28, Highlight 40
const SPONSORBLOCK = [{
  videoID: ID,
  segments: [
    { segment: [5, 15], category: 'sponsor', actionType: 'skip', UUID: 's1', videoDuration: 60 },
    { segment: [15.2, 18], category: 'selfpromo', actionType: 'skip', UUID: 's2', videoDuration: 60 },
    { segment: [24, 28], category: 'sponsor', actionType: 'mute', UUID: 'm1', videoDuration: 60 },
    { segment: [50, 55], category: 'intro', actionType: 'skip', UUID: 'i1', videoDuration: 60 },  // nicht gewählt
    { segment: [40, 40], category: 'poi_highlight', actionType: 'poi', UUID: 'h1' },
    { segment: [0, 0], category: 'sponsor', actionType: 'full', UUID: 'f1' },
  ],
}];

function xtags(acont) {
  const kv = Buffer.concat([Buffer.from([0x0a, 5]), Buffer.from('acont'), Buffer.from([0x12, acont.length]), Buffer.from(acont)]);
  return Buffer.concat([Buffer.from([0x0a, kv.length]), kv]).toString('base64url');
}

// Watch-Seite mit dem Nötigsten von YouTube: Player (60 s Stille als WAV), Zeitleiste, Steuerleiste,
// Titel-Link, Dislike-Knopf, Shorts-Regal, und die Player-Schnittstelle für die Tonspuren
const WATCH = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>YouTube (Test)</title></head><body>
<div id="movie_player" class="html5-video-player" style="position:relative;width:640px;height:360px;background:#000">
  <div class="html5-video-container"><video class="html5-main-video" width="640" height="300"></video></div>
  <a class="ytp-title-link" href="https://www.youtube.com/watch?v=${ID}">Testvideo</a>
  <div class="ytp-chrome-bottom">
    <div class="ytp-progress-bar-container" style="position:relative;height:5px"><div class="ytp-progress-bar" style="position:relative;height:5px;background:#444"></div></div>
    <div class="ytp-left-controls" style="height:40px"></div>
  </div>
</div>
<ytd-watch-metadata><dislike-button-view-model><button id="dislike">Mag ich nicht</button></dislike-button-view-model></ytd-watch-metadata>
<ytd-reel-shelf-renderer id="shelf">Shorts-Regal</ytd-reel-shelf-renderer>
<ytd-rich-item-renderer id="shortItem"><a href="/shorts/abcdefghijk">Ein Short</a></ytd-rich-item-renderer>
<ytd-rich-item-renderer id="normalItem"><a href="/watch?v=abcdefghijk">Ein Video</a></ytd-rich-item-renderer>
<script>
  const rate = 8000, n = rate * 60, buf = new ArrayBuffer(44 + n), d = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); d.setUint32(4, 36 + n, true); str(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
  d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate, true); d.setUint16(32, 1, true);
  d.setUint16(34, 8, true); str(36, 'data'); d.setUint32(40, n, true);
  for (let i = 0; i < n; i++) d.setUint8(44 + i, 128);
  const video = document.querySelector('video');
  video.src = URL.createObjectURL(new Blob([buf], {type: 'audio/wav'}));
  video.play().catch(() => {});
  const p = document.getElementById('movie_player');
  const tracks = [{Xq: {id: 'de.3', name: 'Deutsch'}}, {Xq: {id: 'en.4', name: 'English'}}];
  let current = tracks[0];
  window.__track = 'de.3';
  p.getVideoData = () => ({video_id: '${ID}'});
  p.getAvailableAudioTracks = () => tracks;
  p.getAudioTrack = () => current;
  p.setAudioTrack = (t) => { current = t; window.__track = t.Xq.id; };
  p.getPlayerResponse = () => ({videoDetails: {videoId: '${ID}'}, streamingData: {adaptiveFormats: [
    {itag: 251, audioTrack: {id: 'de.3', displayName: 'Deutsch', audioIsDefault: true}, xtags: '${xtags('dubbed-auto')}'},
    {itag: 251, audioTrack: {id: 'en.4', displayName: 'English'}, xtags: '${xtags('original')}'}]}});
</script></body></html>`;

const TWITCH = `<!doctype html><html><head><meta charset="utf-8"><title>Twitch (Test)</title></head><body>
<script>
  // ein Worker wie der von Twitchs Player (Amazon IVS): twitch_main.js hängt twitch_worker.js davor
  const code = '// amazon-ivs wasmworker (Test)\\n' +
    'self.onmessage = async (e) => { self.postMessage(await self.__abTwitchTest.notifyAdComplete(e.data)); };';
  const worker = new Worker(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})));
  let n = 0;
  window.askWorker = () => new Promise((resolve) => {
    n++;
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage('#EXTM3U\\n#EXT-X-DATERANGE:ID="stitched-ad-' + n + '",CLASS="twitch-stitched-ad",' +
      'X-TV-TWITCH-AD-RADS-TOKEN="tok' + n + '",X-TV-TWITCH-AD-POD-LENGTH="1",X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"\\n' +
      '#EXTINF:2.000,Amazon|1\\nhttps://video-edge.example/ad.ts\\n');
  });
</script></body></html>`;

fs.rmSync(PROFILE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE, {
  channel: browserPath ? undefined : 'chromium',
  executablePath: browserPath,
  headless: !args.includes('--headed'),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
});
const gqlCalls = [];
await context.route(/^https:\/\/www\.youtube\.com\//, (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/watch' || u.pathname.startsWith('/shorts/')) {
    return route.fulfill({ body: WATCH, contentType: 'text/html; charset=utf-8' });
  }
  return route.fulfill({ status: 404, body: '' });
});
await context.route(/^https:\/\/www\.twitch\.tv\//, (route) => route.fulfill({ body: TWITCH, contentType: 'text/html; charset=utf-8' }));
await context.route('https://gql.twitch.tv/gql', (route) => {
  const body = JSON.parse(route.request().postData() || 'null');
  gqlCalls.push(body);
  const answer = Array.isArray(body) ? body.map(() => ({ data: { recordAdEvent: { __typename: 'RecordAdEventPayload' } } })) : { data: {} };
  return route.fulfill({ body: JSON.stringify(answer), contentType: 'application/json',
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await until(() => sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.length > 0)));
  // SponsorBlock und Return YouTube Dislike: feste Antworten statt Netz
  await sw.evaluate((sbAnswer) => {
    const realFetch = self.fetch;
    self.__asked = [];
    self.fetch = (url, init) => {
      const u = String(url && url.url || url);
      if (u.startsWith('https://sponsor.ajay.app/')) {
        self.__asked.push(u);
        return Promise.resolve(new Response(JSON.stringify(sbAnswer), { status: 200 }));
      }
      if (u.startsWith('https://returnyoutubedislikeapi.com/')) {
        self.__asked.push(u);
        return Promise.resolve(new Response(JSON.stringify({ likes: 10, dislikes: 1234 }), { status: 200 }));
      }
      return realFetch(url, init);
    };
  }, SPONSORBLOCK);

  // ---------------------------------------------------------------- Einstellungen
  const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts()
    .then((list) => list.map((s) => s.id + ':' + (s.world || 'ISOLATED') + (s.css ? '+css' : '')).sort()));
  check('Scripts registriert (mit YouTube-Extras und Originalton)', JSON.stringify(scripts) === JSON.stringify(
    ['ab-cosmetic:ISOLATED', 'ab-discord:ISOLATED', 'ab-netflix:MAIN', 'ab-twitch-bridge:ISOLATED', 'ab-twitch:MAIN',
     'ab-youtube:MAIN', 'ab-yt-audio:MAIN', 'ab-yt-extras:ISOLATED+css']), scripts);
  const defaults = await sw.evaluate(() => getSettings().then((s) => ({ spoof: s.twitchAdSpoofing, sb: s.sponsorBlock,
    cats: s.sponsorCategories, shorts: s.ytHideShorts, audio: s.ytOriginalAudio, dislikes: s.ytDislikes, v: s.settingsVersion })));
  check('Standard: Ad-Spoofing an, SponsorBlock an (Sponsor, Eigenwerbung, Abo-Erinnerung), Originalton an, Shorts/Dislikes aus',
        JSON.stringify(defaults) === JSON.stringify({ spoof: true, sb: true, cats: ['sponsor', 'selfpromo', 'interaction'],
                                                      shorts: false, audio: true, dislikes: false, v: 2 }), defaults);
  const migrated = await sw.evaluate(async () => {
    const old = { enabled: true, whitelist: ['beispiel.de'], rulesets: {}, discordHint: false, twitchAdSpoofing: false, autoUpdate: true };
    await chrome.storage.local.set({ settings: old });
    settingsCache = null;
    const s = await getSettings();
    const stored = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.remove('settings');
    settingsCache = null;
    await sync();
    return { spoof: s.twitchAdSpoofing, whitelist: s.whitelist, hint: s.discordHint, sb: s.sponsorBlock, storedVersion: stored.settingsVersion };
  });
  check('Alte Einstellungen: Ad-Spoofing einmal an, eigene Einstellungen bleiben',
        migrated.spoof === true && migrated.whitelist[0] === 'beispiel.de' && migrated.hint === false &&
        migrated.sb === true && migrated.storedVersion === 2, migrated);

  // ---------------------------------------------------------------- YouTube
  const yt = await context.newPage();
  await yt.goto(`https://www.youtube.com/watch?v=${ID}`);
  check('YouTube: Video läuft', await until(() => yt.evaluate(() => document.querySelector('video').currentTime > 0.3)));
  check('Originalton: Player von der Synchronfassung auf die Originalspur umgeschaltet',
        await until(() => yt.evaluate(() => window.__track === 'en.4'), 5000), await yt.evaluate(() => window.__track));
  check('Hinweis „Gesponsertes Video“ (ganzes Video)',
        await until(() => yt.evaluate(() => /Gesponsertes Video/.test(document.querySelector('.abgx-toast.show')?.textContent || ''))));
  const bar = await until(() => yt.evaluate(() => {
    const segs = document.querySelectorAll('.ytp-progress-bar .abgx-sb-seg');
    return segs.length ? { segs: segs.length, mute: document.querySelectorAll('.abgx-sb-seg.mute').length,
                           poi: !!document.querySelector('.ytp-progress-bar .abgx-sb-poi'),
                           hl: !!document.querySelector('.ytp-left-controls .abgx-hl-btn'),
                           left: document.querySelector('.abgx-sb-seg').style.left } : null;
  }));
  check('Zeitleiste: 2 übersprungene + 1 stummer Abschnitt, Highlight ◆, Knopf „Highlight“ (Intro nicht gewählt)',
        bar && bar.segs === 3 && bar.mute === 1 && bar.poi && bar.hl && bar.left.startsWith('8.33'), bar);
  const asked = await sw.evaluate(() => self.__asked);
  check('SponsorBlock nur mit Hash-Präfix gefragt', asked.length === 1 && !asked[0].includes(ID), asked);

  await yt.evaluate(() => { document.querySelector('video').currentTime = 4.2; });
  const jumped = await until(() => yt.evaluate(() => {
    const v = document.querySelector('video');
    return v.currentTime >= 17.9 ? v.currentTime : 0;
  }), 4000);
  check('Sponsor 5–15 und Eigenwerbung 15,2–18 in einem Sprung übersprungen', jumped >= 17.9 && jumped < 21, jumped);
  const toast = await yt.evaluate(() => document.querySelector('.abgx-toast.show')?.textContent || '');
  check('Hinweis mit „Rückgängig“', /Sponsor übersprungen/.test(toast) && /Rückgängig/.test(toast), toast);
  await yt.click('.abgx-toast button');
  await yt.waitForTimeout(1500);
  const undone = await yt.evaluate(() => document.querySelector('video').currentTime);
  check('Rückgängig: Abschnitt läuft und wird nicht gleich wieder übersprungen', undone > 5 && undone < 8.5, undone);

  await yt.evaluate(() => { document.querySelector('video').currentTime = 23.6; });
  check('Stumm-Abschnitt 24–28: stumm', await until(() => yt.evaluate(() => document.querySelector('video').muted), 3000));
  await yt.evaluate(() => { document.querySelector('video').currentTime = 29; });
  check('danach wieder laut', await until(() => yt.evaluate(() => !document.querySelector('video').muted), 3000));
  await yt.click('.abgx-hl-btn');
  const hl = await yt.evaluate(() => document.querySelector('video').currentTime);
  check('Knopf „Highlight“ springt zu 0:40', hl >= 40 && hl < 41.5, hl);
  if (process.env.SHOTS) {
    await yt.evaluate(() => { document.querySelector('video').currentTime = 4.5; });
    await until(() => yt.evaluate(() => /übersprungen/.test(document.querySelector('.abgx-toast.show')?.textContent || '')), 3000);
    await yt.screenshot({ path: path.join(process.env.SHOTS, 'youtube_player.png'), clip: { x: 0, y: 0, width: 660, height: 380 } });
  }

  // Popup (als Seite, für den YouTube-Tab)
  const ytTab = await sw.evaluate(() => chrome.tabs.query({ url: '*://www.youtube.com/*' }).then((t) => t[0].id));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${ytTab}`);
  await popup.waitForSelector('#siteStatus:not(.hidden)', { timeout: 5000 }).catch(() => {});
  const pop = await popup.evaluate(() => ({
    open: document.getElementById('youtubeCard').open,
    chips: document.querySelectorAll('#sbCats .chip').length,
    on: [...document.querySelectorAll('#sbCats .chip.on')].map((c) => c.textContent),
    status: document.getElementById('siteStatus').innerText,
    error: document.getElementById('error').textContent,
  }));
  check('Popup: YouTube-Karte offen, 8 Kategorien, 3 gewählt', pop.open && pop.chips === 8 && pop.on.length === 3, pop);
  if (process.env.SHOTS) await popup.screenshot({ path: path.join(process.env.SHOTS, 'popup_youtube.png'), fullPage: true });
  check('Popup: Status mit SponsorBlock (übersprungen, Highlight, ganzes Video)',
        /3 Abschnitte/.test(pop.status) && /übersprungen/.test(pop.status) && /Highlight bei 0:40/.test(pop.status) &&
        /Gesponsertes Video/.test(pop.status) && /Originalton/.test(pop.status) && !pop.error, pop.status);

  // Shorts ausblenden: live, dann ein Shorts-Link
  await popup.click('#ytHideShorts');
  const hidden = await until(() => yt.evaluate(() => {
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    return !shown('shelf') && !shown('shortItem') && shown('normalItem');
  }), 3000);
  check('Shorts ausblenden: Regal und Short weg, normales Video bleibt (ohne Neuladen)', hidden);
  await yt.goto('https://www.youtube.com/shorts/' + ID);
  check('Shorts-Link öffnet als normales Video', await until(() => yt.url().endsWith('/watch?v=' + ID), 5000), yt.url());

  // Dislikes
  await popup.click('#ytDislikes');
  const dislikes = await until(() => yt.evaluate(() => document.querySelector('#dislike .abgx-dislikes')?.textContent), 5000);
  check('Dislikes neben dem Knopf (Return YouTube Dislike)', /^1[.,\s]?234$|^1,2/.test(dislikes || ''), dislikes);

  // SponsorBlock aus: Zeitleiste leer
  await popup.click('#sponsorBlock');
  check('SponsorBlock aus: Markierungen weg', await until(() => yt.evaluate(() => !document.querySelector('.abgx-sb-seg')), 3000));
  await popup.close();

  // ---------------------------------------------------------------- Twitch
  const tw = await context.newPage();
  await tw.goto('https://www.twitch.tv/teststreamer');
  check('Twitch: Player-Worker eingehängt', await until(() => tw.evaluate(() => window.__abTwitch && window.__abTwitch.hookedWorkers > 0)));
  const first = await tw.evaluate(() => window.askWorker());
  check('Ad-Spoofing an: Werbung gemeldet (Impression, 4 Quartile, Pod-Abschluss)',
        first === true && gqlCalls.length === 1 && gqlCalls[0].length === 6, { first, calls: gqlCalls.length });
  const twTab = await sw.evaluate(() => chrome.tabs.query({ url: '*://www.twitch.tv/*' }).then((t) => t[0].id));
  const pop2 = await context.newPage();
  await pop2.goto(`chrome-extension://${extId}/popup.html?tab=${twTab}`);
  await pop2.waitForSelector('#spoofing[aria-pressed="true"]', { timeout: 5000 });
  if (process.env.SHOTS) await pop2.screenshot({ path: path.join(process.env.SHOTS, 'popup_twitch.png'), fullPage: true });
  await pop2.click('#spoofing');
  check('Schalter aus: kommt ohne Neuladen in der Seite an',
        await until(() => tw.evaluate(() => window.__abTwitch.adSpoofing === false), 3000));
  const second = await tw.evaluate(() => window.askWorker());
  check('… und im laufenden Worker: nichts gemeldet', second === false && gqlCalls.length === 1, { second, calls: gqlCalls.length });
  await pop2.click('#spoofing');
  await until(() => tw.evaluate(() => window.__abTwitch.adSpoofing === true), 3000);
  const third = await tw.evaluate(() => window.askWorker());
  check('Schalter wieder an: Worker meldet wieder', third === true && gqlCalls.length === 2, { third, calls: gqlCalls.length });
  const twitchJs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ['ab-twitch'] }).then((s) => s[0].js));
  check('Nächstes Laden nimmt twitch_spoofing.js', JSON.stringify(twitchJs) === '["generated/twitch_spoofing.js"]', twitchJs);
} finally {
  await context.close();
}
console.log(failed ? `\n${failed} FEHLER` : '\nAlles OK');
process.exit(failed ? 1 : 0);
