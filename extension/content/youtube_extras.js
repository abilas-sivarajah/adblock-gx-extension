// YouTube extras - isolated world on youtube.com (and youtube-nocookie.com embeds), the features
// of GX Tube (Android / Desktop) that work on the YouTube page itself:
// - SponsorBlock: sponsored sections inside the video are skipped (note with "Rückgängig"),
//   sections marked "mute" are muted, the highlight is a ◆ on the progress bar and a button in the
//   player, and a note says when the whole video is sponsored. Skipped sections are green on the
//   progress bar, muted ones yellow. A section is skipped once per video: seeking back into it
//   plays it. The segments come from background.js (sponsorblock.js: asked by hash prefix, the
//   video id stays private).
// - Shorts hidden everywhere (youtube_extras.css, switched on by html[data-abgx-no-shorts]); a
//   Shorts link opens as a normal video.
// - Original audio: html[data-abgx-original-audio] switches on content/youtube_audio.js (page world).
// - Return YouTube Dislike (optional): the number next to the dislike button.
// Settings come from background.js ("yt-init") and follow the popup without a reload.
// Statistics for the popup: window.__abYtExtras (isolated world)
(function () {
    'use strict';
    if (window.__abYtExtras) return;
    const stats = window.__abYtExtras = {
        videoId: null, segments: 0, categories: [], skipped: 0, savedSeconds: 0, muted: 0, highlight: null,
        full: null, dislikes: null, shortsRedirects: 0, sponsorBlock: false, shortsHidden: false, originalAudio: false
    };
    const TOP = window.top === window;
    const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

    let cfg = null;            // from background.js ("yt-init"); {active: false} while switched off
    let videoId = null;        // video of the address
    let sb = null;             // SponsorBlock data of videoId: {id, key, segments, highlight, full}
    let skipped = new Set();   // uuids skipped in this video
    let lastSkip = null;       // {seg, at} for "Rückgängig"
    let mutedBy = null;        // {video, wasMuted} while a "mute" section plays
    let video = null;          // the player's <video>
    let srcAtChange = null;    // its source when the address switched to another video
    let fullShown = null;      // video id the "whole video" note was shown for
    let votes = null;          // {id, dislikes}
    let ticks = 0;
    let timer = 0;

    function alive() {
        try {
            return !!(chrome.runtime && chrome.runtime.id);
        } catch (e) {
            return false;  // extension reloaded: this script is orphaned
        }
    }

    function send(msg) {
        try {
            return chrome.runtime.sendMessage(msg).then(function (r) { return r && !r.error ? r : null; },
                                                        function () { return null; });
        } catch (e) {
            return Promise.resolve(null);
        }
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    // ---- settings ----
    function on(key) {
        return !!(cfg && cfg.active && cfg[key]);
    }

    function catKey() {
        return cfg && Array.isArray(cfg.categories) ? cfg.categories.join(',') : '';
    }

    function loadConfig() {
        return send({type: 'yt-init'}).then(function (c) {
            if (!alive()) return;
            cfg = c && c.active ? c : {active: false};
            applyFlags();
            if (!on('sponsorBlock')) clearSponsor();
            else if (videoId && (!sb || sb.key !== catKey())) loadSegments(videoId);
            if (!on('dislikes')) {
                votes = null;
                stats.dislikes = null;
                removeDislikes();
            } else if (videoId && !votes) {
                loadVotes(videoId);
            }
        });
    }

    function setFlag(name, value) {
        const root = document.documentElement;
        if (root && root.hasAttribute(name) !== value) root.toggleAttribute(name, value);
    }

    function applyFlags() {
        stats.sponsorBlock = on('sponsorBlock');
        stats.shortsHidden = on('hideShorts');
        stats.originalAudio = on('originalAudio');
        setFlag('data-abgx-no-shorts', stats.shortsHidden);
        setFlag('data-abgx-original-audio', stats.originalAudio);
    }

    // ---- which video ----
    function currentVideoId() {
        let u;
        try {
            u = new URL(location.href);
        } catch (e) {
            return null;
        }
        if (u.pathname === '/watch') {
            const v = u.searchParams.get('v');
            return VIDEO_ID.test(v || '') ? v : null;
        }
        const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
        if (m) return m[1];
        // no video in the address - the miniplayer while browsing: the video the player shows
        const link = document.querySelector('#movie_player a.ytp-title-link[href]');
        const p = link && /[?&]v=([A-Za-z0-9_-]{11})/.exec(link.href);
        return p ? p[1] : null;
    }

    function findVideo() {
        return document.querySelector('#movie_player video') || document.querySelector('#shorts-player video') ||
               document.querySelector('.html5-video-player video');
    }

    function playerBox() {
        return (video && video.closest('.html5-video-player')) || document.getElementById('movie_player');
    }

    // Does the <video> already play videoId? Right after a change of address it may still play the
    // previous video - skipping by the new video's times would jump around in the old one.
    function playsVideo() {
        const box = playerBox();
        const link = box && box.querySelector('a.ytp-title-link[href]');
        const m = link && /[?&]v=([A-Za-z0-9_-]{11})/.exec(link.href);
        if (m) return m[1] === videoId;  // the player's own title (fullscreen / embed)
        const known = sb && sb.segments.find(function (s) { return s.videoDuration > 0; });
        if (known && isFinite(video.duration) && video.duration > 0) {
            return Math.abs(video.duration - known.videoDuration) < 3;
        }
        return !!video.currentSrc && video.currentSrc !== srcAtChange;
    }

    function onVideo(id) {
        restoreMute();
        videoId = id;
        stats.videoId = id;
        sb = null;
        skipped = new Set();
        lastSkip = null;
        votes = null;
        srcAtChange = video ? video.currentSrc : null;
        Object.assign(stats, {segments: 0, categories: [], highlight: null, full: null, dislikes: null});
        removePlayerUi();
        removeDislikes();
        hideToast();
        if (!id) return;
        if (on('sponsorBlock')) loadSegments(id);
        if (on('dislikes')) loadVotes(id);
    }

    // ---- SponsorBlock ----
    function loadSegments(id) {
        const key = catKey();
        sb = {id: id, key: key, segments: [], highlight: null, full: null, loading: true};
        send({type: 'yt-segments', videoId: id}).then(function (r) {
            if (!sb || sb.id !== id || sb.key !== key || videoId !== id) return;  // another video / settings meanwhile
            sb = {id: id, key: key, segments: r && Array.isArray(r.segments) ? r.segments : [],
                  highlight: r && r.highlight || null, full: r && r.full || null};
            stats.segments = sb.segments.length;
            stats.categories = sb.segments.map(function (s) { return s.label; })
                .filter(function (l, i, all) { return all.indexOf(l) === i; });
            stats.highlight = sb.highlight ? sb.highlight.start : null;
            stats.full = sb.full ? sb.full.label : null;
            removePlayerUi();  // drawn again for these segments
        });
    }

    function clearSponsor() {
        restoreMute();
        sb = null;
        Object.assign(stats, {segments: 0, categories: [], highlight: null, full: null});
        removePlayerUi();
    }

    function restoreMute() {
        if (mutedBy) mutedBy.video.muted = mutedBy.wasMuted;
        mutedBy = null;
    }

    function adShowing() {
        const box = playerBox();
        return !!box && (box.classList.contains('ad-showing') || box.classList.contains('ad-interrupting'));
    }

    // port of #skipSponsors() in GX Tube Desktop (src/renderer/player.js)
    function tick() {
        const v = video;
        if (!sb || !sb.segments.length || !v || v.paused || v.seeking || adShowing() || !playsVideo()) return;
        const pos = v.currentTime;
        const segs = sb.segments;
        // sections to mute (e.g. a spoken ad in a music video)
        const mute = segs.find(function (s) { return s.action === 'mute' && pos >= s.start && pos < s.end; });
        if (mute && !mutedBy) {
            mutedBy = {video: v, wasMuted: v.muted};
            v.muted = true;
            stats.muted++;
            toast(mute.label + ': stumm geschaltet');
        } else if (!mute && mutedBy) {
            restoreMute();
        }
        const seg = segs.find(function (s) {
            return s.action === 'skip' && pos >= s.start && pos < s.end - 0.5 && !skipped.has(s.uuid);
        });
        if (!seg) return;
        skipped.add(seg.uuid);
        let end = seg.end;
        // sections right behind or overlapping: one jump
        for (;;) {
            const next = segs.find(function (s) {
                return s.action === 'skip' && !skipped.has(s.uuid) && s.start <= end + 0.5 && s.end > end;
            });
            if (!next) break;
            skipped.add(next.uuid);
            end = next.end;
        }
        const to = isFinite(v.duration) && v.duration > 0 ? Math.min(end, v.duration) : end;
        stats.skipped++;
        stats.savedSeconds = Math.round((stats.savedSeconds + Math.max(0, to - pos)) * 10) / 10;
        v.currentTime = to;
        lastSkip = {seg: seg, at: Date.now()};
        toast(seg.label + ' übersprungen', 'Rückgängig', undoSkip);
    }

    // watch the last skipped section after all (it stays marked as skipped)
    function undoSkip() {
        if (!lastSkip || !video || Date.now() - lastSkip.at > 15000) return;
        video.currentTime = lastSkip.seg.start;
        lastSkip = null;
    }

    // ---- note in the player ----
    let toastEl = null, toastTimer = 0;

    function stopPlayerClicks(e) {
        e.stopPropagation();  // the player would pause / play
    }

    function toast(text, action, run, ms) {
        const box = playerBox();
        if (!box) return;
        if (!toastEl) {
            toastEl = el('div', 'abgx-toast');
            ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(function (t) {
                toastEl.addEventListener(t, stopPlayerClicks);
            });
        }
        toastEl.textContent = '';
        toastEl.appendChild(el('span', 'abgx-toast-text', text));
        if (action) {
            const b = el('button', null, action);
            b.type = 'button';
            b.addEventListener('click', function () {
                run();
                hideToast();
            });
            toastEl.appendChild(b);
        }
        if (toastEl.parentNode !== box) box.appendChild(toastEl);
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, ms || 5000);
    }

    function hideToast() {
        clearTimeout(toastTimer);
        if (toastEl) toastEl.classList.remove('show');
    }

    // ---- progress bar, highlight button ----
    let barEl = null, barKey = '', hlButton = null;

    function pct(sec, dur) {
        return Math.max(0, Math.min(100, sec / dur * 100)) + '%';
    }

    function renderBar() {
        const box = playerBox();
        const bar = box && box.querySelector('.ytp-progress-bar');
        const dur = video.duration;
        if (!bar || !isFinite(dur) || dur <= 0 || (!sb.segments.length && !sb.highlight)) return;
        const key = sb.id + '|' + sb.key + '|' + Math.round(dur);
        if (barEl && barEl.parentNode === bar && barKey === key) return;
        if (!barEl) barEl = el('div', 'abgx-sb-bar');
        barEl.textContent = '';
        const strip = el('div', 'abgx-sb-strip');
        sb.segments.forEach(function (s) {
            const d = el('div', 'abgx-sb-seg' + (s.action === 'mute' ? ' mute' : ''));
            d.style.left = pct(s.start, dur);
            d.style.width = pct(s.end - s.start, dur);
            strip.appendChild(d);
        });
        barEl.appendChild(strip);
        if (sb.highlight) {
            const poi = el('div', 'abgx-sb-poi');
            poi.style.left = pct(sb.highlight.start, dur);
            poi.title = 'Highlight (SponsorBlock)';
            barEl.appendChild(poi);
        }
        bar.appendChild(barEl);
        barKey = key;
    }

    function renderHighlightButton() {
        const box = playerBox();
        const controls = box && box.querySelector('.ytp-left-controls');
        if (!sb.highlight || !controls) {
            if (hlButton) hlButton.remove();
            return;
        }
        if (!hlButton) {
            hlButton = el('button', 'ytp-button abgx-hl-btn', '◆ Highlight');
            hlButton.type = 'button';
            hlButton.title = 'Zum Highlight springen (SponsorBlock)';
            hlButton.addEventListener('click', function (e) {
                e.stopPropagation();
                if (video && sb && sb.highlight) video.currentTime = sb.highlight.start;
            });
        }
        if (hlButton.parentNode !== controls) controls.appendChild(hlButton);
    }

    function removePlayerUi() {
        if (barEl) barEl.remove();
        barKey = '';
        if (hlButton) hlButton.remove();
    }

    // ---- Return YouTube Dislike ----
    function loadVotes(id) {
        votes = {id: id, dislikes: null};
        send({type: 'yt-votes', videoId: id}).then(function (r) {
            if (videoId !== id || !votes || votes.id !== id) return;
            votes = {id: id, dislikes: r && Number.isFinite(r.dislikes) ? r.dislikes : null};
            stats.dislikes = votes.dislikes;
        });
    }

    function dislikeButton() {
        return document.querySelector('ytd-watch-metadata dislike-button-view-model button') ||
               document.querySelector('#top-level-buttons-computed dislike-button-view-model button') ||
               document.querySelector('#segmented-dislike-button button');
    }

    function formatCount(n) {
        try {
            return new Intl.NumberFormat(document.documentElement.lang || navigator.language || 'de-DE',
                                         {notation: 'compact', maximumFractionDigits: 1}).format(n);
        } catch (e) {
            return String(n);
        }
    }

    function renderDislikes() {
        if (!votes || votes.id !== videoId || votes.dislikes == null) return;
        const button = dislikeButton();
        if (!button) return;
        let span = button.querySelector('.abgx-dislikes');
        if (!span) {
            removeDislikes();  // a button of the previous video
            span = el('span', 'abgx-dislikes');
            span.title = 'Dislikes (Return YouTube Dislike, geschätzt)';
            button.appendChild(span);
            button.classList.add('abgx-dislikes-btn');
        }
        const text = formatCount(votes.dislikes);
        if (span.textContent !== text) span.textContent = text;
    }

    function removeDislikes() {
        document.querySelectorAll('.abgx-dislikes').forEach(function (span) {
            if (span.parentNode) span.parentNode.classList.remove('abgx-dislikes-btn');
            span.remove();
        });
    }

    // ---- main loop (4x a second; drawing once a second) ----
    function attach(v) {
        if (video) video.removeEventListener('timeupdate', onTime);
        video = v;
        if (video) video.addEventListener('timeupdate', onTime);
    }

    function onTime() {
        if (on('sponsorBlock')) tick();
    }

    function stop() {
        clearInterval(timer);
        restoreMute();
        attach(null);
        removePlayerUi();
        hideToast();
    }

    function loop() {
        if (!alive()) {
            stop();
            return;
        }
        if (!cfg) return;
        applyFlags();  // <html> may not have existed at document start
        const id = currentVideoId();
        if (id !== videoId) onVideo(id);
        if (!cfg.active) return;
        if (on('hideShorts') && TOP && location.hostname !== 'music.youtube.com') {
            const m = /^\/shorts\/([A-Za-z0-9_-]{11})/.exec(location.pathname);
            if (m) {
                stats.shortsRedirects++;
                location.replace(location.origin + '/watch?v=' + m[1]);
                return;
            }
        }
        const v = findVideo();
        if (v !== video) attach(v);
        const draw = ticks++ % 4 === 0;
        if (sb && !sb.loading && video && on('sponsorBlock')) {
            tick();
            if (draw && playsVideo()) {
                renderBar();
                renderHighlightButton();
                if (sb.full && fullShown !== videoId) {
                    fullShown = videoId;
                    toast(sb.full.label + ' – laut SponsorBlock das ganze Video', null, null, 7000);
                }
            }
        }
        if (draw && on('dislikes')) renderDislikes();
    }

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.settings && alive()) loadConfig();
    });
    loadConfig().then(function () {
        if (!alive()) return;
        onVideo(currentVideoId());
        timer = setInterval(loop, 250);
    });
})();
