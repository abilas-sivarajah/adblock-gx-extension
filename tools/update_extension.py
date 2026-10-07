"""
Updates the extension from GitHub: pulls this repository and the desktop browser (fast-forward
only - local commits and uncommitted changes are never touched), rebuilds when the checked-out
commits differ from the last build or the filter lists are older than 12 h. The build writes
generated/build_info.json last; background.js notices the new build and reloads the extension.

The browser starts this itself over native messaging - at every browser start and hourly while it
runs (switchable in the popup under "Updates"). That needs a one-time registration for the current
Windows user (no admin rights): --install.

usage: python tools/update_extension.py              update now (output in the console)
       python tools/update_extension.py --force      build even if nothing changed
       python tools/update_extension.py --install    register for Chrome / Opera (native messaging)
       python tools/update_extension.py --uninstall  remove the registration
       (--native-host is what the browser runs: one message in, progress and result out)
"""

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import time

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)

import build_extension as build  # noqa: E402

HOST_NAME = "com.adblock_gx.updater"  # the same in background.js
HOST_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "AdBlockGX", "updater")
# Chrome reads the first key; Opera and other Chromium browsers read one of the two
REGISTRY_KEYS = (r"Software\Google\Chrome\NativeMessagingHosts", r"Software\Chromium\NativeMessagingHosts")
LOCK = os.path.join(TOOLS_DIR, ".cache", "update.lock")
LOG = os.path.join(TOOLS_DIR, ".cache", "update.log")
LOCK_STALE = 20 * 60
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW: no console flashing up


def run(cmd, timeout, cwd=None):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never", PYTHONIOENCODING="utf-8")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       cwd=cwd, env=env, creationflags=NO_WINDOW)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def git(repo, *args, timeout=60):
    return run(["git", "-C", repo, *args], timeout)


def last_line(text):
    lines = [l for l in text.splitlines() if l.strip()]
    return lines[-1].strip() if lines else ""


def git_error(text):
    """The telling line of a git error ("fatal: ..."), not the advice after it."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return next((l for l in lines if l.startswith(("fatal:", "error:"))), lines[0] if lines else "")


def pull(name, repo):
    """Fast-forwards a checkout to its GitHub branch. state: updated | current | skipped | error"""
    def result(state, text):
        return {"name": name, "state": state, "text": text}

    if not repo or not os.path.isdir(os.path.join(repo, ".git")):
        return result("skipped", "kein Git-Ordner")
    try:
        code, _, err = git(repo, "fetch", "--quiet", timeout=120)
        if code:
            return result("error", "GitHub nicht erreichbar" + (f" ({git_error(err)})" if err else ""))
        code, _, _ = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        if code:
            return result("skipped", "Branch ohne Gegenstück auf GitHub - nicht aktualisiert")
        _, counts, _ = git(repo, "rev-list", "--left-right", "--count", "HEAD...@{u}")
        ahead, behind = (int(n) for n in counts.split())
        if not behind:
            return result("current", "aktuell" + (f" ({ahead} eigene Commits)" if ahead else ""))
        if ahead:
            return result("skipped", f"{behind} neue Commits auf GitHub, aber {ahead} lokale - "
                                     "selbst zusammenführen")
        code, _, err = git(repo, "merge", "--ff-only", "--quiet", "@{u}")
        if code:
            return result("skipped", f"{behind} neue Commits, lokale Änderungen im Weg - nicht aktualisiert")
        return result("updated", f"{behind} neue Commit{'s' if behind > 1 else ''} geholt")
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        return result("error", f"git: {e}")


def lists_stale():
    try:
        ages = [time.time() - os.path.getmtime(os.path.join(build.CACHE_DIR, f))
                for f in os.listdir(build.CACHE_DIR) if f.endswith(".txt")]
    except OSError:
        return True
    return not ages or max(ages) > build.CACHE_MAX_AGE


def build_reason(browser, force):
    """Why a build is needed, or None."""
    if force:
        return "erzwungen"
    info = build.read_build_info()
    if not info:
        return "noch kein Build"
    if info.get("sources") != {"extension": build.git_output(build.ROOT, "rev-parse", "HEAD"),
                               "browser": build.git_output(browser, "rev-parse", "HEAD") if browser else None}:
        return "neuer Code"
    if lists_stale():
        return "Filterlisten älter als 12 h"
    return None


def take_lock():
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    for _ in range(2):
        try:
            os.close(os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return True
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(LOCK) < LOCK_STALE:
                    return False
                os.remove(LOCK)  # left behind by a killed run
            except OSError:
                return False
    return False


def log(lines):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        old = ""
        if os.path.exists(LOG):
            with open(LOG, encoding="utf-8", errors="replace") as f:
                old = f.read()[-200_000:]
        with open(LOG, "w", encoding="utf-8", newline="\n") as f:
            f.write(old + time.strftime("\n== %Y-%m-%d %H:%M:%S ==\n") + "\n".join(lines) + "\n")
    except OSError:
        pass


def update(force=False, say=print):
    """Pull both repositories, build if needed. Returns the result for the popup."""
    if not take_lock():
        return {"ok": True, "busy": True, "changed": False, "repos": [], "message": "Update läuft bereits"}
    out = []
    try:
        browser = build.find_browser_dir(required=False)
        say("Hole Änderungen von GitHub …")
        repos = [pull("Erweiterung", build.ROOT), pull("Desktop-Browser", browser)]
        out += [f"{r['name']}: {r['text']}" for r in repos]
        before = build.read_build_info().get("build")
        reason = build_reason(browser, force)
        result = {"ok": all(r["state"] != "error" for r in repos), "repos": repos, "built": bool(reason),
                  "reason": reason}
        if reason:
            say(f"Baue die Erweiterung ({reason}) …")
            out.append(f"Build: {reason}")
            code, stdout, stderr = run([sys.executable, os.path.join(TOOLS_DIR, "build_extension.py")], timeout=900,
                                       cwd=build.ROOT)
            out.append(stdout + ("\n" + stderr if stderr else ""))
            if code:
                errors = [l.strip() for l in (stdout + "\n" + stderr).splitlines() if "FEHLER" in l or "Error" in l]
                result.update(ok=False, message="Build fehlgeschlagen: " + (errors[0] if errors else last_line(stderr or stdout)))
        info = build.read_build_info()
        result["changed"] = bool(info.get("build")) and info.get("build") != before
        result["build"] = info.get("build")
        if "message" not in result:
            if result["changed"]:
                result["message"] = "Neue Version gebaut"
            elif reason:
                result["message"] = "Neu gebaut, nichts geändert"
            elif not result["ok"]:
                result["message"] = "GitHub nicht erreichbar"
            else:
                result["message"] = "Keine Änderungen"
        out.append(result["message"])
        return result
    finally:
        log(out)
        try:
            os.remove(LOCK)
        except OSError:
            pass


# ---- native messaging (the browser starts this with stdin/stdout as the channel) ----
def native_host():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    channel_in, channel_out = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr  # a stray print() must not break the channel

    def send(msg):
        data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        try:
            channel_out.write(struct.pack("<I", len(data)) + data)
            channel_out.flush()
        except OSError:
            pass  # browser closed meanwhile: finish the update anyway

    head = channel_in.read(4)
    if len(head) < 4:
        return
    msg = json.loads(channel_in.read(struct.unpack("<I", head)[0]).decode("utf-8"))
    if msg.get("type") == "ping":
        send({"type": "pong"})
    elif msg.get("type") == "update":
        result = update(force=bool(msg.get("force")), say=lambda text: send({"type": "progress", "text": text}))
        send(dict(result, type="done"))


def extension_id(path):
    """Id of an unpacked extension as Chromium derives it (crx_file::id_util::GenerateIdForPath):
    SHA-256 of the absolute path (UTF-16 on Windows, drive letter upper case), the first 32 hex
    digits mapped from 0-f to a-p."""
    path = os.path.abspath(path)
    if os.name == "nt":
        if len(path) > 1 and path[1] == ":":
            path = path[0].upper() + path[1:]
        data = path.encode("utf-16-le")
    else:
        data = path.encode()
    return "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(data).hexdigest()[:32])


def install():
    if os.name != "nt":
        sys.exit("Die Registrierung gibt es hier nur für Windows.")
    import winreg
    os.makedirs(HOST_DIR, exist_ok=True)
    python = sys.executable
    if os.path.basename(python).lower() == "pythonw.exe":
        python = os.path.join(os.path.dirname(python), "python.exe")
    bat = os.path.join(HOST_DIR, "host.bat")
    with open(bat, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(f'@echo off\n"{python}" "{os.path.abspath(__file__)}" --native-host %*\n')
    ext_id = extension_id(build.EXT_DIR)
    manifest = os.path.join(HOST_DIR, HOST_NAME + ".json")
    with open(manifest, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"name": HOST_NAME, "description": "AdBlock GX: Update aus GitHub (tools/update_extension.py)",
                   "path": bat, "type": "stdio", "allowed_origins": [f"chrome-extension://{ext_id}/"]}, f, indent=2)
    for key in REGISTRY_KEYS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, manifest)
    print(f"Eingerichtet: {HOST_NAME}\n  {manifest}\n  Erweiterung {ext_id} ({build.EXT_DIR})\n"
          "Die Erweiterung aktualisiert sich jetzt bei jedem Browserstart und stündlich.\n"
          "Nach dem Verschieben des Ordners oder einem neuen Python: --install erneut ausführen.")


def uninstall():
    if os.name != "nt":
        return
    import winreg
    for key in REGISTRY_KEYS:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME)
        except OSError:
            pass
    for name in ("host.bat", HOST_NAME + ".json"):
        try:
            os.remove(os.path.join(HOST_DIR, name))
        except OSError:
            pass
    print("Registrierung entfernt - die Erweiterung aktualisiert sich nicht mehr selbst.")


def main():
    ap = argparse.ArgumentParser(description="Aktualisiert die Erweiterung aus GitHub.")
    ap.add_argument("--force", action="store_true", help="auch ohne Änderungen neu bauen")
    ap.add_argument("--install", action="store_true", help="für den Browser registrieren (Native Messaging)")
    ap.add_argument("--uninstall", action="store_true", help="Registrierung entfernen")
    ap.add_argument("--native-host", action="store_true", help=argparse.SUPPRESS)
    args, _ = ap.parse_known_args()  # the browser adds the extension's origin and --parent-window
    if args.native_host:
        return native_host()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    if args.install:
        return install()
    if args.uninstall:
        return uninstall()
    result = update(force=args.force)
    for r in result["repos"]:
        print(f"  {r['name']}: {r['text']}")
    print(result["message"] + (f" (Build {result['build']})" if result.get("build") else ""))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
