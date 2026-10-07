"""Test of the automatic updates in an invisible Opera GX (own test profile, like ext_smoke.py).

Checks: extension id as tools/update_extension.py computes it, hourly alarm, the native messaging
host answers (needs "python tools/update_extension.py --install"), popup "Updates", and that a new
generated/build_info.json makes the extension reload itself (and only once). build_info.json is
put back at the end.

usage: python dev_tests/ext_update.py [--browser PATH] [--live]
       --live  also run a real update over the host (git fetch, fast-forward, build if needed)
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))

import ext_smoke  # noqa: E402
from ext_smoke import EXT, OPERA_GX, Browser, check  # noqa: E402
from update_extension import extension_id  # noqa: E402

ext_smoke.PROFILE = os.path.join(HERE, "out", "ext_update_profile")
BUILD_INFO = os.path.join(EXT, "generated", "build_info.json")


def new_worker(br, old):
    """The worker after a reload of the extension."""
    try:
        old.close()
    except Exception:
        pass
    time.sleep(3)
    return br.worker()


def reload_to(br, sw, build_info_text):
    """Writes build_info.json, lets the worker look; returns the worker of the reloaded extension."""
    with open(BUILD_INFO, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_info_text)
    try:
        sw.eval("reloadIfNewBuild()")
    except Exception:
        pass  # the worker went away with the reload
    return new_worker(br, sw)


def developer_mode(br):
    """Without developer mode (as in a fresh profile) the browser disables an unpacked extension
    when it reloads ("unsupportedDeveloperExtension"); loading one by hand needs it on anyway."""
    page, page_id = br.open("chrome://extensions/")
    time.sleep(1)
    page.eval("new Promise(res => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, res))")
    page.close()
    br.close_page(page_id)


def popup_update(br, sw):
    ext_id = sw.eval("chrome.runtime.id")
    pop, pop_id = br.open(f"chrome-extension://{ext_id}/popup.html")
    time.sleep(2)
    p = pop.eval("({hidden: document.getElementById('updateCard').classList.contains('hidden'), "
                 "pill: document.getElementById('updatePill').textContent, "
                 "status: document.getElementById('updateStatus').textContent, "
                 "error: document.getElementById('error').textContent})")
    pop.close()
    br.close_page(pop_id)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default=OPERA_GX)
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()

    with open(BUILD_INFO, encoding="utf-8") as f:
        original = f.read()
    build = json.loads(original)["build"]

    br = Browser(args.browser, fresh=True)
    try:
        run(br, args, original, build)
    finally:
        with open(BUILD_INFO, "w", encoding="utf-8", newline="\n") as f:
            f.write(original)
        br.quit()
    print(f"\n{ext_smoke.passed} passed, {ext_smoke.failed} failed")
    sys.exit(1 if ext_smoke.failed else 0)


def run(br, args, original, build):
    sw = br.worker()
    sw.eval("saveSettings({autoUpdate: false})")  # no update of its own in the test profile
    developer_mode(br)
    time.sleep(2)
    try:
        ext_id = sw.eval("chrome.runtime.id")
        check("Erweiterungs-ID wie in update_extension.py berechnet", ext_id == extension_id(EXT),
              f"{ext_id} / {extension_id(EXT)}")
        alarm = sw.eval("chrome.alarms.get('update')")
        check("Stündlicher Alarm", bool(alarm) and alarm.get("periodInMinutes") == 60, alarm)
        loaded = sw.eval("chrome.storage.session.get('loadedBuild').then(s => s.loadedBuild)")
        check("Geladener Build gemerkt", loaded == build, f"{loaded} / {build}")
        pong = sw.eval("callUpdater({type: 'ping'})")
        check("Updater antwortet (Native Messaging)", pong == {"type": "pong"}, pong)
        p = popup_update(br, sw)
        check("Popup: Karte Updates", not p["hidden"] and not p["error"] and "Stand" in p["status"], p)

        if args.live:
            result = sw.eval("runUpdate()")
            check("Echtes Update über den Updater", result.get("ok") and "time" in result, result)
            sw = new_worker(br, sw) if result.get("changed") else sw
            p = popup_update(br, sw)
            check("Popup nach dem Update", p["pill"] in ("aktuell", "teilweise") and "Geprüft" in p["status"], p)

        # ---- a new build on disk: the extension reloads itself, once ----
        test_build = "test-" + str(int(time.time()))
        info = json.loads(original)
        info["build"] = test_build
        sw = reload_to(br, sw, json.dumps(info))
        state = sw.eval("Promise.all([chrome.storage.session.get('loadedBuild'), chrome.storage.local.get('reloadedFor'), "
                        "chrome.declarativeNetRequest.getEnabledRulesets()]).then(([s, l, r]) => "
                        "({loaded: s.loadedBuild, reloadedFor: l.reloadedFor, rulesets: r.length}))")
        check("Neuer Build -> Erweiterung lädt sich neu", state["loaded"] == test_build
              and state["reloadedFor"] == test_build and state["rulesets"] > 0, state)
        check("Kein zweites Neuladen für denselben Build", sw.eval("reloadIfNewBuild()") is False)
    finally:
        sw = reload_to(br, sw, original)  # back to the real build
    loaded = sw.eval("chrome.storage.session.get('loadedBuild').then(s => s.loadedBuild)")
    check("build_info.json zurück, Erweiterung wieder auf dem echten Build", loaded == build, loaded)
    sw.close()


if __name__ == "__main__":
    main()
