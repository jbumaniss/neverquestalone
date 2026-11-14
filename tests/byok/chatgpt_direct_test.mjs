import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTDirect, CHATGPT_MODELS_URL, CHATGPT_RESPONSES_URL } from '../../bridge/byok/auth/chatgpt-direct.mjs';

const catalog = { models: [
  { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
  { slug: 'hidden-test', display_name: 'Internal', visibility: 'hidden' },
  { slug: 'gpt-other', display_name: 'Another model', visibility: 'list' },
]};
const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { 'content-type': 'application/json' },
});
const sse = text => new Response(text, {
  headers: { 'content-type': 'text/event-stream; charset=utf-8' },
});
const completedStream = [
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Hi there"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4}}}',
  '', '',
].join('\n');
const request = (model = 'gpt-test') => ({
  model, system: ['Keep answers short.'],
  messages: [{ role: 'user', content: 'Where is my quest?' }],
  maxTokens: 512,
});
function fixture({ modelResponse = json(catalog), streamResponse = sse(completedStream) } = {}) {
  const calls = [];
  let tokenReads = 0;
  const direct = createChatGPTDirect({
    accessToken: async () => { tokenReads++; return 'test-only-oauth-token'; },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url === CHATGPT_MODELS_URL) return modelResponse.clone();
      // Cloning SSE makes an unused tee branch; the parser's early return can
      // await cancellation of that branch forever under Node 22.
      if (url === CHATGPT_RESPONSES_URL) return streamResponse;
      throw Error('unexpected network destination');
    },
  });
  return { direct, calls, tokenReads: () => tokenReads };
}
async function collect(generator) {
  const rows = [];
  for await (const event of generator) rows.push(event);
  return rows;
}

test('lists only account-visible ChatGPT plan models, with no Platform project header', async () => {
  const f = fixture();
  assert.deepEqual(await f.direct.listModels(), [
    { id: 'gpt-test', name: 'GPT Test' },
    { id: 'gpt-other', name: 'Another model' },
  ]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, CHATGPT_MODELS_URL);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer test-only-oauth-token');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.headers['openai-organization'], undefined);
  assert.equal(f.calls[0].options.headers['openai-project'], undefined);
  await f.direct.listModels();
  assert.equal(f.calls.length, 1, 'brief cache avoids repeated discovery');
  f.direct.invalidateModels();
  await f.direct.listModels();
  assert.equal(f.calls.length, 2);
});

test('ChatGPT plan request uses Responses streaming, store false and ordinary backend messages', async () => {
  const f = fixture();
  const events = await collect(f.direct.stream(request()));
  assert.equal(f.calls.length, 2);
  const call = f.calls[1];
  assert.equal(call.url, CHATGPT_RESPONSES_URL);
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.authorization, 'Bearer test-only-oauth-token');
  assert.equal(call.options.headers['openai-project'], undefined);
  const body = JSON.parse(call.options.body);
  assert.deepEqual(body, {
    model: 'gpt-test', input: [{ role: 'user', content: 'Where is my quest?' }],
    instructions: 'Keep answers short.', store: false, stream: true,
  });
  assert.equal(events.find(e => e.type === 'text').delta, 'Hi there');
  assert.equal(events.find(e => e.type === 'done').finish, 'stop');
  assert.equal(events.find(e => e.type === 'usage').usage.output, 4);
  assert.ok(!JSON.stringify(events).includes('test-only-oauth-token'));
});

test('refuses models not returned by the signed-in account before sending a response', async () => {
  const f = fixture();
  const events = await collect(f.direct.stream(request('hidden-test')));
  assert.deepEqual(f.calls.map(x => x.url), [CHATGPT_MODELS_URL]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].error.code, 'model_not_available');
});

test('plan usage denial and rate limits never fall back to API key billing', async () => {
  for (const [code, wanted] of [[401, 'sign_in_required'], [403, 'plan_permission_denied'], [429, 'plan_usage_limited']]) {
    const f = fixture({ modelResponse: json({ detail: 'private-secret' }, code) });
    const events = await collect(f.direct.stream(request()));
    assert.equal(events.length, 1);
    assert.equal(events[0].error.code, wanted);
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(events).includes('private-secret'));
  }
});

test('interrupted or failed streams do not report a successful completion', async () => {
  for (const wire of [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"private"}}}\n\n',
  ]) {
    const f = fixture({ streamResponse: sse(wire) });
    const events = await collect(f.direct.stream(request()));
    assert.equal(events.some(e => e.type === 'done'), false);
    assert.equal(events.at(-1).type, 'error');
    assert.ok(!JSON.stringify(events).includes('private'));
  }
});

test('invalid catalog entries and unsupported successful content types are rejected', async () => {
  const invalid = fixture({ modelResponse: json({ models: [{ slug: '../bad', visibility: 'list', display_name: 'Bad' }] }) });
  await assert.rejects(invalid.direct.listModels(), /invalid_model_catalog/);
  const wrong = fixture({ streamResponse: json({ message: 'not an event stream' }) });
  const events = await collect(wrong.direct.stream(request()));
  assert.equal(events.at(-1).error.code, 'invalid_response_stream');
  assert.equal(events.some(e => e.type === 'done'), false);
});


test('response.incomplete is not accepted as a successful ChatGPT plan reply', async () => {
  const wire = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"partial"}',
    '',
    'event: response.incomplete',
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
    '', '',
  ].join('\n');
  const f = fixture({ streamResponse: sse(wire) });
  const events = await collect(f.direct.stream(request()));
  assert.equal(events.some(e => e.type === 'done'), false);
  assert.equal(events.at(-1).error.code, 'response_incomplete');
});

test('subscription sharing limit mid-stream stays in the ChatGPT plan route', async () => {
  const wire = 'event: response.failed\n' +
    'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n';
  const f = fixture({ streamResponse: sse(wire) });
  const events = await collect(f.direct.stream(request()));
  assert.equal(events.at(-1).error.code, 'plan_usage_limited');
  assert.equal(f.calls.length, 2);
});
