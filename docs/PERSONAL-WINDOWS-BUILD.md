# Build the personal NeverQuestAlone Windows app locally

This personal build uses `feature/modular-game-context` (version 1.4.20). It is not an upstream release.
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
git switch feature/modular-game-context
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

## Personal fork upgrade: implementation-first handoff

The installed 1.4.19 app predates the newer feature-branch changes. Keep it installed
and usable while reviewing the branch. A new installer is required before the new
Character memories and Voice conversation settings appear; editing source code alone
does not modify the running app. Never install an unsigned personal build on someone
else's PC or treat its hash as a publisher signature.

After the full implementation is complete, run the build and test commands above.
Do not run the installer until the build and helper checks succeed. Save a SHA-256
hash of the generated setup executable, then install it with WoW closed. The app's
addon installation flow must install the packaged addon into the selected WoW
installation; having Questie or Auctionator installed separately is optional.

Manual Windows/WoW acceptance, only after the new build is installed. A microphone is **not required**: use typed questions and the **Test speaker** button. The in-game addon can read replies aloud on Windows when speech output is enabled; speech input remains optional.

1. Sign in with the existing ChatGPT account, send one message and receive one reply.
2. Save character-specific notes; quit/relaunch and check the same character's notes
   are still there. Switch characters to check separation.
3. Under Settings, enable Voice conversation only when wanted. Use **Test speaker**, then
   send typed text and verify a reply can be heard through Windows speakers. Ask in game
   and confirm the desktop reads the reply aloud. Microphone, speech recognition and
   optional Ctrl+Shift+Space can be tested later when a microphone is available.
4. With Questie installed, check a marked target is described using Questie's public
   objective API; without it, no error or misleading quest marker appears.
5. With Auctionator installed and a recent scan, link an item and check the cached
   value is advisory and labeled as a last-scan price; no trading is automated.
6. Enter a dungeon/party and ask for guidance. The read-only instance, group and
   target facts must remain optional; the companion must not operate the character.
   Also ask about bags, abilities, reputations, equipment, combat buffs, collections,
   and—with those windows open—bank items, mail and vendors. Responses are bounded
   summaries, not guaranteed complete exports; the addon must not infer zero from
   unavailable game APIs. Party summaries must never reveal party member names.
7. Check screen capture, routes, map pins and full-screen switching. The colored
   top-left pixels are the existing visual transport; Screen reading off suppresses
   them after `/reload`, but also disables live screen capture. Never cover or
   recolor the transport while capture is in use.

Implementation and verification statuses are recorded separately in the private
project reports. No QA result is implied by the existence of a feature-branch commit.
