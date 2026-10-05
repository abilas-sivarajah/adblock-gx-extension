"""Desktop shortcut "Opera GX (Discord)" for start_opera_discord.bat (like create_shortcut.py)."""
import os

import win32com.client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def create_discord_shortcut():
    shell = win32com.client.Dispatch('WScript.Shell')
    desktop = shell.SpecialFolders('Desktop')  # real desktop, also when redirected (e.g. OneDrive)
    shortcut_path = os.path.join(desktop, 'Opera GX (Discord).lnk')

    shortcut = shell.CreateShortCut(shortcut_path)
    shortcut.TargetPath = os.path.join(ROOT, 'start_opera_discord.bat')
    shortcut.WorkingDirectory = ROOT
    shortcut.WindowStyle = 7  # minimized: the console window only flashes in the taskbar
    shortcut.IconLocation = f"{os.path.join(ROOT, 'assets', 'icon.ico')},0"
    shortcut.Description = 'Opera GX ohne Hardware-Beschleunigung (Netflix & Co. im Discord-Stream sichtbar)'
    shortcut.Save()

    print(f'Desktop-Verknüpfung erstellt: {shortcut_path}')


if __name__ == '__main__':
    create_discord_shortcut()
