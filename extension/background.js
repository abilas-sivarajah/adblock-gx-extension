// AdBlock GX - service worker.
// - Site scripts (Twitch, YouTube, Netflix; generated from the desktop browser's scripts/*.js by
//   tools/build_extension.py) are registered in the page's MAIN world. "Protection off"
//   unregisters them, the exception list becomes their excludeMatches - the scripts themselves
//   always run with {enabled: true, whitelist: []}.
// - Network blocking: the static declarativeNetRequest rule sets (generated/rules_*.json), enabled
//   as far as Chrome's rule limit allows; the exception list is one dynamic allowAllRequests rule.
'use strict';

const DEFAULT_SETTINGS = {
    enabled: true,
    whitelist: [],      // domains without "www.", subdomains included
    rulesets: {},       // rule set id -> on/off as chosen in the popup (otherwise its default)
};
// above every static rule (tools/abp2dnr.py: 1 block ... 4 site_fixes exceptions)
const WHITELIST_PRIORITY = 100;

const SITE_SCRIPTS = [
    {id: 'ab-twitch', matches: ['*://*.twitch.tv/*'], js: ['generated/twitch.js']},
    {id: 'ab-youtube', matches: ['*://*.youtube.com/*'], js: ['generated/youtube.js']},
    {id: 'ab-netflix', matches: ['*://*.netflix.com/*'], js: ['generated/netflix.js']},
];

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
    if (!settings.enabled) return [];
    const exclude = settings.whitelist.map(excludePattern);
    return SITE_SCRIPTS.map(function (s) {
        const script = {id: s.id, matches: s.matches, js: s.js, world: 'MAIN', runAt: 'document_start', allFrames: true};
        if (exclude.length) script.excludeMatches = exclude;
        return script;
    });
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
chrome.runtime.onStartup.addListener(function () { sync(); });

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
            return {id: r.id, name: r.name, rules: r.rules, mode: r.mode,
                    wanted: rulesetWanted(r, settings), active: enabledNow.has(r.id)};
        }),
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
    if (!msg || typeof msg.type !== 'string') return false;
    if (sender.id !== chrome.runtime.id || sender.tab) return false;  // popup only
    onPopupMessage(msg).then(sendResponse, function (e) { sendResponse({error: String(e && e.message || e)}); });
    return true;
});
