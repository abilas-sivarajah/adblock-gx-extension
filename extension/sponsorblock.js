// SponsorBlock (sponsor.ajay.app) and Return YouTube Dislike - the same rules as GX Tube
// (Android: data/SponsorBlock.kt, Desktop: src/main/sponsorblock.js and community.js).
// Loaded by background.js (importScripts); the requests come from the service worker, so the
// page's CSP and CORS do not matter. Tests: dev_tests/youtube_extras.test.mjs
// - Segments are asked by the first 4 characters of SHA-256(video id): the server answers for
//   every video with that prefix, so it does not learn which one is watched.
// - Return YouTube Dislike gets the video id itself - off by default (popup).
(function (root) {
    'use strict';

    const CATEGORIES = {
        sponsor: 'Sponsor',
        selfpromo: 'Eigenwerbung',
        interaction: 'Erinnerung zum Abonnieren',
        intro: 'Intro',
        outro: 'Abspann',
        preview: 'Vorschau',
        music_offtopic: 'Nicht-Musik-Abschnitt',
        filler: 'Abschweifung',
    };
    const DEFAULT_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];
    // "the whole video is ..." (actionType full)
    const FULL_LABELS = {
        sponsor: 'Gesponsertes Video',
        selfpromo: 'Eigenwerbung',
        exclusive_access: 'Exklusiver Zugang (gesponsert)',
    };
    const ACTION_TYPES = ['skip', 'mute', 'full', 'poi'];
    const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
    const TIMEOUT_MS = 8000;
    const EMPTY = Object.freeze({segments: [], highlight: null, full: null});

    function cleanCategories(categories) {
        return Array.isArray(categories) ? categories.filter(function (c, i, all) {
            return Object.prototype.hasOwnProperty.call(CATEGORIES, c) && all.indexOf(c) === i;
        }) : [];
    }

    // answer of /api/skipSegments/<prefix> -> what the page needs (seconds). categories: what to skip.
    function parseSegments(list, videoId, categories) {
        const wanted = new Set(cleanCategories(categories));
        const entry = Array.isArray(list) ? list.find(function (e) { return e && e.videoID === videoId; }) : null;
        const all = (entry && Array.isArray(entry.segments) ? entry.segments : []).filter(function (s) {
            return s && Array.isArray(s.segment) && s.segment.length >= 2;
        });
        const sec = function (v) { return Math.max(0, Math.round((Number(v) || 0) * 1000) / 1000); };
        const segments = all.filter(function (s) {
            return (s.actionType === 'skip' || s.actionType === 'mute') && wanted.has(s.category);
        }).map(function (s) {
            return {start: sec(s.segment[0]), end: sec(s.segment[1]), category: s.category,
                    label: CATEGORIES[s.category], action: s.actionType, uuid: String(s.UUID || ''),
                    videoDuration: sec(s.videoDuration)};
        }).filter(function (s) {
            return s.end > s.start && s.uuid;
        }).sort(function (a, b) { return a.start - b.start; });
        const poi = all.find(function (s) { return s.actionType === 'poi' && s.category === 'poi_highlight'; });
        const full = all.find(function (s) { return s.actionType === 'full' && FULL_LABELS[s.category]; });
        return {
            segments: segments,
            highlight: poi ? {start: sec(poi.segment[0]), uuid: String(poi.UUID || '')} : null,
            full: full ? {category: full.category, label: FULL_LABELS[full.category]} : null,
        };
    }

    async function hashPrefix(videoId) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(videoId));
        return Array.from(new Uint8Array(digest).slice(0, 2)).map(function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    function segmentsUrl(prefix, categories) {
        // highlight and "whole video" always come along - skipped is only what is chosen
        const query = cleanCategories(categories).concat(['poi_highlight', 'sponsor', 'selfpromo', 'exclusive_access'])
            .filter(function (c, i, all) { return all.indexOf(c) === i; });
        return 'https://sponsor.ajay.app/api/skipSegments/' + prefix +
            '?categories=' + encodeURIComponent(JSON.stringify(query)) +
            '&actionTypes=' + encodeURIComponent(JSON.stringify(ACTION_TYPES));
    }

    // never throws: SponsorBlock off, nothing found (404) or not reachable -> EMPTY
    async function fetchSegments(videoId, categories, fetchImpl) {
        if (!VIDEO_ID.test(videoId || '')) return EMPTY;
        try {
            const res = await (fetchImpl || fetch)(segmentsUrl(await hashPrefix(videoId), categories),
                {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(TIMEOUT_MS)});
            if (!res.ok) return EMPTY;
            return parseSegments(await res.json(), videoId, categories);
        } catch (e) {
            return EMPTY;
        }
    }

    // Return YouTube Dislike: {likes, dislikes} or null
    async function fetchVotes(videoId, fetchImpl) {
        if (!VIDEO_ID.test(videoId || '')) return null;
        try {
            const res = await (fetchImpl || fetch)('https://returnyoutubedislikeapi.com/votes?videoId=' + videoId,
                {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(TIMEOUT_MS)});
            if (!res.ok) return null;
            const j = await res.json();
            const num = function (v) { return Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null; };
            const value = {likes: num(j && j.likes), dislikes: num(j && j.dislikes)};
            return value.dislikes === null ? null : value;
        } catch (e) {
            return null;
        }
    }

    const api = {CATEGORIES: CATEGORIES, DEFAULT_CATEGORIES: DEFAULT_CATEGORIES, FULL_LABELS: FULL_LABELS,
                 EMPTY: EMPTY, cleanCategories: cleanCategories, parseSegments: parseSegments,
                 hashPrefix: hashPrefix, segmentsUrl: segmentsUrl, fetchSegments: fetchSegments,
                 fetchVotes: fetchVotes};
    root.abSponsorBlock = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
