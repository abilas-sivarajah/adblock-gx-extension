"""
Builds the browser extension in extension/ from the sources of the desktop browser
"AdBlock Browser GX" (github.com/abilas-sivarajah/adblock-browser-gx) - its scripts/*.js stay the
only source of the site scripts:

  generated/twitch.js, youtube.js, netflix.js   scripts/*.js via site_scripts.build_site_scripts()
  generated/rules_<list>.json                   filter lists (filter_engine.DEFAULT_FILTER_SOURCES)
                                                and site_fixes.txt as declarativeNetRequest rules
  generated/cosmetic.json                       element hiding rules of those lists
  generated/rulesets.json                       names/sizes of the rule sets (background.js, popup)
  icons/                                        assets/icon.png in 16/32/48/128 px (needs Pillow)

and keeps the rule sets in manifest.json in step. Downloaded lists are cached in
tools/.cache/filters/ (re-downloaded after 12 h); without internet the cache is used, then the
desktop browser's copies in browser_data/filters/.

The desktop browser is expected in the folder AdBlockBrowser next to this repository
(otherwise --browser PATH or the environment variable ADBLOCK_BROWSER_DIR).

usage: python tools/build_extension.py [--update] [--offline] [--browser PATH]
       --update   download the lists even if the cache is fresh
       --offline  never download
"""

import argparse
import ast
import importlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import Counter

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS_DIR)
sys.path.insert(0, TOOLS_DIR)

from abp2dnr import CosmeticCollector, convert_list, validate_rules  # noqa: E402

EXT_DIR = os.path.join(ROOT, "extension")
GEN_DIR = os.path.join(EXT_DIR, "generated")
ICON_DIR = os.path.join(EXT_DIR, "icons")
MANIFEST = os.path.join(EXT_DIR, "manifest.json")
CACHE_DIR = os.path.join(TOOLS_DIR, ".cache", "filters")
CACHE_MAX_AGE = 12 * 3600
BROWSER_REPO = "https://github.com/abilas-sivarajah/adblock-browser-gx"
DEFAULT_BROWSER_DIR = os.path.join(os.path.dirname(ROOT), "AdBlockBrowser")

# Chrome limits (developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest, 10/2026)
GUARANTEED_MINIMUM_STATIC_RULES = 30000
MAX_NUMBER_OF_REGEX_RULES = 1000
MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50

# Rule set per filter list. "on": enabled by default; "auto": enabled if it still fits the rule
# limit (manifest.json if within the guaranteed 30,000, otherwise background.js decides with
# getAvailableStaticRuleCount()), and switchable in the popup.
LIST_SETTINGS = {
    "easylist.txt": ("easylist", "on"),
    "easylistgermany.txt": ("easylist_germany", "on"),
    "peter_lowe.txt": ("peter_lowe", "on"),
    "easyprivacy.txt": ("easyprivacy", "auto"),
}


def find_browser_dir(path=None, required=True):
    """The desktop browser's checkout: --browser, ADBLOCK_BROWSER_DIR or AdBlockBrowser next to
    this repository."""
    given = path or os.environ.get("ADBLOCK_BROWSER_DIR")
    path = os.path.abspath(given or DEFAULT_BROWSER_DIR)
    if os.path.exists(os.path.join(path, "site_scripts.py")):
        return path
    # old place - only without an explicit path, a wrong one must not silently build from here
    if not given and os.path.exists(r"C:\AdBlockBrowser\site_scripts.py"):
        return r"C:\AdBlockBrowser"
    if not required:
        return None
    sys.exit(f"Desktop-Browser nicht gefunden: {path}\n"
             f"Neben diesem Ordner klonen:  git clone {BROWSER_REPO} AdBlockBrowser\n"
             "oder den Pfad angeben:       python tools/build_extension.py --browser PFAD")


def browser_commit(browser):
    """Commit of the desktop browser the scripts came from (for rulesets.json and the summary)."""
    try:
        def git(*args):
            return subprocess.run(["git", "-C", browser, *args], capture_output=True, text=True,
                                  timeout=10).stdout.strip()
        commit = git("rev-parse", "--short", "HEAD")
        changed = git("status", "--porcelain", "--", "scripts", "site_scripts.py", "site_fixes.txt", "filter_engine.py")
        return commit + (" (geändert)" if changed else "") if commit else None
    except (OSError, subprocess.SubprocessError):
        return None


def filter_sources(browser):
    """DEFAULT_FILTER_SOURCES from filter_engine.py - read, not imported: the module imports the
    desktop browser's adblock (Rust) engine, which the build does not need."""
    with open(os.path.join(browser, "filter_engine.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "DEFAULT_FILTER_SOURCES"
                                                for t in node.targets):
            return ast.literal_eval(node.value)
    sys.exit("DEFAULT_FILTER_SOURCES nicht in filter_engine.py gefunden")


def fmt(n):
    return f"{n:,}".replace(",", ".")


def read_text(path):
    with open(path, encoding="utf-8", errors="ignore") as f:
        return f.read()


def looks_like_filter_list(text):
    """False for an empty answer or an HTML page (error page of a proxy or hotspot login) - such a
    download must not replace a working cache."""
    head = text.lstrip()[:100]
    return bool(head) and not head.startswith("<")


def load_list(src, update, offline, browser):
    """(text, where it came from) - text is None if the list is nowhere to be found."""
    path = os.path.join(CACHE_DIR, src["filename"])
    fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_MAX_AGE
    if not offline and (update or not fresh):
        try:
            req = urllib.request.Request(src["url"], headers={"User-Agent": "Mozilla/5.0 AdBlockGX-Build/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", errors="ignore")
            if not looks_like_filter_list(text):
                raise ValueError("Antwort ist keine Filterliste")  # keeps the cache
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            return text, "geladen"
        except Exception as e:
            print(f"  ! {src['name']}: Download fehlgeschlagen ({e})")
    if os.path.exists(path):
        return read_text(path), "Cache vom " + time.strftime("%d.%m. %H:%M", time.localtime(os.path.getmtime(path)))
    desktop = os.path.join(browser, "browser_data", "filters", src["filename"])
    if os.path.exists(desktop):
        return read_text(desktop), "Kopie des Desktop-Browsers"
    return None, "fehlt"


def write_json(path, data, one_per_line=False):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        if one_per_line:  # rule files: one rule per line - readable, but not huge
            f.write("[\n" + ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":"))
                                       for r in data) + "\n]\n")
        else:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    with open(path, encoding="utf-8") as f:
        json.load(f)  # must be valid JSON


def build_site_scripts(browser):
    sys.path.insert(0, browser)
    site_scripts = importlib.import_module("site_scripts")  # desktop browser module: json/os only
    twitch, youtube, netflix = site_scripts.build_site_scripts(True, [])[:3]
    for name, code, source in (("twitch.js", twitch, "twitch_main.js + twitch_worker.js"),
                               ("youtube.js", youtube, "youtube.js"), ("netflix.js", netflix, "netflix.js")):
        with open(os.path.join(GEN_DIR, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(f"// Generated by tools/build_extension.py from scripts/{source} - do not edit.\n" + code)
    print("Seiten-Scripts: twitch.js, youtube.js, netflix.js")


def build_icons(browser):
    sizes = (16, 32, 48, 128)
    try:
        from PIL import Image, ImageEnhance
    except ImportError:
        missing = [s for s in sizes if not os.path.exists(os.path.join(ICON_DIR, f"icon{s}.png"))]
        print("Icons: Pillow fehlt - " + ("vorhandene Icons bleiben" if not missing else f"es fehlen {missing}!"))
        return
    os.makedirs(ICON_DIR, exist_ok=True)
    src = Image.open(os.path.join(browser, "assets", "icon.png")).convert("RGBA")
    for s in sizes:
        icon = src.resize((s, s), Image.LANCZOS)
        icon.save(os.path.join(ICON_DIR, f"icon{s}.png"), optimize=True)
        if s <= 32:  # toolbar icon while protection is off: grey and darker
            grey = ImageEnhance.Brightness(ImageEnhance.Color(icon).enhance(0.0)).enhance(0.6)
            grey.save(os.path.join(ICON_DIR, f"off{s}.png"), optimize=True)
    print("Icons: 16/32/48/128 px (+ grau für 'Schutz aus')")


def sync_manifest(rulesets):
    with open(MANIFEST, encoding="utf-8") as f:
        manifest = json.load(f)
    wanted = [{"id": r["id"], "enabled": r["manifestEnabled"], "path": r["path"]} for r in rulesets]
    dnr = manifest.setdefault("declarative_net_request", {})
    if dnr.get("rule_resources") == wanted:
        return False
    dnr["rule_resources"] = wanted
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return True


def main():
    ap = argparse.ArgumentParser(description="Baut die Browser-Erweiterung (extension/).")
    ap.add_argument("--update", action="store_true", help="Filterlisten neu laden, auch wenn der Cache frisch ist")
    ap.add_argument("--offline", action="store_true", help="nichts herunterladen")
    ap.add_argument("--browser", help="Ordner des Desktop-Browsers (Standard: AdBlockBrowser neben diesem Repo)")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # consoles that cannot show every character

    browser = find_browser_dir(args.browser)
    commit = browser_commit(browser)
    print(f"Desktop-Browser: {browser}" + (f" (Commit {commit})" if commit else ""))
    os.makedirs(GEN_DIR, exist_ok=True)
    build_site_scripts(browser)
    build_icons(browser)

    cosmetics = CosmeticCollector()
    lists = []
    site_fix_text = read_text(os.path.join(browser, "site_fixes.txt"))
    origin = "site_fixes.txt"
    user_rules = os.path.join(browser, "browser_data", "filters", "user_rules.txt")
    if os.path.exists(user_rules):
        site_fix_text += "\n" + read_text(user_rules)
        origin += " + user_rules.txt"
    lists.append(("site_fixes", "Seiten-Fixes", "always", site_fix_text, origin, "top"))

    sources = filter_sources(browser)
    ordered = sorted(sources, key=lambda s: LIST_SETTINGS.get(s["filename"], ("", "auto"))[1] != "on")
    missing = []
    print("Filterlisten:")
    for src in ordered:
        rid, mode = LIST_SETTINGS.get(src["filename"], (os.path.splitext(src["filename"])[0], "auto"))
        text, where = load_list(src, args.update, args.offline, browser)
        if text is None:
            print(f"  ! {src['name']}: nicht verfügbar - Regelsatz bleibt leer")
            missing.append(src["name"])
            text = ""
        lists.append((rid, src["name"], mode, text, where, "initiator"))

    rulesets, errors = [], []
    summary = []
    for rid, name, mode, text, where, scope in lists:
        res = convert_list(text, cosmetics, domain_scope=scope, site_fix=(rid == "site_fixes"))
        for e in validate_rules(res.rules):
            errors.append(f"{rid}: {e}")
        path = f"generated/rules_{rid}.json"
        write_json(os.path.join(EXT_DIR, path), res.rules, one_per_line=True)
        rulesets.append({"id": rid, "name": name, "path": path, "rules": len(res.rules),
                         "filters": res.filters, "regex": res.regex_rules, "mode": mode})
        summary.append((rid, name, where, res))

    # what is enabled from the start: "always"/"on", "auto" only within the guaranteed minimum
    base = sum(r["rules"] for r in rulesets if r["mode"] != "auto")
    budget = GUARANTEED_MINIMUM_STATIC_RULES - base
    for r in rulesets:
        if r["mode"] == "auto":
            r["manifestEnabled"] = r["rules"] <= budget
            if r["manifestEnabled"]:
                budget -= r["rules"]
        else:
            r["manifestEnabled"] = True
    write_json(os.path.join(GEN_DIR, "rulesets.json"),
               {"guaranteedRules": GUARANTEED_MINIMUM_STATIC_RULES, "browserCommit": commit, "rulesets": rulesets})
    cosmetic_data = cosmetics.to_json()
    write_json(os.path.join(GEN_DIR, "cosmetic.json"), cosmetic_data)
    manifest_changed = sync_manifest(rulesets)

    # ---- summary ----
    print()
    print(f"{'Regelsatz':<18}{'Quelle':<28}{'Netzwerk':>9}{'-> Regeln':>10}{'Domains*':>9}{'Regex':>6}  Standard")
    for (rid, name, where, res), r in zip(summary, rulesets):
        state = "immer an" if r["mode"] == "always" else "an" if r["manifestEnabled"] else "zuschaltbar"
        print(f"{rid:<18}{where[:27]:<28}{res.stats['Netzwerk']:>9}{len(res.rules):>10}{res.merged_hosts:>9}"
              f"{res.regex_rules:>6}  {state}")
    print("  * reine Domain-Regeln (||domain^), zusammengefasst in requestDomains-Regeln")

    total_stats = Counter()
    for _, _, _, res in summary:
        total_stats.update(res.stats)
    skipped = sorted(((k[len("übersprungen: "):], v) for k, v in total_stats.items()
                      if k.startswith("übersprungen: ")), key=lambda kv: -kv[1])
    print("\nÜbersprungene Netzwerk-Regeln nach Grund:")
    unknown = sum(v for k, v in skipped if k.startswith("unbekannte Option"))
    for k, v in skipped:
        if not k.startswith("unbekannte Option"):
            print(f"  {v:>6}  {k}")
    if unknown:
        detail = ", ".join(f"{k.split(': ', 1)[1]} {v}" for k, v in skipped if k.startswith("unbekannte Option"))
        print(f"  {unknown:>6}  unbekannte Option ({detail[:150]})")
    if total_stats["doppelt (Netzwerk)"]:
        print(f"  {total_stats['doppelt (Netzwerk)']:>6}  doppelt")

    print("\nKosmetische Regeln:")
    for key in ("seitenspezifisch", "Stil-Regeln (seitenspezifisch)", "generisch (Klasse/ID)",
                "generisch (sonstige)", "Ausnahmen #@#"):
        print(f"  {total_stats[key]:>6}  {key}")
    for key, v in sorted(total_stats.items()):
        if key.startswith("Kosmetik-Ausnahme"):
            print(f"  {v:>6}  {key}")
    print("  übersprungen:")
    for key in ("erweitert: #?#", "erweitert: #$#", "erweitert: #%#", "Scriptlet ##+js(...)", "HTML-Filter ##^",
                "erweitert: :has-text/:-abp-/...", "Stil-Regel ohne Domain/Ausnahme", "ungültiger Selektor",
                "ungültige Domain"):
        if total_stats[key]:
            print(f"  {total_stats[key]:>6}  {key}")
    print(f"  cosmetic.json: {len(cosmetic_data['specific'])} Seiten, {len(cosmetic_data['classes'])} Klassen, "
          f"{len(cosmetic_data['ids'])} IDs, {len(cosmetic_data['generic'])} sonstige, "
          f"{len(cosmetic_data['styles'])} Seiten mit Stil-Regeln, "
          f"{os.path.getsize(os.path.join(GEN_DIR, 'cosmetic.json')) // 1024} KB")

    # ---- limits ----
    warnings = [f"{name} nicht verfügbar (kein Download, kein Cache) - der Regelsatz ist leer." for name in missing]
    enabled = [r for r in rulesets if r["manifestEnabled"]]
    enabled_rules = sum(r["rules"] for r in enabled)
    all_rules = sum(r["rules"] for r in rulesets)
    regex = sum(r["regex"] for r in rulesets)
    print(f"\nLimits: Standard an {fmt(enabled_rules)} von {fmt(GUARANTEED_MINIMUM_STATIC_RULES)} garantierten "
          f"Regeln, alle Listen {fmt(all_rules)}; Regex {regex} von {MAX_NUMBER_OF_REGEX_RULES}; "
          f"{len(rulesets)} Regelsätze")
    if enabled_rules > GUARANTEED_MINIMUM_STATIC_RULES:
        warnings.append("Die Standard-Regelsätze überschreiten die garantierten 30.000 Regeln.")
    if regex > MAX_NUMBER_OF_REGEX_RULES:
        warnings.append(f"Zu viele Regex-Regeln ({regex} > {MAX_NUMBER_OF_REGEX_RULES}).")
    if len(rulesets) > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS:
        warnings.append("Zu viele Regelsätze.")
    for r in rulesets:
        if r["mode"] == "auto" and not r["manifestEnabled"]:
            print(f"  {r['name']} ({fmt(r['rules'])} Regeln) passt nicht mehr in die garantierten Regeln: "
                  "wird beim Start zugeschaltet, wenn Chrome noch Platz hat (Popup: zuschaltbar).")
    if manifest_changed:
        print("manifest.json: Regelsätze aktualisiert")
    for w in warnings:
        print("WARNUNG: " + w)
    if errors:
        print(f"\nFEHLER in {len(errors)} Regeln:")
        for e in errors[:30]:
            print("  " + e)
        sys.exit(1)
    print("\nFertig: extension/ in chrome://extensions bzw. opera://extensions als entpackte Erweiterung laden.")


if __name__ == "__main__":
    main()
