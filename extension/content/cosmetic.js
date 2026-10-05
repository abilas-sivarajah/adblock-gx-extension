// Element hiding - runs at document start in every frame (isolated world, so the page cannot see
// it). Like COSMETIC_BRIDGE_SCRIPT of the desktop browser (cosmetic_filter.py): first asks for the
// page's own rules ("cosmetic-init"), then reports the classes and ids that show up, bundled.
// background.js answers by inserting the matching hide rules of the filter lists as user styles.
(function () {
    'use strict';
    if (window.__abCosmetic) return;
    window.__abCosmetic = true;

    const seenClasses = new Set();
    const seenIds = new Set();
    let pendingClasses = [];
    let pendingIds = [];
    let timer = 0;
    let observer = null;
    let active = true;

    function stop() {
        active = false;
        if (observer) observer.disconnect();
        observer = null;
        clearTimeout(timer);
    }

    function send(msg) {
        try {
            chrome.runtime.sendMessage(msg).then(function (reply) {
                if (reply && reply.active === false) stop();  // off, exception list, $generichide
            }, stop);
        } catch (e) {
            stop();  // extension reloaded or removed
        }
    }

    function flush() {
        timer = 0;
        if (!active || (!pendingClasses.length && !pendingIds.length)) return;
        send({type: 'cosmetic-classes', classes: pendingClasses, ids: pendingIds});
        pendingClasses = [];
        pendingIds = [];
    }

    function schedule() {
        if (!timer && active && (pendingClasses.length || pendingIds.length)) timer = setTimeout(flush, 50);
    }

    function note(el) {
        const id = el.id;
        if (id && typeof id === 'string' && !seenIds.has(id)) {
            seenIds.add(id);
            pendingIds.push(id);
        }
        const cl = el.classList;
        if (!cl) return;
        for (let i = 0; i < cl.length; i++) {
            const c = cl[i];
            if (!seenClasses.has(c)) {
                seenClasses.add(c);
                pendingClasses.push(c);
            }
        }
    }

    function scan(root) {
        note(root);
        const els = root.querySelectorAll('[id],[class]');
        for (let i = 0; i < els.length; i++) note(els[i]);
    }

    send({type: 'cosmetic-init'});
    if (document.documentElement) scan(document.documentElement);
    schedule();

    observer = new MutationObserver(function (mutations) {
        for (const m of mutations) {
            if (m.type === 'attributes') {
                note(m.target);
            } else {
                for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
            }
        }
        schedule();
    });
    observer.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id']});
})();
