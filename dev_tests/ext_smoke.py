"""Smoke test of the browser extension (extension/) in an invisible Opera GX / Chrome.

Starts the browser headless with a fresh test profile (dev_tests/out/ext_profile), loads the
unpacked extension and checks it over the DevTools protocol: registered scripts, rule sets, regex
rules, YouTube/Twitch/Netflix scripts, blocking on a news site, element hiding, exception list,
"protection off" and a restart. Your normal browser profile is not touched.

usage: python dev_tests/ext_smoke.py [--browser PATH] [--keep]
       --browser  browser exe (default: Opera GX). Chrome stable ignores --load-extension.
       --keep     leave the browser running at the end (port 9444)
"""
import argparse
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

from websockets.sync.client import connect

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, "extension")
PROFILE = os.path.join(HERE, "out", "ext_profile")
PORT = 9444
OPERA_GX = os.path.expandvars(r"%LOCALAPPDATA%\Programs\Opera GX\opera.exe")
# test page for element hiding: a name of its own (EasyList switches generic rules off on
# 127.0.0.1/localhost), mapped to the local server in the test browser only
TEST_HOST = "adtest.example"
TEST_PAGE = b"""<!doctype html><meta charset="utf-8"><title>Werbe-Test</title>
<div id="google_ads">Werbung (id)</div>
<div class="advertisement leaderboard">Werbung (Klasse)</div>
<div id="div-gpt-ad-123">Werbung (generisch, [id^=])</div>
<div id="content">Inhalt</div>
<script>setTimeout(function () {
  var d = document.createElement('div'); d.id = 'late'; d.className = 'ad_box'; d.textContent = 'Werbung (nachgeladen)';
  document.body.appendChild(d);
}, 800);</script>
"""


class TestPage(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        # strict CSP: page styles are forbidden - the extension's user styles must still work
        self.send_header("Content-Security-Policy", "style-src 'none'; script-src 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(TEST_PAGE)

    def log_message(self, *args):
        pass


def start_test_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TestPage)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


class Target:
    """One DevTools target (page or service worker)."""

    def __init__(self, ws_url):
        self.ws = connect(ws_url, max_size=None, open_timeout=10)
        self.i = 0

    def call(self, method, **params):
        self.i += 1
        my = self.i
        self.ws.send(json.dumps({"id": my, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv(timeout=90))
            if msg.get("id") == my:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def eval(self, expression):
        r = self.call("Runtime.evaluate", expression=expression, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:600])
        return r["result"].get("value")

    def close(self):
        self.ws.close()


class Browser:
    def __init__(self, exe, fresh):
        if fresh and os.path.exists(PROFILE):
            shutil.rmtree(PROFILE)
        os.makedirs(PROFILE, exist_ok=True)
        self.proc = subprocess.Popen([
            exe, "--headless=new", f"--user-data-dir={PROFILE}", f"--load-extension={EXT}",
            f"--remote-debugging-port={PORT}", "--no-first-run", "--no-default-browser-check",
            "--mute-audio", "--autoplay-policy=no-user-gesture-required",
            f"--host-resolver-rules=MAP {TEST_HOST} 127.0.0.1", "about:blank"])
        for _ in range(60):
            try:
                self.version = self.http("/json/version")
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise SystemExit("Browser startet nicht")

    def http(self, path, method="GET"):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method)
        return json.load(urllib.request.urlopen(req, timeout=10))

    def worker(self):
        """The extension's service worker (started on demand)."""
        for _ in range(40):
            for t in self.http("/json/list"):
                if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://") \
                        and t["url"].endswith("/background.js"):
                    sw = Target(t["webSocketDebuggerUrl"])
                    try:
                        if sw.eval("chrome.runtime.getManifest().name") == "AdBlock GX":
                            return sw
                    except RuntimeError:
                        pass
                    sw.close()
            time.sleep(0.5)
        raise SystemExit("Service Worker der Erweiterung nicht gefunden")

    def open(self, url):
        t = self.http("/json/new?" + urllib.parse.quote(url, safe=":/?=&"), method="PUT")
        return Target(t["webSocketDebuggerUrl"]), t["id"]

    def close_page(self, target_id):
        try:
            self.http(f"/json/close/{target_id}")
        except Exception:
            pass

    def quit(self):
        try:
            b = Target(self.version["webSocketDebuggerUrl"])
            b.call("Browser.close")
        except Exception:
            pass
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def tab_id(sw, host):
    return sw.eval(f"chrome.tabs.query({{}}).then(ts => (ts.find(t => (t.url || '').includes({json.dumps(host)})) || {{}}).id)")


def block_rules():
    """(ruleset id, rule id) of every block rule - getMatchedRules also lists allow rules."""
    out = set()
    for name in os.listdir(os.path.join(EXT, "generated")):
        if name.startswith("rules_"):
            with open(os.path.join(EXT, "generated", name), encoding="utf-8") as f:
                out.update((name[len("rules_"):-len(".json")], r["id"]) for r in json.load(f)
                           if r["action"]["type"] == "block")
    return out


BLOCK_RULES = None


def blocked_since(sw, tid, since_ms):
    global BLOCK_RULES
    BLOCK_RULES = BLOCK_RULES or block_rules()
    matched = sw.eval(f"chrome.declarativeNetRequest.getMatchedRules({{tabId: {tid}, minTimeStamp: {since_ms}}})"
                      ".then(r => r.rulesMatchedInfo.map(m => [m.rule.rulesetId, m.rule.ruleId]))")
    return sum(1 for rs, rid in matched if (rs, rid) in BLOCK_RULES)


def regex_rules():
    out = []
    for name in os.listdir(os.path.join(EXT, "generated")):
        if name.startswith("rules_"):
            with open(os.path.join(EXT, "generated", name), encoding="utf-8") as f:
                for r in json.load(f):
                    if "regexFilter" in r["condition"]:
                        out.append((name, r["id"], r["condition"]["regexFilter"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default=OPERA_GX)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    br = Browser(args.browser, fresh=True)
    print("Browser:", br.version.get("Browser"), br.version.get("User-Agent", "").split(") ")[-1])
    sw = br.worker()
    time.sleep(2)  # onInstalled -> sync

    # ---- registration and rule sets ----
    scripts = sw.eval("chrome.scripting.getRegisteredContentScripts().then(s => s.map(x => x.id + ':' + x.world))")
    check("Scripts registriert", set(scripts) == {"ab-twitch:MAIN", "ab-youtube:MAIN", "ab-netflix:MAIN",
                                                    "ab-cosmetic:ISOLATED"}, scripts)
    enabled = sw.eval("chrome.declarativeNetRequest.getEnabledRulesets()")
    meta = json.load(open(os.path.join(EXT, "generated", "rulesets.json"), encoding="utf-8"))
    check("Regelsätze aktiv", set(enabled) == {r["id"] for r in meta["rulesets"]}, enabled)
    regex = regex_rules()
    results = sw.eval("Promise.all(%s.map(r => chrome.declarativeNetRequest.isRegexSupported({regex: r})))"
                      % json.dumps([r[2] for r in regex]))
    bad = [f"{n}#{i}: {res.get('reason')} {rx[:60]}" for (n, i, rx), res in zip(regex, results) if not res["isSupported"]]
    check(f"Regex-Regeln von Chrome akzeptiert ({len(regex) - len(bad)}/{len(regex)})", not bad, "; ".join(bad)[:800])

    # ---- site scripts ----
    yt, yt_id = br.open("https://www.youtube.com/")
    time.sleep(8)
    check("YouTube: Script läuft (window.__abYouTube)", yt.eval("JSON.stringify(window.__abYouTube || null)") != "null",
          yt.eval("JSON.stringify(window.__abYouTube || null)"))
    yt_tab = tab_id(sw, "youtube.com")
    ext_id = sw.eval("chrome.runtime.id")
    pop, pop_id = br.open(f"chrome-extension://{ext_id}/popup.html?tab={yt_tab}")
    time.sleep(2)
    p = pop.eval("({site: document.getElementById('site').textContent, error: document.getElementById('error').textContent, "
                 "status: document.getElementById('siteStatus').innerText, lists: document.querySelectorAll('#lists .row').length})")
    check("Popup: Seite, YouTube-Status, Filterlisten", p["site"] == "youtube.com" and not p["error"]
          and "werbedaten entfernt" in p["status"].lower() and p["lists"] == len(meta["rulesets"]), p)
    pop.close()
    br.close_page(pop_id)
    nf, nf_id = br.open("https://www.netflix.com/")
    time.sleep(5)
    check("Netflix: Script läuft (window.__abNetflix)", nf.eval("!!window.__abNetflix"))
    br.close_page(nf_id)
    tw, tw_id = br.open("https://www.twitch.tv/")
    stats = None
    for _ in range(25):
        time.sleep(1)
        stats = tw.eval("window.__abTwitch ? {workers: __abTwitch.workers, hooked: __abTwitch.hookedWorkers, "
                        "masters: __abTwitch.masters, playlists: __abTwitch.playlists, errors: __abTwitch.errors} : null")
        if stats and stats["hooked"] and stats["playlists"]:
            break
    check("Twitch: Video-Worker eingehängt (hookedWorkers, playlists)", bool(stats and stats["hooked"] and stats["playlists"]), stats)
    br.close_page(tw_id)

    # ---- network blocking ----
    news, news_id = br.open("https://www.spiegel.de/")
    time.sleep(8)
    tid = tab_id(sw, "spiegel.de")
    n_blocked = blocked_since(sw, tid, 0)
    badge = sw.eval(f"chrome.action.getBadgeText({{tabId: {tid}}})")
    check("spiegel.de: Anfragen blockiert", n_blocked > 0, f"{n_blocked} Treffer, Badge {badge!r}")

    # ---- element hiding ----
    port = start_test_server()
    test_url = f"http://{TEST_HOST}:{port}/"
    ads, ads_id = br.open(test_url)
    time.sleep(3)
    shown = ("Object.fromEntries(['google_ads', 'div-gpt-ad-123', 'late', 'content'].map(id => "
             "[id, getComputedStyle(document.getElementById(id)).display]).concat([['klasse', "
             "getComputedStyle(document.querySelector('.advertisement.leaderboard')).display]]))")
    d = ads.eval(shown)
    check("Kosmetik: Werbe-ID, -Klasse, [id^=], nachgeladenes Element ausgeblendet (trotz CSP)",
          d == {"google_ads": "none", "div-gpt-ad-123": "none", "late": "none", "content": "block", "klasse": "none"}, d)
    ctx = sw.eval("getCosmetics().then(data => { const c = cosmeticContext(data, 'www.spiegel.de'); "
                  "const g = cosmeticContext(data, 'www.google.de'); return {spiegel: c.specific.length, "
                  "googleGenerichide: g.generichide, local: cosmeticContext(data, '127.0.0.1').generichide}; })")
    check("Kosmetik: seitenspezifische Regeln, $generichide (auch google.*)",
          ctx["spiegel"] > 0 and ctx["googleGenerichide"] and ctx["local"], ctx)
    sw.eval(f"saveSettings({{whitelist: [{json.dumps(TEST_HOST)}]}})")
    ads.call("Page.reload")
    time.sleep(3)
    d = ads.eval(shown)
    check("Kosmetik: Ausnahme -> nichts ausgeblendet", "none" not in d.values(), d)
    sw.eval("saveSettings({whitelist: []})")
    ads.close()
    br.close_page(ads_id)

    # ---- South Park: DAI stream blocked (site_fixes #1), player starts with the original stream ----
    sp, sp_id = br.open("https://www.southpark.de/folgen/mphf21/south-park-butters-ober-bitch-staffel-13-ep-9")
    played = 0
    for _ in range(30):
        time.sleep(1)
        played = sp.eval("Math.max(0, ...[...document.querySelectorAll('video')].map(v => v.currentTime))")
        if played > 5:
            break
    sp_tab = tab_id(sw, "southpark.de")
    sp_rules = sw.eval(f"chrome.declarativeNetRequest.getMatchedRules({{tabId: {sp_tab}}})"
                       ".then(r => r.rulesMatchedInfo.map(m => m.rule.rulesetId + '#' + m.rule.ruleId))")
    check("South Park: DAI-Werbestream geblockt, Folge läuft", "site_fixes#1" in sp_rules and played > 5,
          f"Video bei {played:.1f} s, site_fixes: {sorted(set(r for r in sp_rules if r.startswith('site_fixes')))}")
    sp.close()
    br.close_page(sp_id)

    # ---- exception list ----
    sw.eval("saveSettings({whitelist: ['spiegel.de', 'youtube.com']})")
    since = int(time.time() * 1000)
    news.call("Page.reload")
    yt.call("Page.reload")
    time.sleep(8)
    check("Ausnahme spiegel.de: nichts blockiert", blocked_since(sw, tid, since) == 0, blocked_since(sw, tid, since))
    check("Ausnahme youtube.com: Script läuft nicht", yt.eval("!!window.__abYouTube") is False)
    sw.eval("saveSettings({whitelist: []})")

    # ---- protection off ----
    sw.eval("saveSettings({enabled: false})")
    off = sw.eval("Promise.all([chrome.scripting.getRegisteredContentScripts(), chrome.declarativeNetRequest.getEnabledRulesets()])"
                  ".then(([s, r]) => ({scripts: s.length, rulesets: r.length}))")
    check("Schutz aus: keine Scripts, keine Regelsätze", off == {"scripts": 0, "rulesets": 0}, off)
    sw.eval("saveSettings({enabled: true, whitelist: ['example.com']})")

    # ---- what chrome://extensions shows (warnings of the rule sets, errors) ----
    ext_id = sw.eval("chrome.runtime.id")
    page, page_id = br.open(f"chrome://extensions/?id={ext_id}")
    time.sleep(2)
    info = page.eval("new Promise(res => chrome.developerPrivate.getExtensionInfo(%s, i => res({"
                     "install: i.installWarnings, manifest: (i.manifestErrors || []).map(x => x.message), "
                     "runtime: (i.runtimeErrors || []).map(x => x.message), warnings: i.runtimeWarnings})))" % json.dumps(ext_id))
    check("chrome://extensions: keine Warnungen/Fehler", not any(info.values()), info)
    page.close()
    br.close_page(page_id)
    for t in (news, yt, sw):
        t.close()
    br.quit()

    # ---- restart: settings and registrations survive ----
    br = Browser(args.browser, fresh=False)
    sw = br.worker()
    time.sleep(2)
    state = sw.eval("Promise.all([getSettings(), chrome.scripting.getRegisteredContentScripts(), "
                    "chrome.declarativeNetRequest.getEnabledRulesets()]).then(([s, c, r]) => "
                    "({enabled: s.enabled, whitelist: s.whitelist, scripts: c.length, exclude: (c[0] || {}).excludeMatches, rulesets: r.length}))")
    check("Neustart: Einstellungen und Registrierungen bleiben",
          state["enabled"] and state["whitelist"] == ["example.com"] and state["scripts"] >= 3
          and state["exclude"] == ["*://*.example.com/*"] and state["rulesets"] == len(meta["rulesets"]), state)
    sw.eval("saveSettings({whitelist: []})")
    sw.close()
    if not args.keep:
        br.quit()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
