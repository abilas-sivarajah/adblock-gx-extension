"""Desktop shortcut "Opera GX (Discord)" for start_opera_discord.bat (like create_shortcut.py of the
desktop browser). Icon: assets/icon.ico of the desktop browser (AdBlockBrowser next to this
repository, see build_extension.py), otherwise the one of Opera GX."""
import os

import win32com.client

from build_extension import find_browser_dir

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def shortcut_icon():
    browser = find_browser_dir(required=False)
    candidates = [os.path.join(browser, 'assets', 'icon.ico')] if browser else []
    candidates += [os.path.expandvars(r'%LOCALAPPDATA%\Programs\Opera GX\opera.exe'),
                   os.path.expandvars(r'%ProgramFiles%\Opera GX\opera.exe')]
    return next((f'{path},0' for path in candidates if os.path.exists(path)), None)


def create_discord_shortcut():
    shell = win32com.client.Dispatch('WScript.Shell')
    desktop = shell.SpecialFolders('Desktop')  # real desktop, also when redirected (e.g. OneDrive)
    shortcut_path = os.path.join(desktop, 'Opera GX (Discord).lnk')

    shortcut = shell.CreateShortCut(shortcut_path)
    shortcut.TargetPath = os.path.join(ROOT, 'start_opera_discord.bat')
    shortcut.WorkingDirectory = ROOT
    shortcut.WindowStyle = 7  # minimized: the console window only flashes in the taskbar
    icon = shortcut_icon()
    if icon:
        shortcut.IconLocation = icon
    shortcut.Description = 'Opera GX ohne Hardware-Beschleunigung (Netflix & Co. im Discord-Stream sichtbar)'
    shortcut.Save()

    print(f'Desktop-Verknüpfung erstellt: {shortcut_path}')


if __name__ == '__main__':
    create_discord_shortcut()
