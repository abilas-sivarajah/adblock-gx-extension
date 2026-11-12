// Twitch: runs at document start on twitch.tv pages.
//
// Extension copy of scripts/twitch_main.js from adblock-browser-gx (10/2026), kept in step with the
// worker of GX Tube Desktop (third_party/adblock-gx, 11/2026). Changes against the browser:
// - ad spoofing can be switched while the page is open: content/twitch_bridge.js posts
//   {source: 'adblock-gx', type: 'twitch-spoofing'} to the page, this script passes it on to the
//   worker ({event: 'spoofing'}) and to workers started later;
// - statistics for the worker's new events (ad requests blocked on live streams, forced switches).
// Twitch's player (Amazon IVS) fetches the HLS playlists inside a Web Worker, so page-level
// hooks cannot see them. We wrap that worker and prepend twitch_worker.js to its code.
//
// The page side also does, following TTV-AB by GosuDRM (https://github.com/GosuDRM/TTV-AB):
// - Twitch's own GQL headers (Client-Version, Client-Session-Id, device id; login token and
//   integrity only for streams that refuse anonymous viewers) for the worker's backup requests,
//   and a relay for GQL requests the worker cannot make itself;
// - a watchdog for a stuck video: jump over a buffer gap, pause/play, at last reload the player;
// - hiding Twitch's display ads (banner, "stream display ad" frame, Amazon video ads) and
//   blocking the VAST ad requests of VODs.
// Ad spoofing (CFG.adSpoofing, a setting): the worker first reports an ad to Twitch as watched -
// often the break then ends at once without a switch; otherwise an ad-free backup session takes
// over. With the viewer's login, see twitch_worker.js.
// Statistics for the shield / tests: window.__abTwitch
(function () {
    'use strict';
    const CFG = __AB_CONFIG__;
    const host = location.hostname;
    if (host !== 'twitch.tv' && !host.endsWith('.twitch.tv')) return;
    if (!CFG.enabled || CFG.whitelist.some(function (d) { return host === d || host.endsWith('.' + d); })) return;
    if (window.__abTwitch) return;

    const WORKER_HOOK = __AB_WORKER_HOOK__;
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';  // Twitch's public web client id
    const CHANNEL = 'adblock-twitch-' + Math.random().toString(36).slice(2);  // per page, not per origin
    const stats = window.__abTwitch = {
        workers: 0, hookedWorkers: 0, masters: 0, playlists: 0, adBreaks: 0, replaced: 0, masked: 0, holds: 0,
        bridges: 0, nativeReturns: 0, adSeconds: 0, vodAdsBlocked: 0, adRequestsBlocked: 0, spoofedAds: 0, videoAdsHidden: 0,
        stallFixes: 0, reloads: 0, forcedSwitches: 0, adSpoofing: CFG.adSpoofing === true,
        lastBackupType: null, backupTrail: [], errors: [], overlayActive: false, bridgeActive: false
    };
    const channelName = function () { return location.pathname.split('/')[1] || ''; };
    const isVod = function () {
        return /^\/videos\/\d+/.test(location.pathname) || (host === 'player.twitch.tv' && /[?&]video=/.test(location.search));
    };

    let channel = null;
    try { channel = new BroadcastChannel(CHANNEL); } catch (e) {}
    function post(msg) {
        if (channel) {
            try { channel.postMessage(msg); } catch (e) {}
        }
    }

    // ad spoofing switched in the popup (content/twitch_bridge.js): the running worker hears it at
    // once, workers started later get it in their init
    window.addEventListener('message', function (e) {
        const d = e.data;
        if (e.source !== window || !d || d.source !== 'adblock-gx' || d.type !== 'twitch-spoofing') return;
        stats.adSpoofing = !!d.enabled;
        post({event: 'spoofing', enabled: stats.adSpoofing});
    });

    function playerBox() {
        return document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player__container');
    }

    function playerVideo() {
        const box = playerBox();
        return box && box.querySelector('video');
    }

    // ---- hint in the player while Twitch's ad break has to be waited out ----
    let overlay = null, overlayTimer = 0, overlayEndsAt = null, overlayStarted = 0, cover = false, muted = null;

    function renderOverlay() {
        const player = playerBox();
        if (!player) return;
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'adblock-twitch-overlay';
        }
        // cover mode: the ad (or black hold segments) is running underneath (see twitch_worker.js)
        overlay.setAttribute('style', cover
            ? 'position:absolute;inset:0;z-index:9999;pointer-events:none;background:#0f172a;color:#e2e8f0;display:flex;' +
              'align-items:center;justify-content:center;padding:20px;font:600 16px/1.5 system-ui,sans-serif;text-align:center'
            : 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;pointer-events:none;' +
              'background:rgba(15,23,42,.85);color:#e2e8f0;border:1px solid #10b981;border-radius:12px;padding:14px 20px;' +
              'font:600 15px/1.4 system-ui,sans-serif;text-align:center;max-width:80%');
        const video = player.querySelector('video');
        if (cover && video) {
            if (muted === null) muted = video.muted;
            video.muted = true;
        }
        // remaining time only while Twitch's announced end is still ahead, otherwise how long it has been
        const left = overlayEndsAt ? Math.round((overlayEndsAt - Date.now()) / 1000) : 0;
        const since = Math.round((Date.now() - overlayStarted) / 1000);
        const clock = function (sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
        overlay.textContent = '\u{1F6E1}️ Twitch zeigt gerade überall Werbung – sie wird ausgeblendet' +
            (left > 0 ? ' (noch ca. ' + clock(left) + ')' : ' (seit ' + clock(since) + ')') +
            '. Der Stream geht danach automatisch weiter.';
        if (overlay.parentNode !== player) player.appendChild(overlay);
    }

    function showOverlay(endsAt, coverPlayer) {
        if (endsAt) overlayEndsAt = endsAt;
        cover = cover || !!coverPlayer;
        if (!stats.overlayActive) overlayStarted = Date.now();
        stats.overlayActive = true;
        renderOverlay();
        if (!overlayTimer) overlayTimer = setInterval(renderOverlay, 1000);
    }

    function hideOverlay() {
        if (overlayTimer) clearInterval(overlayTimer);
        overlayTimer = 0;
        overlayEndsAt = null;
        if (overlay) overlay.remove();
        if (muted !== null) {
            const video = playerVideo();
            if (video) video.muted = muted;
            muted = null;
        }
        cover = false;
        stats.overlayActive = false;
    }

    // small note while the 360p bridge stands in for the ad
    let badge = null, badgeTimer = 0;
    function renderBadge() {
        const player = playerBox();
        if (!stats.bridgeActive || !player) {
            if (badge) badge.remove();
            if (!stats.bridgeActive && badgeTimer) {
                clearInterval(badgeTimer);
                badgeTimer = 0;
            }
            return;
        }
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'adblock-twitch-badge';
            badge.setAttribute('style', 'position:absolute;top:10px;right:10px;z-index:9999;pointer-events:none;' +
                'background:rgba(15,23,42,.8);color:#e2e8f0;border:1px solid #10b981;border-radius:8px;padding:4px 10px;' +
                'font:600 12px/1.4 system-ui,sans-serif');
            badge.textContent = '\u{1F6E1}️ Werbung übersprungen – kurz in 360p';
        }
        if (badge.parentNode !== player) player.appendChild(badge);
        if (!badgeTimer) badgeTimer = setInterval(renderBadge, 2000);
    }

    // ---- Twitch's display ads ----
    function injectCss() {
        if (document.getElementById('adblock-twitch-css')) return true;
        const parent = document.head || document.documentElement;
        if (!parent) return false;  // at document creation there may be no <html> yet
        const style = document.createElement('style');
        style.id = 'adblock-twitch-css';
        style.textContent =
            '[data-test-selector="display-ad"],[data-test-selector="ad-banner"],[data-a-target="ads-banner"],' +
            'iframe[data-test-selector^="sda-iframe-"],iframe[title="Stream Display Ad"],' +
            'iframe[class*="stream-display-ad__iframe_lower-third"]{display:none!important}' +
            '.stream-display-ad__wrapper+div>div[style^="position:"]>div[class^="Layout-sc-"]:has(video[src^="https://m.media-amazon.com"]),' +
            '.chat-shell>div[class^="Layout-sc-"]>div[style^="transition:"]:has(video[src^="https://m.media-amazon.com"]){display:none!important}';
        parent.appendChild(style);
        return true;
    }

    // After an ad break Twitch can leave the player shrunk next to a "stream display ad"
    function cleanupDisplayAds() {
        document.querySelectorAll('[class*="stream-display-ad"]').forEach(function (el) {
            const wrapsPlayer = !!el.querySelector('video') || el.matches('[data-a-target="video-player"]');
            Array.from(el.classList).forEach(function (c) {
                if (c.indexOf('stream-display-ad') !== -1) el.classList.remove(c);
            });
            if (wrapsPlayer) {
                ['padding', 'margin', 'inset'].forEach(function (p) { el.style.setProperty(p, '0', 'important'); });
                el.style.setProperty('background', 'transparent', 'important');
                el.style.setProperty('width', '100%', 'important');
                el.style.setProperty('height', '100%', 'important');
            } else {
                el.style.setProperty('display', 'none', 'important');
            }
        });
    }

    function afterAd() {
        [100, 1000, 3000].forEach(function (ms) { setTimeout(cleanupDisplayAds, ms); });
    }

    // Amazon video ads outside the stream (the stream itself plays from a blob: URL)
    document.addEventListener('play', function (e) {
        const v = e.target;
        if (!v || v.tagName !== 'VIDEO') return;
        if (/^https:\/\/[^/]*media-amazon\.com\//.test(v.currentSrc || v.src || '')) {
            v.muted = true;
            v.pause();
            v.style.setProperty('display', 'none', 'important');
            stats.videoAdsHidden++;
        }
    }, true);

    // ---- VOD ads: separate VAST requests ----
    const VOD_AD = /^https:\/\/(edge\.ads\.twitch\.tv|vaes\.amazon-adsystem\.com)\/(2018-01-01\/3p\/ads|ads\/format|ads)(?=[/?]|$)/;
    const EMPTY_VAST = 'data:application/xml,%3CVAST%20version%3D%223.0%22%3E%3C%2FVAST%3E';

    // ---- Twitch's own GQL headers (passed to the worker for its backup requests) ----
    const VIEWER_HEADERS = ['Authorization', 'Client-Integrity', 'Client-Version', 'Client-Session-Id', 'X-Device-Id'];
    const viewer = {};

    function headerValue(headers, name) {
        if (!headers) return null;
        if (typeof headers.get === 'function') return headers.get(name);
        const lower = name.toLowerCase();
        if (Array.isArray(headers)) {
            const pair = headers.find(function (p) { return p && String(p[0]).toLowerCase() === lower; });
            return pair ? pair[1] : null;
        }
        for (const k in headers) {
            if (k.toLowerCase() === lower) return headers[k];
        }
        return null;
    }

    function captureViewer(input, init) {
        let changed = false;
        const sources = [init && init.headers, input && typeof input === 'object' && input.headers];
        VIEWER_HEADERS.forEach(function (name) {
            for (let i = 0; i < sources.length; i++) {
                const v = headerValue(sources[i], name);
                if (!v) continue;
                if (viewer[name] !== String(v)) {
                    viewer[name] = String(v);
                    changed = true;
                }
                break;
            }
        });
        if (changed) post({event: 'viewer', headers: Object.assign({}, viewer)});
    }

    const pageFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            if (url.indexOf('https://gql.twitch.tv/') === 0) captureViewer(input, init);
            else if (method === 'GET' && isVod() && VOD_AD.test(url)) {
                stats.vodAdsBlocked++;
                return Promise.resolve(new Response(null, {status: 204}));
            }
        } catch (e) {}
        return pageFetch.apply(this, arguments);
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        try {
            if (String(method).toUpperCase() === 'GET' && isVod() && VOD_AD.test(String(url))) {
                stats.vodAdsBlocked++;
                arguments[1] = EMPTY_VAST;
            }
        } catch (e) {}
        return xhrOpen.apply(this, arguments);
    };

    // GQL request of the worker, made from the page (only to gql.twitch.tv)
    function relay(d) {
        if (typeof d.url !== 'string' || d.url.indexOf('https://gql.twitch.tv/') !== 0) return;
        const init = d.init || {};
        pageFetch.call(window, d.url, {method: init.method || 'POST', headers: init.headers, body: init.body})
            .then(function (r) {
                return r.text().then(function (body) { post({event: 'fetch-response', id: d.id, status: r.status, body: body}); });
            })
            .catch(function (e) { post({event: 'fetch-response', id: d.id, error: String(e)}); });
    }

    // the worker blocks VOD ad requests only on VOD pages
    let lastVod = isVod();
    setInterval(function () {
        if (isVod() !== lastVod) {
            lastVod = !lastVod;
            post({event: 'page', vod: lastVod});
        }
    }, 1000);

    // ---- stuck video: jump over a buffer gap, pause/play, at last reload the player ----
    function reactRoot() {
        const el = document.getElementById('root');
        if (!el) return null;
        const legacy = el._reactRootContainer && el._reactRootContainer._internalRoot;
        if (legacy && legacy.current) return legacy.current;
        const key = Object.keys(el).find(function (k) { return k.indexOf('__reactContainer') === 0; });
        return key ? el[key] : null;
    }

    function findReactNode(root, test) {
        const stack = [root];
        let visited = 0;
        while (stack.length && visited++ < 30000) {
            const fiber = stack.pop();
            if (!fiber) continue;
            try {
                if (fiber.stateNode && test(fiber.stateNode)) return fiber.stateNode;
            } catch (e) {}
            if (fiber.sibling) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);
        }
        return null;
    }

    function playerParts() {
        const root = reactRoot();
        if (!root) return {};
        const p = findReactNode(root, function (n) { return n.setPlayerActive && n.props && n.props.mediaPlayerInstance; });
        const s = findReactNode(root, function (n) { return n.setSrc && n.setInitialPlaybackSettings; });
        return {player: p ? p.props.mediaPlayerInstance : null, state: s};
    }

    const watch = {last: -1, stuck: 0, attempts: 0, lastAction: 0, lastReload: 0, armedUntil: 0};
    function armWatch() { watch.armedUntil = Date.now() + 30000; }  // right after a change of source: look closer

    function fixStall(video) {
        watch.lastAction = Date.now();
        watch.stuck = 0;
        if (++watch.attempts > 3) return;  // give up until it plays again
        stats.stallFixes++;
        post({event: 'stalled'});  // the worker puts a stuck backup aside
        const buffered = video.buffered;
        for (let i = 0; i < buffered.length; i++) {
            if (buffered.start(i) > video.currentTime + 0.1) {
                video.currentTime = buffered.start(i) + 0.05;
                return;
            }
        }
        const parts = playerParts();
        if (watch.attempts <= 2 || stats.overlayActive || !parts.state || Date.now() - watch.lastReload < 60000) {
            const p = parts.player;
            try {
                if (p && p.pause && p.play) {
                    p.pause();
                    setTimeout(function () { p.play(); }, 50);
                } else {
                    video.pause();
                    setTimeout(function () { video.play().catch(function () {}); }, 50);
                }
            } catch (e) {}
            return;
        }
        // no reload during an ad break: a new session starts with a new ad
        watch.lastReload = Date.now();
        stats.reloads++;
        try {
            parts.state.setSrc({isNewMediaPlayerInstance: false, refreshAccessToken: true});
        } catch (e) {
            stats.errors.push('reload: ' + e);
        }
    }

    setInterval(function () {
        const video = playerVideo();
        if (!video || video.paused || video.ended || video.seeking || document.hidden) {
            watch.last = -1;
            watch.stuck = 0;
            return;
        }
        if (video.currentTime !== watch.last) {
            watch.last = video.currentTime;
            watch.stuck = 0;
            watch.attempts = 0;
            return;
        }
        watch.stuck++;
        const limit = Date.now() < watch.armedUntil ? 4 : 8;
        if (watch.stuck >= limit && Date.now() - watch.lastAction > 8000) fixStall(video);
    }, 1000);

    // ---- messages from the hooked player worker ----
    const lastLogged = {};  // event kind -> time, so the ad log gets one line per ad break, not one per playlist refresh

    function logOnce(kind, details) {
        const key = kind + '|' + channelName();
        if (Date.now() - (lastLogged[key] || 0) < 90 * 1000) return;
        lastLogged[key] = Date.now();
        toHost(kind, details);
    }

    let adPlaylist = null;
    if (channel) {
        channel.onmessage = function (e) {
            const d = e.data || {};
            switch (d.event) {
                case 'worker-hooked': stats.hookedWorkers++; break;
                case 'seen-master': stats.masters++; break;
                case 'seen-playlist': stats.playlists++; break;
                case 'fetch-request': relay(d); break;
                case 'ad-start':
                    stats.adBreaks++;
                    adPlaylist = d.playlist;
                    break;
                case 'ad-seconds': stats.adSeconds += d.seconds || 0; break;
                case 'ad-end':
                    hideOverlay();
                    afterAd();
                    break;
                case 'ad-spoofed':
                    stats.spoofedAds += (d.count || 1);
                    logOnce('ad-spoofed', {summary: 'Twitch-Werbung als gesehen gemeldet (Spoofing, ' + (d.roll || 'Spot') + ')', kanal: channelName(), adId: d.id});
                    break;
                case 'backup':
                    stats.lastBackupType = d.type + (d.lq ? ' (360p)' : '');
                    if (d.forced) stats.forcedSwitches++;  // a few seconds behind, but no black picture
                    armWatch();
                    break;
                case 'replaced':
                    stats.replaced++;
                    hideOverlay();
                    logOnce('ad-blocked', {summary: 'Twitch-Werbepause ersetzt durch Player-Typ "' + stats.lastBackupType + '"', kanal: channelName()});
                    break;
                case 'bridge':
                    stats.bridgeActive = !!d.on;
                    if (d.on) stats.bridges++;
                    renderBadge();
                    break;
                case 'native-back':
                    stats.nativeReturns++;
                    armWatch();
                    afterAd();
                    break;
                case 'masked':
                    if (!stats.overlayActive) {
                        if (d.hold) stats.holds++; else stats.masked++;
                        armWatch();
                        logOnce('masked', {summary: 'Twitch, Kanal ' + channelName() + ' – kein werbefreier Ersatz-Stream, ' +
                                           (d.hold ? 'Werbung durch schwarzes Bild ersetzt' : 'Werbung abgedeckt und stumm'),
                                           playlist: adPlaylist, ersatzVersuche: stats.backupTrail.slice(-12),
                                           fehler: stats.errors.slice(-10), blocker: stats});
                    }
                    showOverlay(d.endsAt, true);
                    break;
                case 'unmasked':
                    hideOverlay();
                    armWatch();
                    afterAd();
                    break;
                case 'vod-stripped':
                    stats.vodAdsBlocked++;
                    logOnce('ad-blocked', {summary: 'Twitch-VOD: ' + d.segments + ' Werbesegmente entfernt'});
                    break;
                case 'vod-ad-blocked': stats.vodAdsBlocked++; break;
                case 'ad-request-blocked': stats.adRequestsBlocked++; break;
                case 'backup-result':
                    stats.backupTrail.push({zeit: new Date().toLocaleTimeString(), typ: d.type, ergebnis: d.result,
                                            neu: d.neu, fehler: d.error, werbungBis: d.endsAt ? new Date(d.endsAt).toLocaleTimeString() : undefined});
                    if (stats.backupTrail.length > 30) stats.backupTrail.shift();
                    if (d.result === 'fehler') {
                        stats.errors.push(d.type + ': ' + d.error);
                        if (stats.errors.length > 20) stats.errors.shift();
                    }
                    break;
                case 'error':
                    stats.errors.push(d.error);
                    if (stats.errors.length > 20) stats.errors.shift();
                    break;
            }
        };
    }


    function toHost(kind, details) {
        try {
            window.chrome.webview.postMessage({type: 'adblock-ad-event', site: 'twitch', kind: kind, details: details});
        } catch (e) {}
    }

    function deviceId() {
        try {
            const stored = localStorage.getItem('unique_id');
            if (stored && /^[a-z0-9]{8,64}$/i.test(stored)) return stored;
        } catch (e) {}
        const m = document.cookie.match(/(?:^|;\s*)unique_id=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function authHeader() {
        const m = document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/);
        return m ? 'OAuth ' + decodeURIComponent(m[1]) : '';
    }

    function hookCode() {
        const init = JSON.stringify({
            clientId: CLIENT_ID,
            deviceId: deviceId(),
            authHeader: authHeader(),
            viewer: viewer,
            backupTypes: CFG.twitchBackupTypes,
            channel: CHANNEL,
            vod: isVod(),
            adSpoofing: stats.adSpoofing  // the setting, as last switched
        });
        return WORKER_HOOK.replace('__AB_WORKER_INIT__', function () { return init; });
    }

    function readBlob(url) {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, false);  // blob: URLs are local, a sync read is instant
            xhr.send();
            return xhr.status === 200 || xhr.status === 0 ? xhr.responseText : null;
        } catch (e) {
            return null;
        }
    }

    function wrapWorkerUrl(url, options) {
        if (options && options.type === 'module') return url;
        const abs = new URL(String(url), location.href).href;
        let code = null;
        if (abs.startsWith('blob:')) {
            const original = readBlob(abs);
            if (original && /amazon-ivs|wasmworker/i.test(original)) code = hookCode() + '\n' + original;
        } else if (/amazon-ivs.*worker/i.test(abs)) {
            code = hookCode() + '\nimportScripts(' + JSON.stringify(abs) + ');';
        }
        if (!code) return url;
        return URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
    }

    try {
        if (!injectCss()) {
            const waitForDom = new MutationObserver(function () {
                if (injectCss()) waitForDom.disconnect();
            });
            waitForDom.observe(document, {childList: true, subtree: true});
        }
    } catch (e) {}

    const NativeWorker = window.Worker;
    class Worker extends NativeWorker {
        constructor(url, options) {
            let wrapped = url;
            try {
                wrapped = wrapWorkerUrl(url, options);
            } catch (e) {
                stats.errors.push('wrap: ' + e);
            }
            super(wrapped, options);
            stats.workers++;
        }
    }
    window.Worker = Worker;
})();
