// AdBlock GX popup: protection on/off and the exception for the current site.
// Settings live in background.js (chrome.storage.local); every change goes through it.
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

function setSwitch(el, on) {
    el.setAttribute('aria-pressed', String(on));
    el.querySelector('.switch').classList.toggle('off', !on);
}

function render() {
    const power = $('power');
    power.classList.toggle('off', !state.enabled);
    setSwitch(power, state.enabled);
    $('powerTitle').textContent = state.enabled ? 'Schutz an' : 'Schutz aus';
    $('powerSub').textContent = state.enabled ? 'Werbung und Tracker werden blockiert' : 'Nichts wird blockiert';

    $('site').textContent = state.site || 'keine Webseite';
    const exception = $('exception');
    exception.disabled = !state.site || !state.enabled;
    setSwitch(exception, state.whitelisted);
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
    }, showError);
});

$('exception').addEventListener('click', function () {
    send({type: 'set-whitelisted', host: state.host, whitelisted: !state.whitelisted}).then(function (s) {
        state = s;
        render();
        reloadTab();
    }, showError);
});

chrome.tabs.query({active: true, currentWindow: true}).then(function (tabs) {
    tab = tabs[0] || null;
    return send({type: 'state'});
}).then(function (s) {
    state = s;
    render();
}, showError);
