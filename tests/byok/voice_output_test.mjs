import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVoiceOutput } from '../../app/desktop/src/voice-output.mjs';

test('Windows speech invokes a fixed executable with data encoded, never a shell', () => {
  const runs = [];
  const children = [];
  const output = createVoiceOutput({ platform: 'win32', spawn: (file, args, opts) => {
    runs.push({ file, args, opts });
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.stdin = { end: data => { child.input = data; } };
    children.push(child);
    return child;
  } });
  const input = `Hello $(Remove-Item -Recurse *) ' ;`;
  assert.deepEqual(output.speak(input), { ok: true });
  const [{ file, args, opts }] = runs;
  assert.equal(file, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(opts.shell, false);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(script.includes('[Console]::In.ReadToEnd()'));
  assert.ok(!script.includes(input));
  assert.equal(children[0].input, Buffer.from(input, 'utf16le').toString('base64'));
  assert.deepEqual(output.speak('Second reply'), { ok: true });
  assert.equal(children[0].killed, true, 'a newer reply interrupts the old voice');
  assert.deepEqual(output.stop(), { ok: true });
  assert.equal(children[1].killed, true);
});

test('speech is opt-in, platform-specific and bounded', () => {
  let spawned = false;
  const speak = () => { spawned = true; };
  assert.deepEqual(createVoiceOutput({ platform: 'linux', spawn: speak }).speak('hello'), { ok: false, error: 'unsupported' });
  assert.deepEqual(createVoiceOutput({ platform: 'win32', spawn: speak }).speak(''), { ok: false, error: 'bad_input' });
  assert.deepEqual(createVoiceOutput({ platform: 'win32', spawn: speak }).speak('a'.repeat(1001)), { ok: false, error: 'bad_input' });
  assert.equal(spawned, false);
});
