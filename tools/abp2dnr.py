"""
Adblock Plus filter syntax -> Chrome declarativeNetRequest (DNR) rules and cosmetic data for
the browser extension (used by tools/build_extension.py). Standard library only.

Network filters become one DNR rule each, except plain domain filters ("||ads.example^") with
the same options: those are merged into one rule with "requestDomains" (Peter Lowe's list ends
up as a single rule). Element hiding rules ("##", "#@#") are collected for
extension/background.js, which answers the page's classes/ids like the desktop browser does
(cosmetic_filter.py).
"""

import re
from collections import Counter, defaultdict

# DNR priorities - higher wins, on equal priority "allow" beats "block". Order:
# exception list (dynamic rules, extension/background.js: 100) > site_fixes exceptions >
# list exceptions > $important > block
PRIORITY_BLOCK = 1
PRIORITY_IMPORTANT = 2
PRIORITY_ALLOW = 3
PRIORITY_SITE_FIX_ALLOW = 4

# filter option -> DNR resource type
TYPE_OPTIONS = {
    "script": "script", "image": "image", "stylesheet": "stylesheet", "css": "stylesheet",
    "xmlhttprequest": "xmlhttprequest", "xhr": "xmlhttprequest",
    "subdocument": "sub_frame", "frame": "sub_frame",
    "media": "media", "font": "font", "websocket": "websocket",
    "ping": "ping", "beacon": "ping", "object": "object", "other": "other",
}
DNR_RESOURCE_TYPES = {"main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
                      "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
                      "webbundle", "other"}
DNR_METHODS = {"connect", "delete", "get", "head", "options", "patch", "post", "put", "other"}
DNR_ACTIONS = {"block", "allow", "allowAllRequests"}

# options a DNR rule cannot express: the filter is skipped and counted under this name
UNSUPPORTED_OPTIONS = {
    "redirect": "redirect", "redirect-rule": "redirect", "removeparam": "removeparam",
    "queryprune": "removeparam", "csp": "csp", "rewrite": "rewrite", "genericblock": "genericblock",
    "badfilter": "badfilter", "inline-script": "csp", "inline-font": "csp",
}
COSMETIC_OPTIONS = {"elemhide": "elemhide", "ehide": "elemhide", "generichide": "generichide",
                    "ghide": "generichide"}

# Regex filters must compile to less than 2 KB in RE2 (Chrome checks it when loading the rule set).
# There is no RE2 in the standard library: regex_cost() estimates the program size instead.
# Measured with chrome.declarativeNetRequest.isRegexSupported() in Chromium 152 (10/2026): about
# 100 instructions fit ("a" x 100 and ".{30}" yes, "a" x 200 and ".{40}" no).
REGEX_MAX_COST = 100
RE2_UNSUPPORTED = re.compile(r"\(\?[=!<]|\\[1-9]|\\[uck]|[*+?}]\+")
CLASS_ITEM_RE = re.compile(r"(?:\\.|[^\\])(?:-(?:\\.|[^\\]))?")
ESCAPE_COST = {"w": 4, "W": 4, "s": 3, "S": 4, "d": 1, "D": 3}

HOST_RE = re.compile(r"^[a-z0-9_-]+(\.[a-z0-9_-]+)*$")
IPV4_RE = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
PLAIN_HOST_FILTER_RE = re.compile(r"^\|\|([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)\^$")
OPTIONS_RE = re.compile(r"^~?[a-z0-9_-]+(=[^,]*)?(,~?[a-z0-9_-]+(=[^,]*)?)*$", re.IGNORECASE)

COSMETIC_SEPARATOR_RE = re.compile(r"#@?(?:\$\?|[?$%])?#")
COSMETIC_DOMAINS_RE = re.compile(r"^[^/|^$\"'\s]*$")
PROCEDURAL_RE = re.compile(
    r":(?:-abp-[a-z-]+|has-text|contains|xpath|matches-css(?:-before|-after)?|upward|remove|style|"
    r"min-text-length|watch-attr|matches-path|others|matches-attr|matches-media|matches-prop|if|"
    r"if-not|nth-ancestor|remove-attr|remove-class)\(")
GENERIC_KEY_RE = re.compile(r"^([.#])([A-Za-z_-][A-Za-z0-9_-]*)(?![A-Za-z0-9_\\-])")
STYLE_RULE_RE = re.compile(r"^(.+?)\s*\{([^{}]*)\}$")   # "selector {declarations}" (CSS injection)
REMOVE_STYLE_RE = re.compile(r"(^|;)\s*remove\s*:\s*true\s*(;|$)")


class Skip(Exception):
    """A filter that cannot be converted; the message is the reason shown in the build summary."""


def is_ascii(text: str) -> bool:
    return all(ord(c) < 128 for c in text)


def normalize_domain(domain: str):
    """Lower-cased ASCII (punycode) domain, or None if it is not a plain domain."""
    d = domain.strip().lower()
    if not d:
        return None
    if not is_ascii(d):
        try:
            d = d.encode("idna").decode("ascii")
        except UnicodeError:
            return None
    return d if HOST_RE.match(d) else None


# ---------------------------------------------------------------------------------------------
# network filters
# ---------------------------------------------------------------------------------------------

class NetworkFilter:
    def __init__(self):
        self.allow = False
        self.pattern = ""
        self.regex = None            # RE2 source for regexFilter
        self.url_filter = None       # DNR urlFilter
        self.host = None             # set for plain "||host^" filters (requestDomains merge)
        self.types = set()
        self.excluded_types = set()
        self.party = None            # "firstParty" / "thirdParty"
        self.domains = []
        self.excluded_domains = []
        self.methods = []
        self.excluded_methods = []
        self.match_case = False
        self.important = False
        self.document = False        # @@...$document -> allowAllRequests
        self.cosmetic = set()        # "elemhide" / "generichide" on exceptions


def split_options(body: str):
    """Pattern and option list; '$' only starts options when what follows looks like options."""
    i = body.rfind("$")
    if i >= 0 and OPTIONS_RE.match(body[i + 1:]):
        return body[:i], body[i + 1:].split(",")
    return body, []


def parse_domains(value: str):
    include, exclude = [], []
    for part in value.split("|"):
        part = part.strip()
        if not part:
            continue
        neg = part.startswith("~")
        name = part[1:] if neg else part
        if "*" in name:
            raise Skip("Domain mit *")
        d = normalize_domain(name)
        if not d:
            raise Skip("nicht-ASCII" if not is_ascii(name) else "ungültige Domain")
        (exclude if neg else include).append(d)
    return include, exclude


def convert_url_pattern(pattern: str):
    """ABP pattern -> DNR urlFilter (None = matches every URL). The syntax (||, |, *, ^) is the same;
    only what DNR does not allow is rewritten or rejected."""
    if not is_ascii(pattern):
        raise Skip("nicht-ASCII")
    if any(c.isspace() for c in pattern):
        raise Skip("ungültiges Muster")
    p = pattern
    start = ""
    if p.startswith("||"):
        start, p = "||", p[2:]
    elif p.startswith("|"):
        start, p = "|", p[1:]
    end = ""
    if p.endswith("|"):
        end, p = "|", p[:-1]
    if "|" in p:
        raise Skip("ungültiges Muster")
    if start == "||" and p.startswith("*"):  # "||*" is not allowed in DNR
        start = ""
    if not start:
        p = p.lstrip("*")
    if not end:
        p = p.rstrip("*")
    if not p:
        if start or end:
            raise Skip("ungültiges Muster")
        return None
    return start + p + end


def regex_cost(src: str) -> int:
    """Rough number of RE2 instructions the regex compiles to (see REGEX_MAX_COST): a literal 1,
    "." 3, a class 1 per range, repeats multiply, alternatives add one each."""
    pos = 0

    def alternation():
        nonlocal pos
        branches = [sequence()]
        while pos < len(src) and src[pos] == "|":
            pos += 1
            branches.append(sequence())
        return sum(branches) + len(branches) - 1

    def sequence():
        total = 0
        while pos < len(src) and src[pos] not in "|)":
            total += repeat(atom())
        return total

    def atom():
        nonlocal pos
        c = src[pos]
        if c == "(":
            pos += 1
            if src.startswith("?:", pos):
                pos += 2
            cost = alternation() + 1
            pos += 1  # ")"
            return cost
        if c == "[":
            end = pos + 1
            if src[end:end + 1] == "^":
                end += 1
            if src[end:end + 1] == "]":
                end += 1
            while end < len(src) and src[end] != "]":
                end += 2 if src[end] == "\\" else 1
            body = src[pos + 1:end]
            pos = end + 1
            negated = body.startswith("^")
            return max(1, len(CLASS_ITEM_RE.findall(body[1:] if negated else body))) + negated
        if c == "\\":
            pos += 2
            return ESCAPE_COST.get(src[pos - 1:pos], 1)
        pos += 1
        return 3 if c == "." else 1

    def repeat(cost):
        nonlocal pos
        if pos >= len(src):
            return cost
        if src[pos] in "?*+":
            pos += 2 if src[pos + 1:pos + 2] == "?" else 1
            return cost + 1
        m = re.match(r"\{(\d+)(,(\d*))?\}", src[pos:])
        if not m:
            return cost
        pos += m.end()
        low = int(m.group(1))
        if m.group(2) is None:
            return cost * low
        if not m.group(3):
            return cost * (low + 1) + 1
        high = int(m.group(3))
        return cost * high + (high - low)

    return alternation()


def convert_regex(pattern: str) -> str:
    src = pattern[1:-1]
    if not src:
        raise Skip("ungültiges Muster")
    if not is_ascii(src):
        raise Skip("nicht-ASCII")
    if RE2_UNSUPPORTED.search(src):
        raise Skip("Regex (nicht RE2)")
    try:
        re.compile(src)
    except re.error:
        raise Skip("ungültiges Muster")
    if regex_cost(src) > REGEX_MAX_COST:
        raise Skip("Regex zu groß für Chrome")
    return src


def parse_network_filter(line: str) -> NetworkFilter:
    """Parses one network filter line. Raises Skip with the reason if it cannot be converted."""
    f = NetworkFilter()
    body = line
    if body.startswith("@@"):
        f.allow = True
        body = body[2:]
    pattern, options = split_options(body)
    f.pattern = pattern

    popup = False
    for raw in options:
        opt = raw.strip()
        if not opt:
            continue
        name, _, value = opt.partition("=")
        name = name.lower()
        neg = name.startswith("~")
        key = name[1:] if neg else name
        if key in TYPE_OPTIONS:
            (f.excluded_types if neg else f.types).add(TYPE_OPTIONS[key])
        elif key in ("third-party", "3p"):
            f.party = "firstParty" if neg else "thirdParty"
        elif key in ("first-party", "1p"):
            f.party = "thirdParty" if neg else "firstParty"
        elif key in ("domain", "from") and not neg:
            f.domains, f.excluded_domains = parse_domains(value)
        elif key == "method" and not neg:
            for m in value.lower().split("|"):
                mneg = m.startswith("~")
                m = m[1:] if mneg else m
                if m not in DNR_METHODS:
                    raise Skip("unbekannte Option: method=" + m)
                (f.excluded_methods if mneg else f.methods).append(m)
        elif key == "match-case" and not neg:
            f.match_case = True
        elif key == "important" and not neg:
            f.important = True
        elif key in ("document", "doc"):
            if not neg:
                f.document = True
            # "~document": the page itself is never blocked anyway
        elif key == "popup" and not neg:
            popup = True
        elif key in COSMETIC_OPTIONS and not neg:
            f.cosmetic.add(COSMETIC_OPTIONS[key])
        elif key in UNSUPPORTED_OPTIONS:
            raise Skip(UNSUPPORTED_OPTIONS[key])
        else:
            raise Skip("unbekannte Option: " + name)

    if f.cosmetic and not f.allow:
        raise Skip("unbekannte Option: " + "/".join(sorted(f.cosmetic)))
    if f.document and not f.allow:
        # blocking whole pages: the desktop browser never blocks the page navigation either
        if not f.types:
            raise Skip("document (Seitensperre)")
        f.document = False
    if popup and not f.types and not f.document and not (f.allow and f.cosmetic):
        raise Skip("popup")
    if f.types:
        f.excluded_types = set()
    elif f.excluded_types:
        f.excluded_types.add("main_frame")  # DNR would otherwise include the page itself
    if f.allow and f.cosmetic and not f.document and not f.types and not f.excluded_types:
        return f  # only an element hiding exception, no network rule

    if len(pattern) >= 2 and pattern.startswith("/") and pattern.endswith("/"):
        f.regex = convert_regex(pattern)
    else:
        f.url_filter = convert_url_pattern(pattern)
        m = PLAIN_HOST_FILTER_RE.match(pattern.lower())
        if m and not IPV4_RE.match(m.group(1)):
            f.host = m.group(1)
        if f.url_filter is None and not (f.domains or f.document):
            raise Skip("ungültiges Muster")  # would match (e.g. every script) everywhere
    return f


def has_network_part(f: NetworkFilter) -> bool:
    return not (f.allow and f.cosmetic and not f.document and not f.types and not f.excluded_types)


def network_rule(f: NetworkFilter, domain_scope: str = "initiator", site_fix: bool = False) -> dict:
    """DNR rule (without id). domain_scope: "initiator" ($domain= = the frame that sends the
    request, standard) or "top" (the page in the address bar - what the desktop browser checks)."""
    cond = {}
    if f.regex is not None:
        cond["regexFilter"] = f.regex
    elif f.url_filter is not None:
        cond["urlFilter"] = f.url_filter
    if f.match_case and cond:
        cond["isUrlFilterCaseSensitive"] = True
    field = "topDomains" if domain_scope == "top" else "initiatorDomains"
    excluded_field = "excludedTopDomains" if domain_scope == "top" else "excludedInitiatorDomains"
    if f.domains:
        cond[field] = sorted(set(f.domains))
    if f.excluded_domains:
        cond[excluded_field] = sorted(set(f.excluded_domains))
    if f.party:
        cond["domainType"] = f.party
    if f.methods:
        cond["requestMethods"] = sorted(set(f.methods))
    if f.excluded_methods:
        cond["excludedRequestMethods"] = sorted(set(f.excluded_methods))

    if f.allow and f.document:
        action = "allowAllRequests"
        cond["resourceTypes"] = ["main_frame", "sub_frame"]
    else:
        action = "allow" if f.allow else "block"
        if f.types:
            cond["resourceTypes"] = sorted(f.types)
        elif f.excluded_types:
            cond["excludedResourceTypes"] = sorted(f.excluded_types)

    if f.allow:
        priority = PRIORITY_SITE_FIX_ALLOW if site_fix else PRIORITY_ALLOW
    else:
        priority = PRIORITY_IMPORTANT if f.important else PRIORITY_BLOCK
    return {"priority": priority, "action": {"type": action}, "condition": cond}


# ---------------------------------------------------------------------------------------------
# element hiding (cosmetic) filters
# ---------------------------------------------------------------------------------------------

class CosmeticCollector:
    """Collects element hiding rules of all lists into the structure of generated/cosmetic.json."""

    def __init__(self):
        self.specific = defaultdict(list)      # host / "entity.*" -> selectors
        self.styles = defaultdict(list)        # host / "entity.*" -> CSS rules ("sel {...}" filters)
        self.exceptions = defaultdict(list)    # host -> selectors not to hide there
        self.global_exceptions = set()         # "#@#sel" without domain: never hide sel
        self.classes = defaultdict(list)       # class -> generic selectors starting with .class
        self.ids = defaultdict(list)           # id -> generic selectors starting with #id
        self.generic = []                      # other generic selectors (applied on every page)
        self.generichide = set()               # hosts without generic rules ($generichide)
        self.elemhide = set()                  # hosts without any element hiding ($elemhide/$document)
        self._seen_generic = set()

    def add_host_option(self, f: NetworkFilter, stats: Counter):
        """$generichide / $elemhide / $document exceptions: which host they are for."""
        host = host_of_pattern(f.pattern)
        hosts = [host] if host else list(f.domains)
        if not hosts:
            stats["Kosmetik-Ausnahme ohne Host"] += 1
            return
        for kind in f.cosmetic | ({"elemhide"} if f.document else set()):
            (self.elemhide if kind == "elemhide" else self.generichide).update(hosts)
        stats["Kosmetik-Ausnahme (" + "/".join(sorted(f.cosmetic or {"document"})) + ")"] += 1

    def add(self, line: str, sep_index: int, sep: str, stats: Counter) -> bool:
        domains_part = line[:sep_index]
        selector = line[sep_index + len(sep):].strip()
        exception = "@" in sep
        if sep in ("#?#", "#@?#"):
            stats["erweitert: #?#"] += 1
            return False
        if sep in ("#$#", "#@$#", "#$?#", "#@$?#"):
            stats["erweitert: #$#"] += 1
            return False
        if sep in ("#%#", "#@%#"):
            stats["erweitert: #%#"] += 1
            return False
        if selector.startswith("+js("):
            stats["Scriptlet ##+js(...)"] += 1
            return False
        if selector.startswith("^"):
            stats["HTML-Filter ##^"] += 1
            return False
        if PROCEDURAL_RE.search(selector):
            stats["erweitert: :has-text/:-abp-/..."] += 1
            return False
        style = None
        m = STYLE_RULE_RE.match(selector)
        if m:
            selector = m.group(1).strip()
            if not REMOVE_STYLE_RE.search(m.group(2)):  # "{remove:true;}" = hide
                style = important_declarations(m.group(2))
                if not style:
                    stats["ungültiger Selektor"] += 1
                    return False
        if not selector or "{" in selector or "}" in selector:
            stats["ungültiger Selektor"] += 1
            return False

        include, exclude = [], []
        for part in domains_part.split(","):
            part = part.strip()
            if not part:
                continue
            neg = part.startswith("~")
            name = part[1:] if neg else part
            entity = name.endswith(".*")
            d = normalize_domain(name[:-2] if entity else name)
            if not d:
                stats["ungültige Domain"] += 1
                return False
            (exclude if neg else include).append(d + ".*" if entity else d)

        if style:
            if exception or not include:
                stats["Stil-Regel ohne Domain/Ausnahme"] += 1
                return False
            for d in include:
                self.styles[d].append(f"{selector} {{ {style} }}")
            stats["Stil-Regeln (seitenspezifisch)"] += 1
            return True
        if exception:
            if not include and not exclude:
                self.global_exceptions.add(selector)
            for d in include:
                self.exceptions[d].append(selector)
            stats["Ausnahmen #@#"] += 1
            return True
        for d in exclude:  # "~a.com##sel": not on a.com
            self.exceptions[d].append(selector)
        if include:
            for d in include:
                self.specific[d].append(selector)
            stats["seitenspezifisch"] += 1
            return True
        if selector in self._seen_generic:
            stats["doppelt"] += 1
            return True
        self._seen_generic.add(selector)
        m = GENERIC_KEY_RE.match(selector)
        if m and "," not in selector:
            (self.classes if m.group(1) == "." else self.ids)[m.group(2)].append(selector)
            stats["generisch (Klasse/ID)"] += 1
        else:
            self.generic.append(selector)
            stats["generisch (sonstige)"] += 1
        return True

    def to_json(self) -> dict:
        drop = self.global_exceptions

        def clean(mapping):
            out = {}
            for key in sorted(mapping):
                sels = [s for s in dict.fromkeys(mapping[key]) if s not in drop]
                if sels:
                    out[key] = sels
            return out

        return {
            "version": 1,
            "specific": clean(self.specific),
            "styles": {k: list(dict.fromkeys(v)) for k, v in sorted(self.styles.items())},
            "exceptions": {k: list(dict.fromkeys(v)) for k, v in sorted(self.exceptions.items())},
            "classes": clean(self.classes),
            "ids": clean(self.ids),
            "generic": [s for s in self.generic if s not in drop],
            "generichide": sorted(self.generichide),
            "elemhide": sorted(self.elemhide),
        }


def important_declarations(declarations: str):
    """CSS declarations with !important each - the extension adds them as user styles, which
    lose against the page's own rules otherwise."""
    out = []
    for d in declarations.split(";"):
        d = d.strip()
        if not d:
            continue
        if ":" not in d or "<" in d:
            return None
        out.append(d if "!important" in d.replace(" ", "") else d + " !important")
    return "; ".join(out)


def host_of_pattern(pattern: str):
    """Host of a filter pattern like "||example.com^", "|https://www.example.com/" or
    "||www.google.*/search" (-> "www.google.*"), if clear."""
    p = pattern.lower()
    if p.startswith("||"):
        p = p[2:]
    elif p.startswith("|"):
        p = p[1:]
        if "://" in p:
            p = p.split("://", 1)[1]
    elif p.startswith("://"):
        p = p[3:]
    else:
        return None
    host = re.split(r"[/^:|?]", p, maxsplit=1)[0]
    entity = host.endswith(".*") or host.endswith(".")
    host = host.rstrip("*").rstrip(".")
    if not host or "*" in host:
        return None
    d = normalize_domain(host)
    return d + ".*" if d and entity else d


def find_cosmetic_separator(line: str):
    """(index, separator) if the line is an element hiding rule, else None."""
    m = COSMETIC_SEPARATOR_RE.search(line)
    if not m or not COSMETIC_DOMAINS_RE.match(line[:m.start()]):
        return None
    return m.start(), m.group(0)


# ---------------------------------------------------------------------------------------------
# whole lists
# ---------------------------------------------------------------------------------------------

class ListResult:
    def __init__(self):
        self.rules = []                # DNR rules with ids
        self.stats = Counter()         # what happened to the lines (for the summary)
        self.regex_rules = 0
        self.merged_hosts = 0          # plain domain filters folded into requestDomains rules


def convert_list(text: str, cosmetics: CosmeticCollector, domain_scope: str = "initiator",
                 site_fix: bool = False) -> ListResult:
    res = ListResult()
    stats = res.stats
    singles = []
    host_groups = {}                   # options of a plain domain filter -> (rule, set of hosts)
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("!") or (line.startswith("[") and line.endswith("]")):
            continue
        sep = find_cosmetic_separator(line)
        if sep:
            stats["Kosmetik"] += 1
            cosmetics.add(line, sep[0], sep[1], stats)
            continue
        stats["Netzwerk"] += 1
        try:
            f = parse_network_filter(line)
        except Skip as e:
            stats["übersprungen: " + str(e)] += 1
            continue
        if f.cosmetic or (f.allow and f.document):
            cosmetics.add_host_option(f, stats)
        if not has_network_part(f):
            continue
        rule = network_rule(f, domain_scope, site_fix)
        if f.regex is not None:
            res.regex_rules += 1
        if f.host and not f.match_case:
            cond = dict(rule["condition"])
            del cond["urlFilter"]
            key = repr((rule["priority"], rule["action"]["type"], sorted(cond.items())))
            if key not in host_groups:
                host_groups[key] = (rule, set())
                singles.append(rule)
            host_groups[key][1].add(f.host)
            res.merged_hosts += 1
            continue
        singles.append(rule)

    for rule, hosts in host_groups.values():
        del rule["condition"]["urlFilter"]
        rule["condition"]["requestDomains"] = sorted(hosts)

    seen = set()
    for rule in singles:
        sig = repr(sorted((k, repr(v)) for k, v in rule.items()))
        if sig in seen:
            stats["doppelt (Netzwerk)"] += 1
            continue
        seen.add(sig)
        res.rules.append({"id": len(res.rules) + 1, **rule})
    return res


def validate_rules(rules) -> list:
    """Checks the rules the way Chrome's ruleset indexer would; returns error messages."""
    errors = []
    ids = set()
    domain_keys = ("requestDomains", "excludedRequestDomains", "initiatorDomains",
                   "excludedInitiatorDomains", "topDomains", "excludedTopDomains")
    for r in rules:
        rid = r.get("id")
        where = f"Regel {rid}"
        if not isinstance(rid, int) or rid < 1:
            errors.append(f"{where}: ungültige id")
        elif rid in ids:
            errors.append(f"{where}: id doppelt")
        ids.add(rid)
        if not isinstance(r.get("priority"), int) or r["priority"] < 1:
            errors.append(f"{where}: ungültige priority")
        action = r.get("action", {}).get("type")
        if action not in DNR_ACTIONS:
            errors.append(f"{where}: ungültige action {action!r}")
        cond = r.get("condition")
        if not isinstance(cond, dict):
            errors.append(f"{where}: condition fehlt")
            continue
        if "urlFilter" in cond and "regexFilter" in cond:
            errors.append(f"{where}: urlFilter und regexFilter")
        uf = cond.get("urlFilter")
        if uf is not None and (not uf or not is_ascii(uf) or uf.startswith("||*")):
            errors.append(f"{where}: ungültiger urlFilter {uf!r}")
        rf = cond.get("regexFilter")
        if rf is not None and (not rf or not is_ascii(rf)):
            errors.append(f"{where}: ungültiger regexFilter")
        for key in ("resourceTypes", "excludedResourceTypes"):
            if key in cond and (not cond[key] or not set(cond[key]) <= DNR_RESOURCE_TYPES):
                errors.append(f"{where}: ungültige {key}")
        if set(cond.get("resourceTypes", [])) & set(cond.get("excludedResourceTypes", [])):
            errors.append(f"{where}: resourceTypes überschneiden sich")
        if action == "allowAllRequests" and not (
                cond.get("resourceTypes") and set(cond["resourceTypes"]) <= {"main_frame", "sub_frame"}):
            errors.append(f"{where}: allowAllRequests nur für main_frame/sub_frame")
        for key in domain_keys:
            if key in cond and (not cond[key] or not all(isinstance(d, str) and HOST_RE.match(d)
                                                         for d in cond[key])):
                errors.append(f"{where}: ungültige {key}")
        if "domainType" in cond and cond["domainType"] not in ("firstParty", "thirdParty"):
            errors.append(f"{where}: ungültiger domainType")
        for key in ("requestMethods", "excludedRequestMethods"):
            if key in cond and (not cond[key] or not set(cond[key]) <= DNR_METHODS):
                errors.append(f"{where}: ungültige {key}")
    return errors
