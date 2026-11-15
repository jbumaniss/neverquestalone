# Windows AI reply playback

The desktop **Voice conversation** page has independent controls for listening and speaking.
**Speak AI replies** does not require a microphone. When enabled, it watches the current in-game
chat and speaks newly arriving assistant replies while that desktop page stays active, including
while the app window is minimized to the tray.

On Windows, speech uses the built-in `System.Speech` synthesizer through a bounded main-process
adapter (`src/voice-output.mjs`). The renderer can only send text (up to 1,000 characters) via
validated IPC; it cannot select an executable or pass shell commands. The adapter never saves
audio or sends it to a remote speech provider. New speech cancels the previous request.

**Test speaker** speaks a fixed local phrase. Windows must have a working output device and an
installed speech voice. This is distinct from **Start listening**, which requires microphone
permission and may use the browser/OS speech recognition service.

The Windows speech output path has automated IPC/unit coverage, but actual audible playback
must still be confirmed on a Windows computer. A failure to hear a voice is not evidence that
the AI reply or game connection failed.
