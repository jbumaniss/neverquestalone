# Build the personal NeverQuestAlone Windows app locally

This fork starts from `feature/chatgpt-subscription-auth`. It is not an upstream release.
Its packaged application **checks for upstream release notices only**. It never downloads or installs
upstream binaries. A release notice is not approval to run someone else's build.

## Windows 10/11: prerequisites

- PowerShell, Git for Windows, and Node.js 22.19 or newer (the project package requirement).
- Zig 0.16.0 on PATH, plus Git Bash. The capture helper's build script pins Zig 0.16.0.
  Alternatively use MinGW-w64 and `build.sh --native` from Git Bash.
- WoW Forever completely closed while installing or replacing the addon.

## From PowerShell

```powershell
git clone https://github.com/jbumaniss/neverquestalone.git
cd neverquestalone
git switch feature/chatgpt-subscription-auth
node --version
zig version
npm ci
npm --prefix app/desktop ci
npm test

# Builds the native capture executable (and checks reproducibility).
& "$env:ProgramFiles\Git\bin\bash.exe" bridge/capture/windows/build.sh

cd app/desktop
node scripts/dist.mjs --win --x64
```

The installer is produced under `app/desktop/dist/`. A local build without signing
credentials is **unsigned**, so Windows SmartScreen may warn about it. The build script
sets `--publish never` unless explicitly overridden. Do not configure publishing or signing
secrets just to test a local build.

Run the installer only after reviewing the test result and generated artifacts.
Use the app's own addon installation flow with WoW closed. Keep the old working build
until the new one passes a live sign-in, screen-reading, in-game reply and map-pin test.
For exclusive fullscreen, verify capture and Alt+Tab recovery separately; borderless
fullscreen is the currently documented supported mode.

## If the capture build fails

Check `zig version` and that it is exactly 0.16.0. The helper also supports
`bridge/capture/windows/build.sh --native` with MinGW-w64 tools, as documented
in that script. Do not bypass missing-helper or package integrity checks.

## Existing setup

Before the new installer, set existing NeverQuestAlone builds to manual updates/off,
because the previous released application can still update itself. The new fork build
enforces notification-only operation independently of saved preferences.
