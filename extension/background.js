// AdBlock GX - service worker.
// - Site scripts (Twitch, YouTube, Netflix; generated from the desktop browser's scripts/*.js by
//   tools/build_extension.py) are registered in the page's MAIN world. "Protection off"
//   unregisters them, the exception list becomes their excludeMatches - the scripts themselves
//   always run with {enabled: true, whitelist: []}. Twitch comes in two builds: with and without
//   ad spoofing (reports blocked ads as watched, with the viewer's login) - a setting, off by
//   default. The flag is baked into generated/twitch.js vs twitch_spoofing.js for the next page
//   load; the current Twitch tab is told over content/twitch_bridge.js, so no reload is needed.
// - Network blocking: the static declarativeNetRequest rule sets (generated/rules_*.json), enabled
//   as far as Chrome's rule limit allows; the exception list is one dynamic allowAllRequests rule.
// - Element hiding: content/cosmetic.js reports each frame's classes/ids, the matching rules of
//   generated/cosmetic.json are inserted with scripting.insertCSS as user styles (one rule per
//   selector, like build_cosmetic_css() of the desktop browser) - the page's CSP cannot stop them.
// - Discord stream mode: content/discord_hint.js on streaming sites points to the browser's
//   hardware acceleration setting (an extension cannot switch it itself).
// - Updates: at browser start and hourly, tools/update_extension.py (native messaging host) pulls
//   both repositories from GitHub and rebuilds. An unpacked extension only reads manifest, rule
//   sets and this worker when it is loaded, so a new build (generated/build_info.json, written last
//   by the build - also a build run by hand) makes the extension reload itself.
'use strict';

const DEFAULT_SETTINGS = {
    enabled: true,
    whitelist: [],      // domains without "www.", subdomains included
    rulesets: {},       // rule set id -> on/off as chosen in the popup (otherwise its default)
    discordHint: true,  // banner on Netflix / Prime Video / Disney+ while hardware acceleration is on
    twitchAdSpoofing: false,  // generated/twitch_spoofing.js instead of twitch.js
    autoUpdate: true,   // update from GitHub at browser start and hourly
};
// above every static rule (tools/abp2dnr.py: 1 block ... 4 site_fixes exceptions)
const WHITELIST_PRIORITY = 100;

const SITE_SCRIPTS = [
    {id: 'ab-twitch', matches: ['*://*.twitch.tv/*'], js: ['generated/twitch.js'], spoofingJs: ['generated/twitch_spoofing.js']},
    {id: 'ab-youtube', matches: ['*://*.youtube.com/*'], js: ['generated/youtube.js']},
    {id: 'ab-netflix', matches: ['*://*.netflix.com/*'], js: ['generated/netflix.js']},
];

// DRM streaming sites that stay black in Discord's screen share with hardware acceleration
const AMAZON_VIDEO = ['de', 'com', 'co.uk', 'fr', 'it', 'es', 'nl'].reduce(function (list, tld) {
    return list.concat(['*://*.amazon.' + tld + '/gp/video/*', '*://*.amazon.' + tld + '/-/*/gp/video/*']);
}, []);
const STREAMING_SITES = ['*://*.netflix.com/*', '*://*.primevideo.com/*', '*://*.disneyplus.com/*'].concat(AMAZON_VIDEO);

// ---- settings ----
let settingsCache = null;

async function getSettings() {
    if (!settingsCache) {
        const stored = (await chrome.storage.local.get('settings')).settings || {};
        settingsCache = Object.assign({}, DEFAULT_SETTINGS, stored);
    }
    return settingsCache;
}

async function saveSettings(patch) {
    const settings = Object.assign({}, await getSettings(), patch);
    settingsCache = settings;
    await chrome.storage.local.set({settings: settings});
    await sync();
    return settings;
}

// ---- domains ----
function hostOf(url) {
    try {
        const u = new URL(url);
        return /^(https?|wss?):$/.test(u.protocol) ? u.hostname.toLowerCase() : '';
    } catch (e) {
        return '';
    }
}

// what goes on the exception list for a page: its host without "www."
function siteOf(host) {
    return host.replace(/^www\./, '');
}

function isWhitelisted(host, whitelist) {
    return !!host && whitelist.some(function (d) { return host === d || host.endsWith('.' + d); });
}

function excludePattern(domain) {
    return /^[\d.]+$/.test(domain) ? '*://' + domain + '/*' : '*://*.' + domain + '/*';
}

// ---- content scripts ----
function wantedContentScripts(settings) {
    const scripts = [];
    if (settings.enabled) {
        const exclude = settings.whitelist.map(excludePattern);
        SITE_SCRIPTS.forEach(function (s) {
            const js = settings.twitchAdSpoofing && s.spoofingJs || s.js;
            scripts.push({id: s.id, matches: s.matches, js: js, world: 'MAIN', runAt: 'document_start', allFrames: true});
        });
        scripts.push({id: 'ab-twitch-bridge', matches: ['*://*.twitch.tv/*'], js: ['content/twitch_bridge.js'],
                      world: 'ISOLATED', runAt: 'document_start', allFrames: true});
        scripts.push({id: 'ab-cosmetic', matches: ['http://*/*', 'https://*/*'], js: ['content/cosmetic.js'],
                      world: 'ISOLATED', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true});
        scripts.forEach(function (s) { if (exclude.length) s.excludeMatches = exclude; });
    }
    // not a blocker feature: independent of "protection off" and the exception list
    if (settings.discordHint) {
        scripts.push({id: 'ab-discord', matches: STREAMING_SITES, js: ['gpu.js', 'content/discord_hint.js'],
                      world: 'ISOLATED', runAt: 'document_idle', allFrames: false});
    }
    return scripts;
}

// compare registrations by what matters (Chrome fills in defaults when reading them back)
function scriptSignature(s) {
    return JSON.stringify([s.id, s.matches, s.excludeMatches || [], s.js, s.world || 'ISOLATED',
                           s.runAt || 'document_idle', !!s.allFrames, !!s.matchOriginAsFallback]);
}

async function syncContentScripts(settings) {
    const wanted = new Map(wantedContentScripts(settings).map(function (s) { return [s.id, s]; }));
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const stale = existing.filter(function (s) {
        return !wanted.has(s.id) || scriptSignature(s) !== scriptSignature(wanted.get(s.id));
    }).map(function (s) { return s.id; });
    if (stale.length) await chrome.scripting.unregisterContentScripts({ids: stale});
    const kept = new Set(existing.map(function (s) { return s.id; }).filter(function (id) { return !stale.includes(id); }));
    const add = Array.from(wanted.values()).filter(function (s) { return !kept.has(s.id); });
    if (add.length) await chrome.scripting.registerContentScripts(add);
}

// ---- network rules ----
let rulesetInfo = null;

function getRulesetInfo() {
    if (!rulesetInfo) {
        rulesetInfo = fetch(chrome.runtime.getURL('generated/rulesets.json')).then(function (r) { return r.json(); });
        rulesetInfo.catch(function () { rulesetInfo = null; });
    }
    return rulesetInfo;
}

function rulesetWanted(ruleset, settings) {
    if (!settings.enabled) return false;
    if (ruleset.mode === 'always') return true;
    const choice = settings.rulesets[ruleset.id];
    return typeof choice === 'boolean' ? choice : true;  // "on" and "auto" lists start enabled
}

async function syncRulesets(settings) {
    const info = await getRulesetInfo();
    const enabledNow = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
    const wanted = info.rulesets.filter(function (r) { return rulesetWanted(r, settings); });
    const disable = info.rulesets.filter(function (r) { return enabledNow.has(r.id) && !wanted.includes(r); });
    // room in Chrome's static rule limit: 30,000 per extension guaranteed, more if free globally
    let room = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
    disable.forEach(function (r) { room += r.rules; });
    const enable = [];
    for (const r of wanted) {  // in manifest order: site fixes and the standard lists first
        if (enabledNow.has(r.id)) continue;
        if (r.rules <= room) {
            enable.push(r.id);
            room -= r.rules;
        }  // else: shown as "does not fit" in the popup
    }
    if (enable.length || disable.length) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
            enableRulesetIds: enable, disableRulesetIds: disable.map(function (r) { return r.id; })});
    }
}

async function syncWhitelistRules(settings) {
    const domains = settings.enabled ? settings.whitelist.slice().sort() : [];
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const current = existing.length === 1 && existing[0].id === 1 && existing[0].condition.requestDomains;
    if (current ? current.join() === domains.join() : !existing.length && !domains.length) return;
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(function (r) { return r.id; }),
        addRules: domains.length ? [{
            id: 1, priority: WHITELIST_PRIORITY, action: {type: 'allowAllRequests'},
            condition: {requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame']},
        }] : [],
    });
}

// ---- element hiding ----
let cosmeticData = null;            // loaded once per service worker start
const cosmeticContexts = new Map(); // host -> rules for it (small cache)

function getCosmetics() {
    if (!cosmeticData) {
        cosmeticData = fetch(chrome.runtime.getURL('generated/cosmetic.json')).then(function (r) { return r.json(); })
            .then(function (d) {
                const map = function (o) { return new Map(Object.entries(o)); };
                return {specific: map(d.specific), styles: map(d.styles), exceptions: map(d.exceptions),
                        classes: map(d.classes), ids: map(d.ids), generic: d.generic,
                        generichide: new Set(d.generichide), elemhide: new Set(d.elemhide)};
            });
        cosmeticData.catch(function () { cosmeticData = null; });
    }
    return cosmeticData;
}

// keys a host's rules can be stored under: the host, its parent domains and entity forms
// ("google.*" for google.de / google.co.uk)
function hostKeys(host) {
    const labels = host.split('.');
    const keys = [];
    for (let i = 0; i < labels.length; i++) {
        const rest = labels.slice(i);
        keys.push(rest.join('.'));
        for (let cut = 1; cut <= 2 && cut < rest.length; cut++) keys.push(rest.slice(0, rest.length - cut).join('.') + '.*');
    }
    return keys;
}

function cosmeticContext(data, host) {
    let ctx = cosmeticContexts.get(host);
    if (ctx) return ctx;
    const keys = hostKeys(host);
    ctx = {elemhide: false, generichide: false, exceptions: new Set(), specific: [], styles: []};
    keys.forEach(function (k) {
        if (data.elemhide.has(k)) ctx.elemhide = true;
        if (data.generichide.has(k)) ctx.generichide = true;
        (data.exceptions.get(k) || []).forEach(function (s) { ctx.exceptions.add(s); });
    });
    const specific = new Set();
    keys.forEach(function (k) {
        (data.specific.get(k) || []).forEach(function (s) { if (!ctx.exceptions.has(s)) specific.add(s); });
        ctx.styles.push.apply(ctx.styles, data.styles.get(k) || []);
    });
    ctx.specific = Array.from(specific);
    if (cosmeticContexts.size > 200) cosmeticContexts.clear();
    cosmeticContexts.set(host, ctx);
    return ctx;
}

function hideCss(selectors) {
    // one rule per selector: a selector the browser does not understand only drops itself
    // (open brackets/quotes would take the following rules along - the build skips those)
    return selectors.map(function (s) { return s + ' { display: none !important; }'; }).join('\n');
}

// hide rules of the generic selectors that have no class/id key - the same for every host
// without an exception for one of them, so built once instead of for every frame
function genericCss(data, ctx) {
    if (ctx.generichide) return '';
    const kept = ctx.exceptions.size ? data.generic.filter(function (s) { return !ctx.exceptions.has(s); }) : data.generic;
    if (kept.length < data.generic.length) return hideCss(kept);
    if (data.genericCss == null) data.genericCss = hideCss(data.generic);
    return data.genericCss;
}

async function onCosmeticMessage(msg, sender) {
    const tab = sender.tab;
    if (!tab || tab.id < 0) return {active: false};
    const settings = await getSettings();
    // about:blank frames report their creator's origin
    const frameHost = hostOf(sender.url || '') || hostOf(sender.origin || '');
    if (!settings.enabled || !frameHost || isWhitelisted(frameHost, settings.whitelist) ||
        isWhitelisted(hostOf(tab.url || ''), settings.whitelist)) return {active: false};
    const data = await getCosmetics();
    const ctx = cosmeticContext(data, frameHost);
    if (ctx.elemhide) return {active: false};

    let css = '';
    if (msg.type === 'cosmetic-init') {
        css = [hideCss(ctx.specific), genericCss(data, ctx), ctx.styles.join('\n')].filter(Boolean).join('\n');
    } else if (!ctx.generichide) {
        const selectors = [];
        const add = function (list) {
            (list || []).forEach(function (s) { if (!ctx.exceptions.has(s)) selectors.push(s); });
        };
        (msg.classes || []).forEach(function (c) { if (typeof c === 'string') add(data.classes.get(c)); });
        (msg.ids || []).forEach(function (i) { if (typeof i === 'string') add(data.ids.get(i)); });
        css = hideCss(selectors);
    }
    if (css) {
        const target = {tabId: tab.id};
        if (sender.documentId) target.documentIds = [sender.documentId]; else target.frameIds = [sender.frameId];
        await chrome.scripting.insertCSS({target: target, css: css, origin: 'USER'}).catch(function () {});
    }
    return {active: !ctx.generichide};
}

// ---- Discord stream mode ----
// Both pages hold "Use graphics acceleration when available" (Opera also opens chrome:// URLs)
function gpuSettingsUrl() {
    return /\bOPR\//.test(navigator.userAgent) ? 'opera://settings/system' : 'chrome://settings/system';
}

async function openGpuSettings(tab) {
    const props = {url: gpuSettingsUrl()};
    if (tab) {
        props.index = tab.index + 1;
        props.windowId = tab.windowId;
    }
    await chrome.tabs.create(props);
}

function isStreamingSite(url) {
    return /^https:\/\/([^/]+\.)?(netflix\.com|primevideo\.com|disneyplus\.com)\//.test(url) ||
           /^https:\/\/([^/]+\.)?amazon\.[a-z.]+\/(-\/[^/]+\/)?gp\/video\//.test(url);
}

async function onDiscordMessage(msg, sender) {
    if (msg.type === 'open-gpu-settings') {
        await openGpuSettings(sender.tab);
        return {};
    }
    if (msg.type === 'discord-hint-off') {
        await saveSettings({discordHint: false});
        return {};
    }
    // "discord-hint-check": the banner shows once per browser session (the page checks the GPU
    // afterwards - switching acceleration needs a browser restart, i.e. a new session, anyway)
    const settings = await getSettings();
    if (!settings.discordHint || (await chrome.storage.session.get('discordHintShown')).discordHintShown) return {show: false};
    await chrome.storage.session.set({discordHintShown: true});
    return {show: true};
}

// ---- toolbar button ----
async function updateAction(settings) {
    const on = settings.enabled;
    // number of blocked requests per tab, counted by Chrome
    await chrome.declarativeNetRequest.setExtensionActionOptions({displayActionCountAsBadgeText: on});
    await chrome.action.setIcon({path: on ? {16: 'icons/icon16.png', 32: 'icons/icon32.png'}
                                          : {16: 'icons/off16.png', 32: 'icons/off32.png'}});
    await chrome.action.setTitle({title: on ? 'AdBlock GX' : 'AdBlock GX – Schutz aus'});
    await chrome.action.setBadgeBackgroundColor({color: '#fa1e4e'});
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({color: '#ffffff'});
    await chrome.action.setBadgeText({text: on ? '' : 'aus'});
}

// ---- updates from GitHub ----
const UPDATE_HOST = 'com.adblock_gx.updater';  // tools/update_extension.py --install
const UPDATE_EVERY_MIN = 60;
const UPDATE_RETRY_MIN = 5;                     // GitHub not reachable, e.g. browser started before the network
const UPDATE_MIN_GAP_MS = 3 * 60 * 1000;        // automatic runs: browser restarted right away
let updateRun = null;                           // promise of the running update
let updateProgress = '';

function readBuildInfo() {
    // fresh from disk: an unpacked extension reads its files on every request
    return fetch(chrome.runtime.getURL('generated/build_info.json'), {cache: 'no-store'})
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
}

// storage.session is emptied whenever the extension is (re)loaded, so the first look after
// loading notes the build that was loaded
async function reloadIfNewBuild() {
    const info = await readBuildInfo();
    const loaded = (await chrome.storage.session.get('loadedBuild')).loadedBuild;
    if (!loaded) {
        await chrome.storage.session.set({loadedBuild: info && info.build || 'none'});
        return false;
    }
    if (!info || !info.build || info.build === loaded) return false;
    // at most one reload per build: never a loop, whatever the browser keeps across reloads
    if ((await chrome.storage.local.get('reloadedFor')).reloadedFor === info.build) return false;
    await chrome.storage.local.set({reloadedFor: info.build});
    console.info('AdBlock GX: neuer Build ' + info.build + ' - lade neu');
    chrome.runtime.reload();
    return true;
}

function callUpdater(msg, onProgress) {
    return new Promise(function (resolve) {
        let port;
        try {
            port = chrome.runtime.connectNative(UPDATE_HOST);
        } catch (e) {
            resolve({ok: false, notInstalled: true, message: String(e && e.message || e)});
            return;
        }
        let answered = false;
        port.onMessage.addListener(function (m) {
            if (m.type === 'progress') {
                if (onProgress) onProgress(m.text);
                return;
            }
            answered = true;
            port.disconnect();
            resolve(m);
        });
        port.onDisconnect.addListener(function () {
            if (answered) return;
            const error = chrome.runtime.lastError && chrome.runtime.lastError.message || 'Updater ohne Ergebnis beendet';
            // "Specified native messaging host not found." / "... host is forbidden."
            resolve({ok: false, notInstalled: /not found|forbidden/i.test(error), message: error});
        });
        port.postMessage(msg);
    });
}

function runUpdate() {
    if (!updateRun) {
        updateProgress = 'Starte …';
        updateRun = callUpdater({type: 'update'}, function (text) { updateProgress = text; }).then(async function (result) {
            delete result.type;
            result.time = Date.now();
            await chrome.storage.local.set({lastUpdate: result});
            if (!result.ok && !result.notInstalled) chrome.alarms.create('update-retry', {delayInMinutes: UPDATE_RETRY_MIN});
            return result;
        }).finally(function () {
            updateRun = null;
            updateProgress = '';
        });
        // a moment for the popup to show the result before the reload closes it
        updateRun.then(function () { setTimeout(reloadIfNewBuild, 1500); });
    }
    return updateRun;
}

async function autoUpdate() {
    const settings = await getSettings();
    if (!settings.autoUpdate || updateRun) return;
    const last = (await chrome.storage.local.get('lastUpdate')).lastUpdate;
    if (last && Date.now() - last.time < UPDATE_MIN_GAP_MS) return;
    await runUpdate();
}

async function updateState(settings) {
    return {
        auto: settings.autoUpdate,
        running: !!updateRun,
        progress: updateProgress,
        last: (await chrome.storage.local.get('lastUpdate')).lastUpdate || null,
        build: await readBuildInfo(),
    };
}

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'update' || alarm.name === 'update-retry') autoUpdate();
});
// alarms do not reliably survive browser restarts and extension updates
chrome.alarms.get('update').then(function (alarm) {
    if (!alarm) chrome.alarms.create('update', {delayInMinutes: UPDATE_EVERY_MIN, periodInMinutes: UPDATE_EVERY_MIN});
});
// a build run by hand: picked up the next time the worker starts
reloadIfNewBuild().catch(function (e) { console.error('AdBlock GX: Build-Prüfung fehlgeschlagen', e); });

// ---- keeping everything in step with the settings (idempotent, one run at a time) ----
let syncQueue = Promise.resolve();

function sync() {
    syncQueue = syncQueue.then(runSync, runSync);
    return syncQueue;
}

async function runSync() {
    const settings = await getSettings();
    const steps = [syncContentScripts, syncRulesets, syncWhitelistRules, updateAction];
    for (const step of steps) {
        try {
            await step(settings);
        } catch (e) {
            console.error('AdBlock GX: ' + step.name + ' fehlgeschlagen', e);
        }
    }
}

chrome.runtime.onInstalled.addListener(function () { sync(); });
chrome.runtime.onStartup.addListener(function () {
    sync();
    autoUpdate();  // whatever changed on GitHub arrives with the next browser start
});
// The browser forgets icon, title and badge when the extension is switched off and on in
// chrome://extensions (no onInstalled/onStartup then): set them on every service worker start.
getSettings().then(updateAction).catch(function (e) { console.error('AdBlock GX: updateAction fehlgeschlagen', e); });

// ---- popup ----
async function tabState(tabId) {
    const settings = await getSettings();
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(function () { return null; }) : null;
    const host = tab ? hostOf(tab.url || '') : '';
    const info = await getRulesetInfo();
    const enabledNow = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
    // with declarativeNetRequestFeedback the badge text is the real count
    const badge = tab ? await chrome.action.getBadgeText({tabId: tab.id}).catch(function () { return ''; }) : '';
    return {
        enabled: settings.enabled,
        host: host,
        site: host ? siteOf(host) : '',
        whitelisted: isWhitelisted(host, settings.whitelist),
        blocked: /^\d+\+?$/.test(badge) ? badge : '0',
        rulesets: info.rulesets.map(function (r) {
            return {id: r.id, name: r.name, rules: r.rules, filters: r.filters, mode: r.mode,
                    wanted: rulesetWanted(r, settings), active: enabledNow.has(r.id)};
        }),
        discordHint: settings.discordHint,
        streaming: tab ? isStreamingSite(tab.url || '') : false,
        twitchAdSpoofing: settings.twitchAdSpoofing,
        twitch: /(^|\.)twitch\.tv$/.test(host),
        update: await updateState(settings),
    };
}

async function onPopupMessage(msg) {
    if (msg.type === 'state') return tabState(msg.tabId);
    if (msg.type === 'set-enabled') {
        await saveSettings({enabled: !!msg.enabled});
        return tabState(msg.tabId);
    }
    if (msg.type === 'set-whitelisted') {
        const settings = await getSettings();
        const site = siteOf(String(msg.host || '').toLowerCase());
        if (!/^[a-z0-9.-]+$/.test(site)) throw new Error('ungültige Seite');
        // drop the site and anything covering it, then add it again if wanted
        let list = settings.whitelist.filter(function (d) { return !isWhitelisted(site, [d]) && !isWhitelisted(d, [site]); });
        if (msg.whitelisted) list = list.concat([site]).sort();
        await saveSettings({whitelist: list});
        return tabState(msg.tabId);
    }
    if (msg.type === 'set-twitch-spoofing') {
        await saveSettings({twitchAdSpoofing: !!msg.enabled});
        const tabs = await chrome.tabs.query({url: '*://*.twitch.tv/*'});
        await Promise.all(tabs.map(function (tab) {
            return chrome.tabs.sendMessage(tab.id, {type: 'twitch-spoofing', enabled: !!msg.enabled}).catch(function () {});
        }));
        return tabState(msg.tabId);
    }
    if (msg.type === 'set-discord-hint') {
        await saveSettings({discordHint: !!msg.enabled});
        return tabState(msg.tabId);
    }
    if (msg.type === 'run-update') {
        runUpdate();  // the popup follows it with "state"
        return tabState(msg.tabId);
    }
    if (msg.type === 'set-auto-update') {
        await saveSettings({autoUpdate: !!msg.enabled});
        return tabState(msg.tabId);
    }
    if (msg.type === 'open-gpu-settings') {
        await openGpuSettings(msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(function () { return null; }) : null);
        return {};
    }
    if (msg.type === 'set-ruleset') {
        const settings = await getSettings();
        const rulesets = Object.assign({}, settings.rulesets);
        rulesets[msg.id] = !!msg.enabled;
        await saveSettings({rulesets: rulesets});
        return tabState(msg.tabId);
    }
    throw new Error('unbekannte Nachricht ' + msg.type);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
    const fail = function (e) { sendResponse({error: String(e && e.message || e)}); };
    if ((sender.url || '').startsWith(chrome.runtime.getURL(''))) {  // popup (also when opened as a tab)
        onPopupMessage(msg).then(sendResponse, fail);
    } else if (msg.type === 'cosmetic-init' || msg.type === 'cosmetic-classes') {  // content scripts
        onCosmeticMessage(msg, sender).then(sendResponse, fail);
    } else if (['discord-hint-check', 'discord-hint-off', 'open-gpu-settings'].includes(msg.type)) {
        onDiscordMessage(msg, sender).then(sendResponse, fail);
    } else {
        return false;
    }
    return true;
});
