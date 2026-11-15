# Build the personal NeverQuestAlone Windows app locally

This personal build uses **`main` in the `jbumaniss/neverquestalone` fork**.
The earlier 1.4.20 integration began at `7bf11e5`; 1.4.21 restored character
memory reads. The 1.4.22 candidate gives each added memory its own durable card,
separate from the existing notes editor.
It is not an upstream release.
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
git switch main
node --version
zig version
npm.cmd ci
npm.cmd --prefix app/desktop ci
npm.cmd test

# Required before packaging: builds the native capture executable and checks reproducibility.
& "$env:ProgramFiles\Git\bin\bash.exe" bridge/capture/windows/build.sh

npm.cmd --prefix app/desktop run dist -- --win --x64
```

The installer is produced under `app/desktop/dist/`. A local build without signing
credentials is **unsigned**, so Windows SmartScreen may warn about it. The build script
sets `--publish never` unless explicitly overridden. Do not configure publishing or signing
secrets just to test a local build.

The packaging step is deliberately blocked if `bridge/capture/windows/build/nqa-capture.exe`
is missing; a desktop app without the helper cannot read the game's screen. Building the
Electron app is not evidence that capture or speech works in a live WoW session.

## Verification checkpoints (2026-11-15)

- Fork `main` commit `7bf11e5d185c92098834a48f1d3c9516b9574e21` is on GitHub.
- Windows `npm.cmd test` on `fork-main-test` at that exact commit: **2,144 tests,
  2,026 passed, 118 skipped, 0 failed**; codec round-trip PASS.
- The earlier 1.4.19 Windows run is a separate baseline, not evidence for 1.4.20.
- The Windows 1.4.20 packaged Electron self-test passed after the script-count fix:
  `ok: true`, `failed: []`, real API, capture helper present. Its corrected
  unsigned installer had SHA-256 `A86EED2B7CAF531F19D3CA00FB175F08FBE4B712A061DE270AC4A4FCE1217B33`.
- Windows 1.4.20 displayed Character memories, but saved notes were blank after
  relaunch. A read-only PowerShell check confirmed that
  `memory/Malderx-CAMWOW EU5 Realm 3 PvE/notes.md` still existed (19 bytes).
  The cause was the renderer calling `memory("Name-Realm")` while the IPC contract
  requires `memory({ char: "Name-Realm" })`. Version 1.4.21 fixes the call and
  adds regression coverage for loading saved notes.
- The Windows 1.4.21 run at fork `main` `7efe66a`: **2,149 tests, 2,031 passed,
  118 skipped, 0 failed**, codec round-trip PASS. The capture helper built
  reproducibly. The packaged self-test returned `ok: true`, `failed: []`, and
  `packaged: true`. The unsigned installer hash was
  `22F17CEC3E2CDC8E26A839FE92F92AE269156767D53290168BC6ED216B505693`.
  An installed relaunch displayed the old note `Testing persistance`, proving
  notes survived that update; a subsequently added memory did **not** appear
  after restart and prompted the 1.4.22 follow-up.
- **Not yet verified:** a Windows 1.4.22 installer and restart test of the
  separate memory cards; live ChatGPT, voice, Questie and Auctionator checks
  also remain open. Record results only after observing them.
- Dependency installation reported **7 moderate npm audit findings** in `app/desktop`.
  Review the advisory paths before changing pinned dependencies; do not run
  `npm audit fix --force` as an unreviewed build step.

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

## Personal fork update: 1.4.22

The installed 1.4.21 app restored existing notes, but its Add memory action
appended to the same text editor and gave no independent card. Build and install
1.4.22 to verify the new card store (`entries.json`) and separate extra notes.
Code changes do not update a running app.
Never install an unsigned personal build on someone else's PC or treat its hash
as a publisher signature. Existing saved notes must remain intact through the update.

After the full implementation is complete, run the build and test commands above.
Do not run the installer until the build and helper checks succeed. Save a SHA-256
hash of the generated setup executable, then install it with WoW closed. The app's
addon installation flow must install the packaged addon into the selected WoW
installation; having Questie or Auctionator installed separately is optional.

Manual Windows/WoW acceptance, only after the new build is installed. A microphone is **not required**: use typed questions and the **Test speaker** button. The in-game addon can read replies aloud on Windows when speech output is enabled; speech input remains optional.

1. Sign in with the existing ChatGPT account, send one message and receive one reply.
2. On Character memories, verify existing Malderx notes appear without re-entering
   them. Type `Remember my Rogue build` into **Add memory** and click the button:
   the input must clear and a new card must appear. Quit the entire app and
   reopen: the card and original notes must both remain. Edit and Save the
   **Extra notes** separately; neither action may overwrite the other. Create a
   second character, add a different memory, and verify separation. Play a
   character and confirm automatically remembered game history fills its own
   section. Inputs, buttons and textarea must remain spaced and usable.
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
project reports. Passing source tests does not imply Windows installation or in-game QA.
