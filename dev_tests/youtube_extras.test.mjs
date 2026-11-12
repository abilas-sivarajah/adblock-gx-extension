// YouTube extras ohne Browser und ohne Netz:
// - extension/sponsorblock.js: Antwort von SponsorBlock aufbereiten, Hash-Präfix, Adresse, Fehlerfälle,
//   Return YouTube Dislike (gleiche Regeln wie sponsorblock.js / community.js in GX Tube Desktop)
// - extension/content/youtube_audio.js: welche Tonspur der Originalton ist und dass der Player
//   genau einmal pro Video darauf umgeschaltet wird
//
//   node --test dev_tests/youtube_extras.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const sb = require('../extension/sponsorblock.js');
const ID = 'dQw4w9WgXcQ';

const API_ANSWER = [
  { videoID: 'xxxxxxxxxxx', segments: [{ segment: [1, 2], category: 'sponsor', actionType: 'skip', UUID: 'other' }] },
  {
    videoID: ID,
    segments: [
      { segment: [60.2, 90.75], category: 'sponsor', actionType: 'skip', UUID: 'b', videoDuration: 212.1 },
      { segment: [5, 15], category: 'selfpromo', actionType: 'skip', UUID: 'a', videoDuration: 212.1 },
      { segment: [100, 110], category: 'music_offtopic', actionType: 'mute', UUID: 'm', videoDuration: 212.1 },
      { segment: [120, 130], category: 'intro', actionType: 'skip', UUID: 'i' },           // not chosen
      { segment: [140, 140], category: 'sponsor', actionType: 'skip', UUID: 'zero' },      // empty
      { segment: [150, 160], category: 'sponsor', actionType: 'skip' },                    // no UUID
      { segment: [42, 42], category: 'poi_highlight', actionType: 'poi', UUID: 'h' },
      { segment: [0, 0], category: 'sponsor', actionType: 'full', UUID: 'f' },
    ],
  },
];

test('Abschnitte: nur gewählte Kategorien, sortiert, in Sekunden, mit Highlight und ganzem Video', () => {
  const r = sb.parseSegments(API_ANSWER, ID, ['sponsor', 'selfpromo', 'music_offtopic', 'unbekannt']);
  assert.deepEqual(r.segments.map((s) => [s.uuid, s.start, s.end, s.action]), [
    ['a', 5, 15, 'skip'], ['b', 60.2, 90.75, 'skip'], ['m', 100, 110, 'mute']]);
  assert.equal(r.segments[0].label, 'Eigenwerbung');
  assert.equal(r.segments[0].videoDuration, 212.1);
  assert.deepEqual(r.highlight, { start: 42, uuid: 'h' });
  assert.deepEqual(r.full, { category: 'sponsor', label: 'Gesponsertes Video' });
});

test('Abschnitte: andere Video-ID mit gleichem Präfix und kaputte Antworten ergeben nichts', () => {
  assert.equal(sb.parseSegments(API_ANSWER, 'aaaaaaaaaaa', ['sponsor']).segments.length, 0);
  for (const bad of [null, {}, 'x', [{ videoID: ID, segments: [{ segment: 'x' }, null] }]]) {
    assert.deepEqual(sb.parseSegments(bad, ID, ['sponsor']), { segments: [], highlight: null, full: null });
  }
});

test('Anfrage: nur die ersten 4 Zeichen des SHA-256 gehen an den Server, nie die Video-ID', async () => {
  const prefix = await sb.hashPrefix(ID);
  assert.equal(prefix, crypto.createHash('sha256').update(ID).digest('hex').slice(0, 4));
  const urls = [];
  const r = await sb.fetchSegments(ID, ['sponsor', 'selfpromo'], async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(API_ANSWER), { status: 200 });
  });
  assert.equal(r.segments.length, 2);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('https://sponsor.ajay.app/api/skipSegments/' + prefix + '?'), urls[0]);
  assert.ok(!urls[0].includes(ID), 'Video-ID bleibt privat');
  const cats = JSON.parse(new URL(urls[0]).searchParams.get('categories'));
  assert.deepEqual(cats.sort(), ['exclusive_access', 'poi_highlight', 'selfpromo', 'sponsor']);
});

test('Anfrage: 404, Netzfehler und ungültige IDs ergeben leer, ohne Fehler', async () => {
  assert.equal(await sb.fetchSegments(ID, ['sponsor'], async () => new Response('Not Found', { status: 404 })), sb.EMPTY);
  assert.equal(await sb.fetchSegments(ID, ['sponsor'], async () => { throw new Error('offline'); }), sb.EMPTY);
  let asked = false;
  assert.equal(await sb.fetchSegments('../evil', ['sponsor'], async () => { asked = true; }), sb.EMPTY);
  assert.equal(asked, false);
});

test('Return YouTube Dislike: Zahlen prüfen', async () => {
  const ok = async () => new Response(JSON.stringify({ likes: 100.4, dislikes: 1234 }), { status: 200 });
  assert.deepEqual(await sb.fetchVotes(ID, ok), { likes: 100, dislikes: 1234 });
  assert.equal(await sb.fetchVotes(ID, async () => new Response('{"dislikes":-1}', { status: 200 })), null);
  assert.equal(await sb.fetchVotes(ID, async () => new Response('', { status: 500 })), null);
  assert.equal(await sb.fetchVotes('x', ok), null);
});

test('Kategorien: unbekannte und doppelte fallen weg', () => {
  assert.deepEqual(sb.cleanCategories(['sponsor', 'sponsor', 'evil', 'intro']), ['sponsor', 'intro']);
  assert.deepEqual(sb.cleanCategories('sponsor'), []);
  assert.deepEqual(sb.DEFAULT_CATEGORIES, ['sponsor', 'selfpromo', 'interaction']);
});

// ---------------------------------------------------------------- Originalton

// xtags wie bei YouTube: Protobuf {1: {1: "acont", 2: <wert>}} als base64url
function xtags(acont) {
  const kv = Buffer.concat([Buffer.from([0x0a, 5]), Buffer.from('acont'), Buffer.from([0x12, acont.length]), Buffer.from(acont)]);
  return Buffer.concat([Buffer.from([0x0a, kv.length]), kv]).toString('base64url');
}

function audioScript() {
  const flags = new Set(['data-abgx-original-audio']);
  const ctx = {
    document: {
      documentElement: { hasAttribute: (n) => flags.has(n) },
      addEventListener() {},
      getElementById: () => ctx.player,
      querySelector: () => null,
    },
    setInterval() {},
    setTimeout() {},
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
    player: null,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../extension/content/youtube_audio.js', import.meta.url), 'utf8'), ctx);
  return { ctx, flags, api: ctx.__abYtAudioTest, stats: ctx.__abYtAudio };
}

// Player wie #movie_player: Tonspur-Objekte mit verkürzten Eigenschaftsnamen
function fakePlayer(videoId, tracks, formats, current = 0) {
  const objs = tracks.map(([id, name]) => ({ Xq: { id, name, isDefault: false }, Zr: 3 }));
  const p = {
    selected: objs[current],
    calls: 0,
    getVideoData: () => ({ video_id: videoId }),
    getAvailableAudioTracks: () => objs,
    getAudioTrack: () => p.selected,
    setAudioTrack(t) { p.selected = t; p.calls++; },
    getPlayerResponse: () => ({ videoDetails: { videoId }, streamingData: { adaptiveFormats: formats } }),
  };
  return { p, objs };
}

const fmt = (id, name, acont, def = false) => ({ itag: 251, audioTrack: { id, displayName: name, audioIsDefault: def }, xtags: acont && xtags(acont) });

test('Originalton: Markierung in xtags gewinnt vor Name und Standardspur', () => {
  const { api } = audioScript();
  const formats = [fmt('de.3', 'Deutsch', 'dubbed-auto', true), fmt('en.4', 'English', 'original'), fmt('fr.3', 'Français (original)', 'dubbed')];
  assert.equal(api.originalTrackId({ streamingData: { adaptiveFormats: formats } }), 'en.4');
  assert.equal(api.originalTrackId({ streamingData: { adaptiveFormats: [fmt('de.3', 'Deutsch', null, true), fmt('en.4', 'English original', null)] } }), 'en.4');
  assert.equal(api.originalTrackId({ streamingData: { adaptiveFormats: [fmt('de.3', 'Deutsch', null), fmt('en.4', 'English', null, true)] } }), 'en.4');
  assert.equal(api.originalTrackId({ streamingData: { adaptiveFormats: [fmt('en.4', 'English', 'original')] } }), null, 'nur eine Spur');
  assert.equal(api.originalTrackId(null), null);
});

test('Originalton: Player wird einmal pro Video umgeschaltet, eine Handwahl danach bleibt', () => {
  const { ctx, api, stats } = audioScript();
  const formats = [fmt('de.3', 'Deutsch', 'dubbed-auto'), fmt('en.4', 'English', 'original')];
  const { p, objs } = fakePlayer('vid00000001', [['de.3', 'Deutsch'], ['en.4', 'English']], formats, 0);
  ctx.player = p;
  api.check();
  assert.equal(p.selected, objs[1], 'auf Originalton');
  assert.equal(stats.switched, 1);
  p.selected = objs[0];  // von Hand zurück auf Deutsch
  api.check();
  assert.equal(p.selected, objs[0], 'Handwahl bleibt');
  assert.equal(p.calls, 1);
});

test('Originalton: aus, alte Antwort, schon richtig oder unklar - nichts umschalten', () => {
  const { ctx, flags, api } = audioScript();
  const formats = [fmt('de.3', 'Deutsch', 'dubbed-auto'), fmt('en.4', 'English', 'original')];
  let { p } = fakePlayer('vid00000002', [['de.3', 'Deutsch'], ['en.4', 'English']], formats, 0);
  ctx.player = p;
  flags.clear();
  api.check();
  assert.equal(p.calls, 0, 'Einstellung aus');
  flags.add('data-abgx-original-audio');
  p.getPlayerResponse = () => ({ videoDetails: { videoId: 'previous000' }, streamingData: { adaptiveFormats: formats } });
  api.check();
  assert.equal(p.calls, 0, 'Antwort gehört noch zum vorigen Video');
  ({ p } = fakePlayer('vid00000003', [['de.3', 'Deutsch'], ['en.4', 'English']], formats, 1));
  ctx.player = p;
  api.check();
  assert.equal(p.calls, 0, 'läuft schon im Originalton');
  ({ p } = fakePlayer('vid00000004', [['de.3', 'Deutsch'], ['es.3', 'Español']], [fmt('de.3', 'Deutsch', null), fmt('es.3', 'Español', null)], 0));
  ctx.player = p;
  api.check();
  assert.equal(p.calls, 0, 'kein erkennbarer Originalton');
});
