// Isolated-world bridge: the Twitch player script runs in MAIN and cannot hear chrome.runtime.
// Popup toggles ad spoofing without reloading the tab; we forward that to the page.
chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'twitch-spoofing') return;
    try {
        window.postMessage({source: 'adblock-gx', type: 'twitch-spoofing', enabled: !!msg.enabled}, '*');
    } catch (e) {}
});
