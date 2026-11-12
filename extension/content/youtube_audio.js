// YouTube: always the original audio - page world (MAIN) on youtube.com, like "Immer der Originalton"
// in GX Tube Desktop: YouTube plays dubbed and AI-translated audio tracks ("automatisch
// synchronisiert") in the viewer's language; this script switches the player back to the track
// the video was recorded with. Active while content/youtube_extras.js sets
// html[data-abgx-original-audio] (setting in the popup, on by default).
// - Which track is the original: YouTube marks the audio formats of the player response in xtags
//   (acont=original / dubbed / dubbed-auto); without a mark the name ("… original"), at last the
//   default track - the same order as originalAudioTrack() in GX Tube Desktop.
// - Once per video: a track picked by hand afterwards stays.
// Statistics for the popup: window.__abYtAudio
(function () {
    'use strict';
    if (window.__abYtAudio) return;
    const stats = window.__abYtAudio = {switched: 0, checked: 0, last: null};
    const done = new Set();  // video ids already on the original track (or switched there)

    function wanted() {
        const root = document.documentElement;
        return !!root && root.hasAttribute('data-abgx-original-audio');
    }

    function decode(xtags) {
        try {
            return atob(String(xtags).replace(/-/g, '+').replace(/_/g, '/'));
        } catch (e) {
            return '';
        }
    }

    // id of the original audio track ("en.4" ...) in a player response, null if there is only one
    function originalTrackId(response) {
        const formats = response && response.streamingData && response.streamingData.adaptiveFormats || [];
        const audio = formats.filter(function (f) { return f && f.audioTrack && f.audioTrack.id; });
        const ids = new Set(audio.map(function (f) { return f.audioTrack.id; }));
        if (ids.size < 2) return null;
        const marked = audio.find(function (f) { return f.xtags && /acont[\s\S]{1,3}original/.test(decode(f.xtags)); });
        if (marked) return marked.audioTrack.id;
        const named = audio.find(function (f) { return /original/i.test(f.audioTrack.displayName || ''); });
        if (named) return named.audioTrack.id;
        const fallback = audio.find(function (f) { return f.audioTrack.audioIsDefault; });
        return fallback ? fallback.audioTrack.id : null;
    }

    // The player's track objects have minified property names - look for the id (or the name)
    // a few levels down instead of relying on one of them.
    function holds(obj, test, depth) {
        if (!obj || typeof obj !== 'object' || depth > 2) return false;
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
            let v;
            try {
                v = obj[keys[i]];
            } catch (e) {
                continue;
            }
            if (typeof v === 'string' ? test(v) : v && typeof v === 'object' && holds(v, test, depth + 1)) return true;
        }
        return false;
    }

    function player() {
        return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    }

    function check() {
        if (!wanted()) return;
        const p = player();
        if (!p || typeof p.getAvailableAudioTracks !== 'function' || typeof p.setAudioTrack !== 'function') return;
        let data = null, tracks = null, response = null;
        try {
            data = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
            tracks = p.getAvailableAudioTracks() || [];
            response = typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
        } catch (e) {
            return;
        }
        const vid = data && data.video_id;
        if (!vid || done.has(vid) || tracks.length < 2) return;
        // the response must be the one of this video (right after a change it can still be the old one)
        const details = response && response.videoDetails;
        if (details && details.videoId && details.videoId !== vid) return;
        stats.checked++;
        const id = originalTrackId(response);
        const isOriginal = id ? function (s) { return s === id; } : function (s) { return /original/i.test(s); };
        const candidates = tracks.filter(function (t) { return holds(t, isOriginal, 0); });
        if (candidates.length !== 1) return;  // no or no clear original track
        let current = null;
        try {
            current = p.getAudioTrack();
        } catch (e) {}
        done.add(vid);
        if (current === candidates[0] || (current && holds(current, isOriginal, 0))) return;
        try {
            p.setAudioTrack(candidates[0]);
            stats.switched++;
            stats.last = vid;
        } catch (e) {}
    }

    function soon() {
        setTimeout(check, 300);
    }

    // media events do not bubble, but the capture phase passes the document
    document.addEventListener('loadedmetadata', soon, true);
    document.addEventListener('playing', soon, true);
    document.addEventListener('yt-navigate-finish', soon);
    setInterval(check, 1500);
    window.__abYtAudioTest = {originalTrackId: originalTrackId, check: check};  // dev_tests/youtube_extras.test.mjs
})();
