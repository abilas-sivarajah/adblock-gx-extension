"""Offline tests for tools/abp2dnr.py: filter lines in -> expected declarativeNetRequest rules and
cosmetic data out.   usage: python dev_tests/dnr_unit.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
from abp2dnr import CosmeticCollector, convert_list, regex_cost, validate_rules  # noqa: E402
from build_extension import find_browser_dir  # noqa: E402

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def convert(text, **kw):
    cos = CosmeticCollector()
    res = convert_list(text, cos, **kw)
    return res, cos.to_json()


def only(text, **kw):
    """The single rule a filter line becomes (without id)."""
    res, _ = convert(text, **kw)
    if len(res.rules) != 1:
        return {"rules": len(res.rules), "stats": dict(res.stats)}
    rule = dict(res.rules[0])
    del rule["id"]
    return rule


def skipped(line):
    res, _ = convert(line)
    return [k[len("übersprungen: "):] for k in res.stats if k.startswith("übersprungen: ")]


# ---- plain domain filters are merged into requestDomains ----
res, _ = convert("||ads.example.com^\n||tracker.example^\n||cdn.example^$third-party\n||x.example^$third-party\n"
                 "||ads.example.com^")
rd = [r["condition"].get("requestDomains") for r in res.rules]
check("plain domains merged into one rule", ["ads.example.com", "tracker.example"] in rd, rd)
check("same options -> same rule, other options -> own rule",
      any(r["condition"].get("domainType") == "thirdParty" and r["condition"]["requestDomains"] == ["cdn.example", "x.example"]
          for r in res.rules) and len(res.rules) == 2, res.rules)
check("merged rules have no urlFilter", all("urlFilter" not in r["condition"] for r in res.rules))
check("||host^| (end anchor) is not merged", "urlFilter" in only("||ads.example^|")["condition"])
check("IP addresses are not merged", only("||10.1.2.3^")["condition"].get("urlFilter") == "||10.1.2.3^")

# ---- options ----
r = only("/banner/*$image,script,domain=a.com|~b.a.com")
check("types + domain= -> resourceTypes/initiatorDomains",
      r == {"priority": 1, "action": {"type": "block"}, "condition": {
          "urlFilter": "/banner/", "initiatorDomains": ["a.com"], "excludedInitiatorDomains": ["b.a.com"],
          "resourceTypes": ["image", "script"]}}, r)
r = only("||x.com/ads$~script,~third-party")
check("negated types exclude the page itself too", r["condition"].get("excludedResourceTypes") == ["main_frame", "script"]
      and r["condition"].get("domainType") == "firstParty", r)
check("$important -> higher priority", only("||x.com/ad.js$important")["priority"] == 2)
r = only("||x.com/Ad$match-case")
check("$match-case -> isUrlFilterCaseSensitive", r["condition"].get("isUrlFilterCaseSensitive") is True, r)
check("$xhr/$frame/$css aliases", only("||x.com/a$xhr,frame,css")["condition"]["resourceTypes"]
      == ["stylesheet", "sub_frame", "xmlhttprequest"])
r = only("$script,domain=a.com")
check("empty pattern with domain= has no urlFilter", "urlFilter" not in r["condition"]
      and r["condition"]["initiatorDomains"] == ["a.com"], r)
check("$method=", only("||x.com/a$method=post|~get")["condition"].get("requestMethods") == ["post"])
check("||* -> plain *", only("||*.cdn.com/ad.js")["condition"]["urlFilter"] == ".cdn.com/ad.js")
check("$popup,script keeps script only", only("||x.com/pop$popup,script")["condition"]["resourceTypes"] == ["script"])

# ---- exceptions ----
r = only("@@||good.com/player.js$script")
check("@@ -> allow, priority 3", r["action"]["type"] == "allow" and r["priority"] == 3, r)
res, cos = convert("@@||good.com^$document")
r = res.rules[0]
check("@@$document -> allowAllRequests main/sub frame", r["action"]["type"] == "allowAllRequests"
      and r["condition"]["resourceTypes"] == ["main_frame", "sub_frame"], r)
check("@@$document also switches element hiding off", "good.com" in cos["elemhide"], cos["elemhide"])
res, cos = convert("@@||site.com^$generichide\n@@||www.google.*/search?$generichide")
check("$generichide: no network rule, host for the cosmetics", not res.rules
      and cos["generichide"] == ["site.com", "www.google.*"], (res.rules, cos["generichide"]))
r = only("@@||imasdk.googleapis.com/js/core/dai_iframe$domain=southpark.de", domain_scope="top", site_fix=True)
check("site_fixes: topDomains (page in the address bar), priority 4",
      r["priority"] == 4 and r["condition"].get("topDomains") == ["southpark.de"], r)

# ---- skipped filters ----
check("popup only -> skipped", skipped("||pop.com^$popup") == ["popup"])
check("redirect -> skipped", skipped("||x.com/a.js$script,redirect=noop.js") == ["redirect"])
check("csp -> skipped", skipped("||x.com^$csp=script-src 'none'") == ["csp"])
check("removeparam -> skipped", skipped("$removeparam=utm_source") == ["removeparam"])
check("rewrite -> skipped", skipped("||x.com/a.js$rewrite=abp-resource:blank-js") == ["rewrite"])
check("genericblock -> skipped", skipped("@@||x.com^$genericblock") == ["genericblock"])
check("unknown option -> skipped", skipped("||x.com^$foo") == ["unbekannte Option: foo"])
check("page blocking ($document) -> skipped", skipped("||scam.com^$document") == ["document (Seitensperre)"])
check("non-ASCII -> skipped", skipped("||bücher.de/werbung") == ["nicht-ASCII"])
check("domain=*.entity -> skipped", skipped("||x.com/a$domain=google.*") == ["Domain mit *"])
check("'$script' alone (everything) -> skipped", skipped("$script") == ["ungültiges Muster"])
check("'|' inside the pattern -> skipped", skipped("/addyn|*|adtech;") == ["ungültiges Muster"])

# ---- regex ----
r = only(r"/ads\d+\.js/$script")
check("regex filter -> regexFilter", r["condition"].get("regexFilter") == r"ads\d+\.js", r)
check("lookahead (not RE2) -> skipped", skipped(r"/ad(?=s)/") == ["Regex (nicht RE2)"])
check("regex too big for Chrome -> skipped", skipped(r"/(https?:\/\/)104\.154\..{100,}/") == ["Regex zu groß für Chrome"])
check("regex cost: 'a'x100 fits, .{40} not", regex_cost("a" * 100) <= 100 < regex_cost(".{40}"))

# ---- cosmetics ----
_, cos = convert("\n".join([
    "##.ad-banner", "###top-ad", "##.sponsor > div", '##div[id^="ad-"]', "example.com##.x", "example.com#@#.ad-banner",
    "~example.com##.y", "google.*##.g-ad", "#@#.global", "##.global", "example.com#?#.a:-abp-has(.b)",
    "example.com##+js(nowebrtc)", "example.com##.hdr {top:0}", "example.com##.box {remove:true;}",
    "beispiel.de##img[alt=\"Anzeige für Sie\"]", "ab.example.com,~cd.ab.example.com##.z"]))
check("generic class -> classes", cos["classes"].get("ad-banner") == [".ad-banner"]
      and cos["classes"].get("sponsor") == [".sponsor > div"], cos["classes"])
check("generic id -> ids", cos["ids"].get("top-ad") == ["#top-ad"], cos["ids"])
check("other generic selectors", cos["generic"] == ['div[id^="ad-"]'], cos["generic"])
check("~domain only -> generic rule", cos["classes"].get("y") == [".y"], cos["classes"].get("y"))
check("site-specific", cos["specific"].get("example.com") == [".x", ".box"] and cos["specific"].get("google.*") == [".g-ad"],
      cos["specific"])
check("non-ASCII selectors are kept", 'img[alt="Anzeige für Sie"]' in cos["specific"].get("beispiel.de", []))
check("exceptions per host (#@# and ~domain)", cos["exceptions"].get("example.com") == [".ad-banner", ".y"]
      and cos["exceptions"].get("cd.ab.example.com") == [".z"], cos["exceptions"])
check("#@# without domain removes the generic rule", "global" not in cos["classes"])
check("style rule -> CSS with !important", cos["styles"].get("example.com") == [".hdr { top:0 !important }"], cos["styles"])
# an open bracket/quote/comment would swallow every rule after it in the inserted style sheet
res, cos = convert("\n".join([
    "##.a:not(.x", '##div[title="x]', "##div[data-x", "##.b /* c", "##.c)", "example.com##.d {background: url(x}",
    '##a[href="/(x"]', "##.e\\:f", "##.ok:not(.x)"]))
check("unbalanced selectors/styles skipped, quoted brackets and escapes kept",
      res.stats["ungültiger Selektor"] == 6 and cos["generic"] == ['a[href="/(x"]', ".e\\:f"] and set(cos["classes"]) == {"ok"}
      and cos["styles"] == {}, (dict(res.stats), cos["generic"], cos["classes"], cos["styles"]))

# ---- validation ----
browser = find_browser_dir(required=False)
if browser:  # the desktop browser's site_fixes.txt (AdBlockBrowser next to this repository)
    res, _ = convert(open(os.path.join(browser, "site_fixes.txt"), encoding="utf-8").read(),
                     domain_scope="top", site_fix=True)
    check("site_fixes.txt converts without errors", res.rules and not validate_rules(res.rules), validate_rules(res.rules))
    check("ids are 1..n", [r["id"] for r in res.rules] == list(range(1, len(res.rules) + 1)))
else:
    print("SKIP site_fixes.txt: Desktop-Browser nicht gefunden")
errs = validate_rules([{"id": 1, "priority": 1, "action": {"type": "block"}, "condition": {"urlFilter": "||*x"}},
                       {"id": 1, "priority": 0, "action": {"type": "redirect"}, "condition": {"resourceTypes": ["popup"]}}])
check("validation finds broken rules", len(errs) >= 5, errs)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
