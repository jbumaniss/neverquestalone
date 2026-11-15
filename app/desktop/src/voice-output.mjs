// Opt-in native Windows speech output. The renderer never runs a shell command;
// the spoken text is bounded and passed as encoded data, never interpolated as code.
import { spawn as spawnProcess } from 'node:child_process';

export function createVoiceOutput({ platform = process.platform, spawn = spawnProcess } = {}) {
  let current = null;
  const stop = () => {
    if (current) { try { current.kill(); } catch {} current = null; }
    return { ok: true };
  };
  const speak = text => {
    if (platform !== 'win32') return { ok: false, error: 'unsupported' };
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) return { ok: false, error: 'bad_input' };
    stop();
    const b64 = Buffer.from(text, 'utf16le').toString('base64');
    const command = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'try {',
      `  $message = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'))`,
      '  $s.Speak($message)',
      '} finally { $s.Dispose() }',
    ].join('\n');
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true, stdio: 'ignore', shell: false,
      });
      current = child;
      child.on('error', () => { if (current === child) current = null; });
      child.on('exit', () => { if (current === child) current = null; });
      return { ok: true };
    } catch {
      current = null;
      return { ok: false, error: 'speech_unavailable' };
    }
  };
  return { speak, stop };
}
