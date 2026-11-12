// Twitch-Werbeblocker (scripts/twitch_worker.js) gegen ein nachgebautes Twitch (ohne Netz): Der Player
// soll statt Werbung oder schwarzem Bild gleich eine werbefreie Sitzung bekommen. Gleiche Fälle wie
// test/twitch-adblock.test.js in GX Tube Desktop und TwitchAdSkipTest in der Android-App.
//
//   node --test dev_tests/twitch_worker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../scripts/twitch_worker.js', import.meta.url), 'utf8');
const HOLD = fs.readFileSync(new URL('../scripts/twitch_hold.ts', import.meta.url)).toString('base64');
const T0 = 1_792_872_000_000;
const ALL_HQ = ['popout', 'frontpage', 'mobile_web', 'site'];
// the player types the extension passes (TWITCH_BACKUP_TYPES in tools/build_extension.py)
const BACKUP_TYPES = JSON.parse((fs.readFileSync(new URL('../tools/build_extension.py', import.meta.url), 'utf8')
  .match(/^TWITCH_BACKUP_TYPES = (\[.*\])$/m) || [])[1] || 'null');
assert.ok(Array.isArray(BACKUP_TYPES), 'TWITCH_BACKUP_TYPES in build_extension.py');

/** Nachgebautes Twitch: jede Sitzung (playerType) hat ihre eigene Playlist, mit oder ohne Werbung. */
function fakeTwitch({ clearOnSpoof = false, tailLiveOnSpoof = false, failSpoof = false, adSpoofing = true } = {}) {
  const tw = { head: 50, ads: new Set(), tailLive: new Set(), lag: {}, tokens: [], spoofCalls: [], events: [] };
  const offsetOf = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) * 10; // jede Sitzung nummeriert anders
  tw.playlist = (session) => {
    const end = tw.head - (tw.lag[session] ?? 0);
    const ad = tw.ads.has(session);
    const tailLive = tw.tailLive.has(session);
    let b = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${end - 5 + offsetOf(session)}\n`;
    if (ad || tailLive) {
      b += `#EXT-X-DATERANGE:ID="stitched-ad-${tw.head}",CLASS="twitch-stitched-ad",START-DATE="${new Date(T0).toISOString()}",DURATION=30.0,X-TV-TWITCH-AD-RADS-TOKEN="rads-tok-${tw.head}",X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-POD-POSITION="0",X-TV-TWITCH-AD-POD-LENGTH="1"\n`;
    }
    for (let n = end - 5; n < end; n++) {
      const segAd = ad || (tailLive && n < end - 2);
      b += `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + n * 2000).toISOString()}\n${segAd ? '#EXTINF:2.000,Amazon|1' : '#EXTINF:2.000,live'}\nhttps://video-edge.example/${session}/${n}.ts\n`;
    }
    return b;
  };
  const master = (session) => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000\n' +
    `https://video-weaver.example.hls.ttvnw.net/v1/playlist/${session}-720.m3u8\n`;
  const fakeFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let body;
    if (url.startsWith('https://gql.twitch.tv/')) {
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed) && parsed[0]?.operationName === 'ClientSideAdEventHandling_RecordAdEvent') {
        tw.spoofCalls.push({ headers: init.headers, batch: parsed });
        if (failSpoof) return new Response(JSON.stringify(parsed.map(() => ({ errors: [{ message: 'service error' }] }))), { status: 200 });
        if (clearOnSpoof) tw.ads.delete('native');
        if (tailLiveOnSpoof) {
          tw.ads.delete('native');
          tw.tailLive.add('native');
        }
        body = JSON.stringify(parsed.map(() => ({ data: { recordAdEvent: { __typename: 'RecordAdEventPayload' } } })));
      } else {
        const v = parsed.variables;
        tw.tokens.push(`${v.playerType}/${v.platform}`);
        body = JSON.stringify({ data: { streamPlaybackAccessToken: { value: v.playerType, signature: 'sig', authorization: { isForbidden: false } } } });
      }
    } else if (url.includes('usher.ttvnw.net/')) body = master(new URL(url).searchParams.get('token'));
    else if (url.includes('/v1/playlist/')) body = tw.playlist(url.split('/').pop().replace('-720.m3u8', ''));
    else throw new Error('unerwartet: ' + url);
    return new Response(body, { status: 200 });
  };
  class Channel {
    postMessage(m) { tw.events.push(m); }
    addEventListener() {}
  }
  const self = { fetch: fakeFetch };
  const ctx = vm.createContext({ self, Response, URL, URLSearchParams, setTimeout, clearTimeout, console, atob, btoa, TextEncoder, TextDecoder, BroadcastChannel: Channel, crypto });
  vm.runInContext(SRC.replace('__AB_WORKER_INIT__', JSON.stringify({ clientId: 'x', channel: 'test', relay: false, adSpoofing, backupTypes: BACKUP_TYPES }))
    .replace('__AB_HOLD_SEGMENT__', JSON.stringify(HOLD)), ctx);
  const usher = 'https://usher.ttvnw.net/api/channel/hls/streamer.m3u8?token=native&sig=x&supported_codecs=avc1';
  const media = 'https://video-weaver.example.hls.ttvnw.net/v1/playlist/native-720.m3u8';
  tw.start = () => self.fetch(usher);
  tw.refresh = async () => self.__abTwitchTest.parseMedia(await (await self.fetch(media)).text(), media);
  tw.testApi = self.__abTwitchTest;
  return tw;
}

const holds = (p) => p.segs.filter((s) => s.uri.startsWith('https://www.twitch.tv/__adblock_gx_hold.ts')).length;
const last = (p) => p.segs[p.segs.length - 1];

test('Zweite 360p-Brücke, wenn die erste auch Werbung hat', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ, 'autoplay']) tw.ads.add(s);
  tw.head++;
  const p = await tw.refresh();
  assert.equal(holds(p), 0, 'kein schwarzes Bild');
  assert.match(last(p).uri, /\/picture-by-picture\//);
  assert.ok(!p.segs.some((s) => s.ad));
  assert.ok(tw.tokens.includes('picture-by-picture/ios') && tw.tokens.includes('autoplay/android'), tw.tokens.join());
  assert.ok(tw.events.some((e) => e.event === 'bridge' && e.on));
});

test('Brücke, die ein paar Sekunden zurückliegt, sofort statt schwarz', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ, 'picture-by-picture']) tw.ads.add(s);
  tw.lag.autoplay = 3; // 6 s hinter dem, was der Player schon hat
  tw.head++;
  const p = await tw.refresh();
  assert.equal(holds(p), 0, 'kein schwarzes Bild');
  assert.match(last(p).uri, /\/autoplay\//);
  let seq = last(p).seq;
  for (let i = 0; i < 5; i++) {
    tw.head++;
    const q = await tw.refresh();
    assert.equal(holds(q), 0);
    assert.ok(last(q).seq > seq, 'Nummern steigen nur');
    seq = last(q).seq;
  }
  tw.ads.clear();
  for (let i = 0; i < 4; i++) {
    tw.head++;
    await tw.refresh();
  }
  assert.match(last(await tw.refresh()).uri, /\/native\//, 'nach der Werbung zurück zur eigenen Sitzung');
});

test('Alles mit Werbung: schwarzes Ersatzbild, nie die Werbung', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ, 'autoplay', 'picture-by-picture']) tw.ads.add(s);
  tw.head++;
  const p = await tw.refresh();
  assert.ok(holds(p) > 0);
  assert.ok(p.segs.every((s) => !s.ad || s.uri.startsWith('https://www.twitch.tv/__adblock_gx_hold.ts')));
  assert.equal(tw.spoofCalls.length, 1, 'Ad-Spoofing wurde zuerst versucht');
});

test('Primär Ad-Spoofing: beendet Werbung sofort auf eigener Sitzung ohne Wechsel', async () => {
  const tw = fakeTwitch({ clearOnSpoof: true });
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'RecordAdEvent gesendet');
  const call = tw.spoofCalls[0];
  assert.match(call.headers['X-Device-Id'], /^[0-9a-f]{32}$/i, 'echte 32-stellige Device-ID statt oauth');
  assert.equal(call.batch.length, 6, 'Impression + 4 Quartile + Pod-Complete');
  assert.equal(tw.tokens.length, 0, 'keine Ersatz-Sitzung nötig, wenn Spoofing greift');
  assert.match(last(p).uri, /\/native\//, 'bleibt auf der eigenen Sitzung');
  assert.ok(!p.segs.some((s) => s.ad));
});

test('Ad-Spoofing: schneidet Rest-Werbung im oberen HLS-Fenster lückenlos heraus, sobald am Ende wieder Live-Stücke liegen', async () => {
  const tw = fakeTwitch({ tailLiveOnSpoof: true });
  await tw.start();
  const first = await tw.refresh();
  const prevLastSeq = last(first).seq;
  tw.ads.add('native');
  tw.head += 2;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'RecordAdEvent gesendet');
  assert.equal(tw.tokens.length, 0, 'kein Wechsel auf 360p-Brücke nötig');
  assert.match(last(p).uri, /\/native\//, 'bleibt auf eigener Sitzung');
  assert.ok(!p.segs.some((s) => s.ad), 'alte Werbestücke wurden herausgeschnitten');
  assert.ok(last(p).seq > prevLastSeq, 'Segmentnummern steigen lückenlos weiter');
  for (let i = 1; i < p.segs.length; i++) {
    assert.equal(p.segs[i].seq, p.segs[i - 1].seq + 1, 'keine Lücke in der Nummerierung');
  }
});

test('Prefetch-Werbung am Playlist-Ende wird herausgefiltert, Live-Prefetch bleibt', () => {
  const tw = fakeTwitch();
  const raw =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n' +
    '#EXTINF:2.000,live\nhttps://video-edge.example/native/10.ts\n' +
    '#EXT-X-TWITCH-PREFETCH:https://video-edge.example/stitched-ad/ad1.ts\n' +
    '#EXT-X-TWITCH-PREFETCH:https://video-edge.example/native/11.ts\n';
  const parsed = tw.testApi.parseMedia(raw, 'https://video-weaver.example/native.m3u8');
  assert.deepEqual([...parsed.tail], ['#EXT-X-TWITCH-PREFETCH:https://video-edge.example/native/11.ts']);
});

test('Ad-Spoofing fehlgeschlagen: kein neuer Versuch bei jeder Aktualisierung, Ersatz-Sitzung übernimmt', async () => {
  const tw = fakeTwitch({ failSpoof: true });
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'einmal versucht');
  assert.ok(!p.segs.some((s) => s.ad), 'Werbung trotzdem weg (Ersatz-Sitzung)');
  await tw.refresh();
  await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'gleiche Werbung nicht sofort wieder gemeldet');
});

test('Ad-Spoofing abgeschaltet: nichts wird gemeldet', async () => {
  const tw = fakeTwitch({ clearOnSpoof: true });
  tw.testApi.setAdSpoofing(false);
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 0);
  assert.ok(!p.segs.some((s) => s.ad));
});

test('Ad-Spoofing in der Einstellung aus (Init), dann während der Seite eingeschaltet', async () => {
  const tw = fakeTwitch({ clearOnSpoof: true, adSpoofing: false });
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  let p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 0, 'aus: nichts gemeldet');
  assert.ok(!p.segs.some((s) => s.ad), 'Werbung trotzdem weg (Ersatz-Sitzung)');
  tw.testApi.setAdSpoofing(true);
  tw.head++;
  p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'eingeschaltet: Werbung gemeldet');
  assert.ok(!p.segs.some((s) => s.ad));
});
