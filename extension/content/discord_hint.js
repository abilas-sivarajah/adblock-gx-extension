// Discord stream mode hint - top frame of Netflix, Prime Video and Disney+ (isolated world).
// With hardware acceleration, DRM video is shown through a protected hardware overlay and
// Discord's screen share only captures black. An extension cannot switch the GPU off or restart
// the browser with parameters, so this small banner points to the setting - once per browser
// session, only while acceleration is on, and it can be switched off (here or in the popup).
(function () {
    'use strict';
    if (window.top !== window || window.__abDiscordHint) return;
    window.__abDiscordHint = true;
    if (!abGpuInfo().accelerated) return;  // stream mode already active: the video shows up in Discord

    function send(msg) {
        try {
            return chrome.runtime.sendMessage(msg);
        } catch (e) {
            return Promise.reject(e);  // extension reloaded
        }
    }

    function el(parent, tag, text, style) {
        const e = document.createElement(tag);
        if (text) e.textContent = text;
        if (style) e.setAttribute('style', style);
        parent.appendChild(e);
        return e;
    }

    function show() {
        const host = document.createElement('div');
        host.id = 'adblock-gx-discord-hint';
        host.setAttribute('style', 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647');
        const root = host.attachShadow({mode: 'closed'});
        const box = el(root, 'div', null,
            'box-sizing:border-box;width:330px;padding:14px 16px;border-radius:12px;background:#13111b;color:#f2eff8;' +
            'border:1px solid #fa1e4e;box-shadow:0 0 18px rgba(250,30,78,.35),0 8px 24px rgba(0,0,0,.5);' +
            'font:13px/1.45 "Segoe UI",sans-serif;text-align:left');
        const close = el(box, 'button', '×',
            'float:right;margin:-6px -6px 0 8px;background:none;border:0;color:#a7a0b8;font:20px/1 sans-serif;cursor:pointer');
        el(box, 'div', 'Discord-Stream-Modus',
            'font:600 14px/1.3 Bahnschrift,"Segoe UI",sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#fa1e4e');
        el(box, 'div', 'Bild bleibt für Freunde im Discord-Stream schwarz? Dann die Hardware-Beschleunigung ausschalten:',
            'margin:6px 0 4px');
        el(box, 'div', 'Schalter „Grafikbeschleunigung verwenden“ aus → „Neu starten“. ' +
            'Nach dem Streamen wieder einschalten.', 'color:#a7a0b8;font-size:12px');
        const row = el(box, 'div', null, 'display:flex;align-items:center;gap:12px;margin-top:10px');
        const open = el(row, 'button', 'Einstellung öffnen',
            'padding:7px 12px;border-radius:8px;border:0;background:#fa1e4e;color:#fff;' +
            'font:600 12px/1 Bahnschrift,"Segoe UI",sans-serif;letter-spacing:.04em;cursor:pointer');
        const never = el(row, 'button', 'Nicht mehr anzeigen',
            'background:none;border:0;padding:0;color:#a7a0b8;font:12px "Segoe UI",sans-serif;text-decoration:underline;cursor:pointer');

        close.addEventListener('click', function () { host.remove(); });
        open.addEventListener('click', function () {
            send({type: 'open-gpu-settings'}).catch(function () {});
            host.remove();
        });
        never.addEventListener('click', function () {
            send({type: 'discord-hint-off'}).catch(function () {});
            host.remove();
        });
        document.documentElement.appendChild(host);
    }

    send({type: 'discord-hint-check'}).then(function (r) {
        if (r && r.show) setTimeout(show, 1500);
    }, function () {});
})();
