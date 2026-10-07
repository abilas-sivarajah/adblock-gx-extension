// AdBlock GX popup: protection on/off, exception for the current site, blocked count, status of
// the YouTube/Twitch/Netflix scripts, Discord stream mode, filter lists. Settings live in background.js
// (chrome.storage.local); every change goes through it.
'use strict';

const $ = function (id) { return document.getElementById(id); };
let tab = null;
let state = null;

function send(msg) {
    msg.tabId = tab ? tab.id : null;
    return chrome.runtime.sendMessage(msg).then(function (r) {
        if (r && r.error) throw new Error(r.error);
        return r;
    });
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function setSwitch(button, on) {
    button.setAttribute('aria-pressed', String(on));
    button.querySelector('.switch').classList.toggle('off', !on);
}

function number(n) {
    return Number(n).toLocaleString('de-DE');
}

function render() {
    const power = $('power');
    power.classList.toggle('off', !state.enabled);
    setSwitch(power, state.enabled);
    $('powerTitle').textContent = state.enabled ? 'Schutz an' : 'Schutz aus';
    $('powerSub').textContent = state.enabled ? 'Werbung und Tracker werden blockiert' : 'Nichts wird blockiert';

    $('site').textContent = state.site || 'keine Webseite';
    $('blocked').textContent = state.enabled && !state.whitelisted ? state.blocked : '–';
    const exception = $('exception');
    exception.disabled = !state.site || !state.enabled;
    setSwitch(exception, state.whitelisted);

    renderLists();
    renderDiscord();
}

// ---- Discord stream mode: hardware acceleration has to be switched off in the browser ----
const gpu = abGpuInfo();

function renderDiscord() {
    const card = $('discordCard');
    const pill = $('gpuPill');
    pill.textContent = gpu.accelerated ? 'Grafikkarte an' : 'Stream-Modus an';
    pill.className = 'pill ' + (gpu.accelerated ? 'hot' : 'ok');
    $('gpuText').textContent = gpu.accelerated
        ? 'Netflix & Co. bleiben im Discord-Stream schwarz.'
        : 'Hardware-Beschleunigung ist aus: Netflix & Co. sind im Discord-Stream sichtbar.';
    const button = $('gpuSettings');
    button.textContent = gpu.accelerated ? 'Hardware-Beschleunigung aus' : 'Beschleunigung wieder einschalten';
    button.classList.toggle('calm', !gpu.accelerated);
    const steps = gpu.accelerated
        ? ['„Grafikbeschleunigung verwenden“ aus, dann „Neu starten“',
           'Danach wieder einschalten (sonst ohne Grafikkarte)']
        : ['„Grafikbeschleunigung verwenden“ an, dann „Neu starten“'];
    const list = $('gpuSteps');
    list.textContent = '';
    steps.forEach(function (s) { list.appendChild(el('li', null, s)); });
    setSwitch($('discordHint'), state.discordHint);
    $('batNote').classList.toggle('hidden', !gpu.accelerated);
    // on Netflix & Co. the section is open and highlighted
    if (state.streaming && !card.dataset.opened) {
        card.open = true;
        card.dataset.opened = '1';
    }
    card.classList.toggle('highlight', state.streaming && gpu.accelerated);
}

$('gpuSettings').addEventListener('click', function () {
    send({type: 'open-gpu-settings'}).then(function () { window.close(); }).catch(showError);
});

$('discordHint').addEventListener('click', function () {
    send({type: 'set-discord-hint', enabled: !state.discordHint}).then(function (s) {
        state = s;
        render();
    }).catch(showError);
});

function renderLists() {
    const box = $('lists');
    box.textContent = '';
    const active = state.rulesets.filter(function (r) { return state.enabled && r.active; }).length;
    $('listsPill').textContent = active + ' von ' + state.rulesets.length + ' aktiv';
    state.rulesets.forEach(function (r) {
        const always = r.mode === 'always';
        const row = el('button', 'row');
        row.type = 'button';
        row.disabled = always || !state.enabled;
        const label = el('span', 'label');
        label.appendChild(el('b', null, r.name));
        // plain domain filters share one rule (requestDomains), so both numbers are shown
        let info = (r.filters ? number(r.filters) + ' Filter · ' : '') + number(r.rules) + (r.rules === 1 ? ' Regel' : ' Regeln');
        if (always) info += ' · immer an';
        else if (r.wanted && !r.active && state.enabled) info += ' · passt nicht mehr ins Regel-Limit von Chrome';
        label.appendChild(el('small', r.wanted && !r.active && state.enabled ? 'warn' : null, info));
        row.appendChild(label);
        row.appendChild(el('span', 'switch'));
        setSwitch(row, state.enabled && (always || r.active));
        if (!always) {
            row.addEventListener('click', function () {
                send({type: 'set-ruleset', id: r.id, enabled: !r.wanted}).then(function (s) {
                    state = s;
                    render();
                }).catch(showError);
            });
        }
        box.appendChild(row);
    });
}

// ---- status of the site scripts (window.__abYouTube etc. in the page) ----
function times(n, what) {
    return what + ' ' + number(n) + '×';
}

function describeSite(s) {
    const lines = [];
    if (s.yt) {
        lines.push(['YouTube', s.yt.pruned ? times(s.yt.pruned, 'Werbedaten entfernt') : 'aktiv, noch keine Werbung']);
        if (s.yt.skipped) lines.push(['YouTube', times(s.yt.skipped, 'durchgerutschte Werbung übersprungen')]);
        if (s.yt.dialogs) lines.push(['YouTube', times(s.yt.dialogs, 'Adblock-Hinweis entfernt')]);
    }
    if (s.tw) {
        if (s.tw.overlayActive) lines.push(['Twitch', 'Werbepause läuft – ausgeblendet']);
        if (s.tw.bridgeActive) lines.push(['Twitch', 'Werbung übersprungen – gerade 360p-Ersatz']);
        lines.push(['Twitch', s.tw.hookedWorkers ? 'Player eingehängt' + (s.tw.adBreaks ? ', ' + times(s.tw.adBreaks, 'Werbung erkannt') : '')
                                                 : 'aktiv, Player noch nicht gestartet']);
        if (s.tw.replaced) lines.push(['Twitch', times(s.tw.replaced, 'werbefreien Stream eingesetzt') +
                                       (s.tw.lastBackupType ? ' (' + s.tw.lastBackupType + ')' : '')]);
        if (s.tw.nativeReturns) lines.push(['Twitch', times(s.tw.nativeReturns, 'zurück zum eigenen Stream')]);
        if (s.tw.holds) lines.push(['Twitch', times(s.tw.holds, 'Werbepause durch schwarzes Bild ersetzt')]);
        if (s.tw.masked) lines.push(['Twitch', times(s.tw.masked, 'Werbepause abgedeckt')]);
        if (s.tw.spoofedAds) lines.push(['Twitch', times(s.tw.spoofedAds, 'Werbung als gesehen gemeldet (Spoofing)')]);
        if (s.tw.adSeconds) lines.push(['Twitch', number(s.tw.adSeconds) + ' s Werbung nicht gezeigt']);
        if (s.tw.vodAdsBlocked) lines.push(['Twitch', times(s.tw.vodAdsBlocked, 'VOD-Werbung blockiert')]);
    }
    if (s.nf) {
        lines.push(['Netflix', s.nf.breaksRemoved ? number(s.nf.breaksRemoved) + ' Werbepause(n) entfernt'
                                                  : 'aktiv, noch keine Werbepause']);
        if (s.nf.pauseAdsRemoved) lines.push(['Netflix', times(s.nf.pauseAdsRemoved, 'Pausen-Werbung entfernt')]);
        if (s.nf.adsShown) lines.push(['Netflix', times(s.nf.adsShown, 'Werbung abgedeckt')]);
        if (s.nf.pruning === false) lines.push(['Netflix', 'Absicherung: dieser Titel läuft ohne Entfernen']);
    }
    return lines;
}

function loadSiteStatus() {
    const known = /(^|\.)(youtube\.com|twitch\.tv|netflix\.com)$/.test(state.host);
    if (!known || !state.enabled || state.whitelisted) return;
    chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'MAIN',
        func: function () {
            const pick = function (o, keys) {
                if (!o) return null;
                const out = {};
                keys.forEach(function (k) { out[k] = o[k]; });
                return out;
            };
            return {
                yt: pick(window.__abYouTube, ['pruned', 'skipped', 'dialogs']),
                tw: pick(window.__abTwitch, ['hookedWorkers', 'adBreaks', 'replaced', 'masked', 'holds', 'nativeReturns', 'adSeconds',
                                             'vodAdsBlocked', 'overlayActive', 'bridgeActive', 'lastBackupType', 'spoofedAds']),
                nf: pick(window.__abNetflix, ['breaksRemoved', 'pauseAdsRemoved', 'adsShown', 'pruning']),
            };
        },
    }).then(function (results) {
        const s = results && results[0] && results[0].result;
        let lines = s ? describeSite(s) : [];
        if (!lines.length) lines = [['Hinweis', 'Script noch nicht aktiv – Seite neu laden']];
        const list = $('siteStatus');
        list.textContent = '';
        lines.forEach(function (l) {
            const li = el('li');
            li.appendChild(el('span', 'tag', l[0]));
            li.appendChild(document.createTextNode(l[1]));
            list.appendChild(li);
        });
        list.classList.remove('hidden');
    }, function () {});
}

function showError(e) {
    $('error').textContent = 'Fehler: ' + (e && e.message || e);
    $('error').classList.remove('hidden');
}

function reloadTab() {
    if (!tab || !state.site) return;
    $('reloadNote').classList.remove('hidden');
    chrome.tabs.reload(tab.id);
    setTimeout(function () { window.close(); }, 700);
}

$('power').addEventListener('click', function () {
    send({type: 'set-enabled', enabled: !state.enabled}).then(function (s) {
        state = s;
        render();
        reloadTab();
    }).catch(showError);
});

$('exception').addEventListener('click', function () {
    send({type: 'set-whitelisted', host: state.host, whitelisted: !state.whitelisted}).then(function (s) {
        state = s;
        render();
        reloadTab();
    }).catch(showError);
});

// popup.html?tab=<id> shows another tab (dev_tests open the popup as a page)
const forcedTab = parseInt(new URLSearchParams(location.search).get('tab'), 10);
(forcedTab ? chrome.tabs.get(forcedTab).then(function (t) { return [t]; })
           : chrome.tabs.query({active: true, currentWindow: true})).then(function (tabs) {
    tab = tabs[0] || null;
    return send({type: 'state'});
}).then(function (s) {
    state = s;
    render();
    loadSiteStatus();
}).catch(showError);
