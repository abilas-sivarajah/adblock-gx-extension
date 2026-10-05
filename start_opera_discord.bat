@echo off
rem Discord-Stream-Modus fuer Opera GX (sonst Chrome): startet den Browser ohne Hardware-
rem Beschleunigung - wie start_browser_discord.bat beim Desktop-Browser. Dann zeigt Discords
rem Bildschirm-Teilen Netflix, Prime Video und Disney+ statt eines schwarzen Bildes.
rem Eigenes Profil (%LOCALAPPDATA%\AdBlockGX\Discord-...): laeuft der Browser schon mit dem
rem normalen Profil, wuerde er die Parameter sonst ignorieren. Dort einmal bei Netflix anmelden.
rem Opera laedt die Erweiterung (extension\) selbst; Chrome erlaubt das nicht mehr - dort die
rem Erweiterung im Discord-Profil einmal per Hand laden (siehe README).
rem Aufruf: start_opera_discord.bat [Adresse]   (ohne Adresse: Netflix)
setlocal
set "FLAGS=--disable-gpu --disable-gpu-compositing --disable-accelerated-video-decode --disable-direct-composition-video-overlays"
set "BROWSER="
for %%P in ("%LOCALAPPDATA%\Programs\Opera GX\opera.exe" "%ProgramFiles%\Opera GX\opera.exe") do (
    if not defined BROWSER if exist "%%~P" (
        set "BROWSER=%%~P"
        set "KIND=Opera-GX"
    )
)
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe") do (
    if not defined BROWSER if exist "%%~P" (
        set "BROWSER=%%~P"
        set "KIND=Chrome"
    )
)
if not defined BROWSER (
    echo Weder Opera GX noch Chrome gefunden.
    pause
    exit /b 1
)
set "PROFILE=%LOCALAPPDATA%\AdBlockGX\Discord-%KIND%"
set "URL=%~1"
if not defined URL set "URL=https://www.netflix.com/"
if "%KIND%"=="Opera-GX" (
    start "" "%BROWSER%" %FLAGS% --user-data-dir="%PROFILE%" --load-extension="%~dp0extension" --no-first-run "%URL%"
) else (
    start "" "%BROWSER%" %FLAGS% --user-data-dir="%PROFILE%" --no-first-run "%URL%"
)
