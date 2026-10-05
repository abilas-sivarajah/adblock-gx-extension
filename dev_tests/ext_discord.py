"""Discord stream mode of the browser extension, in a real (off-screen, muted) Opera GX window:

1. normal start (hardware acceleration on): the popup says so, Netflix shows the hint banner once
   per session, its button opens the settings page with "Grafikbeschleunigung verwenden", the
   banner can be switched off.
2. start with the parameters of start_opera_discord.bat: chrome://gpu reports software only,
   the popup shows "stream mode active", no banner.

Netflix is only opened at its start page (no login needed). Your normal profile is not touched.
usage: python dev_tests/ext_discord.py
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ext_smoke as e  # noqa: E402

BAT = os.path.join(e.ROOT, "start_opera_discord.bat")
DEEP_TEXT = r"""(() => { let t = ''; (function rec(n) { if (!n) return; if (n.shadowRoot) rec(n.shadowRoot);
    for (const c of (n.children || [])) rec(c); if (n.nodeType === 1 && !n.children.length) t += (n.textContent || '') + '\n'; })
    (document.documentElement); return t; })()"""


def bat_flags():
    """The GPU parameters exactly as start_opera_discord.bat passes them."""
    with open(BAT, encoding="ascii") as f:
        return re.search(r'set "FLAGS=([^"]+)"', f.read()).group(1).split()


def popup_state(br, sw, tab):
    ext = sw.eval("chrome.runtime.id")
    pop, pop_id = br.open(f"chrome-extension://{ext}/popup.html?tab={tab}")
    time.sleep(2)
    s = pop.eval("({pill: document.getElementById('gpuPill').textContent, open: document.getElementById('discordCard').open, "
                 "button: document.getElementById('gpuSettings').textContent, error: document.getElementById('error').textContent})")
    return pop, pop_id, s


def banner(page):
    return page.eval("!!document.getElementById('adblock-gx-discord-hint')")


def main():
    # ---- 1. hardware acceleration on ----
    br = e.Browser(e.OPERA_GX, fresh=True, headless=False)
    sw = br.worker()
    time.sleep(2)
    nf, nf_id = br.open("https://www.netflix.com/")
    time.sleep(6)
    e.check("Beschleunigung an: Hinweis-Banner auf Netflix", banner(nf))
    nf2, nf2_id = br.open("https://www.netflix.com/browse")
    time.sleep(6)
    e.check("Banner nur einmal pro Sitzung", not banner(nf2))
    pop, pop_id, s = popup_state(br, sw, e.tab_id(sw, "netflix.com"))
    e.check("Popup auf Netflix: 'Grafikkarte an', Bereich offen", s["pill"] == "Grafikkarte an" and s["open"]
            and s["button"] == "Hardware-Beschleunigung aus" and not s["error"], s)
    before = {t["id"] for t in br.http("/json/list")}
    pop.eval("document.getElementById('gpuSettings').click()")
    time.sleep(3)
    new = [t for t in br.http("/json/list") if t["id"] not in before and t["type"] == "page"]
    text = ""
    if new:
        page = e.Target(new[0]["webSocketDebuggerUrl"])
        text = page.eval(DEEP_TEXT)
        page.close()
    e.check("Knopf öffnet die Einstellung 'Grafikbeschleunigung verwenden'",
            bool(new) and "settings/system" in new[0]["url"] and "Grafikbeschleunigung verwenden" in text,
            new[0]["url"] if new else "kein neuer Tab")
    sw.eval("saveSettings({discordHint: false})")
    off = sw.eval("chrome.scripting.getRegisteredContentScripts().then(s => s.some(x => x.id === 'ab-discord'))")
    e.check("Banner abschaltbar (Script abgemeldet)", off is False)
    for t in (nf, nf2, pop, sw):
        t.close()
    br.quit()

    # ---- 2. started like start_opera_discord.bat ----
    flags = bat_flags()
    br = e.Browser(e.OPERA_GX, fresh=True, headless=False, extra_args=flags)
    sw = br.worker()
    time.sleep(2)
    gpu, gpu_id = br.open("chrome://gpu")
    time.sleep(3)
    text = gpu.eval(DEEP_TEXT)
    e.check("Discord-Parameter: chrome://gpu meldet Software für Video/Compositing",
            "Software only. Hardware acceleration disabled" in text, ", ".join(flags))
    gpu.close()
    nf, nf_id = br.open("https://www.netflix.com/")
    time.sleep(6)
    e.check("Stream-Modus: kein Banner", not banner(nf))
    pop, pop_id, s = popup_state(br, sw, e.tab_id(sw, "netflix.com"))
    e.check("Popup: 'Stream-Modus aktiv'", s["pill"] == "Stream-Modus aktiv"
            and s["button"] == "Hardware-Beschleunigung wieder einschalten", s)
    for t in (nf, pop, sw):
        t.close()
    br.quit()
    print(f"\n{e.passed} passed, {e.failed} failed")
    sys.exit(1 if e.failed else 0)


if __name__ == "__main__":
    main()
