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
  assert.equal(f.direct.cachedModels(), null);
  assert.deepEqual(await f.direct.listModels(), [
    { id: 'gpt-test', name: 'GPT Test' },
    { id: 'gpt-other', name: 'Another model' },
  ]);
  assert.deepEqual(f.direct.cachedModels(), [
    { id: 'gpt-test', name: 'GPT Test' }, { id: 'gpt-other', name: 'Another model' },
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
  assert.equal(f.direct.cachedModels(), null);
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
  const invalid = fixture({ modelResponse: json({ models: [{ slug: '\u0000bad', visibility: 'list', display_name: 'Bad' }] }) });
  await assert.rejects(invalid.direct.listModels(), error =>
    error.code === 'invalid_model_catalog' && error.catalogReason === 'invalid_visible_model');
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


test('accepts OpenAI account-visible model slugs beyond the old 128-character whitelist', async () => {
  const slug = 'future/' + 'a'.repeat(160) + '~preview';
  const f = fixture({ modelResponse: json({ models: [
    { slug, display_name: 'Future preview', visibility: 'list' },
    { slug: 'ignore', visibility: 'hidden' },
  ] }) });
  assert.deepEqual(await f.direct.listModels(), [{ id: slug, name: 'Future preview' }]);
  const events = await collect(f.direct.stream(request(slug)));
  assert.equal(events.some(e => e.type === 'done'), true);
  assert.equal(JSON.parse(f.calls.at(-1).options.body).model, slug);
});

test('explains an unexpected catalog shape without returning or logging response content', async () => {
  const wrong = fixture({ modelResponse: json({ object: 'list', data: [{ id: 'a-private-model' }] }) });
  await assert.rejects(wrong.direct.listModels(), error =>
    error.code === 'invalid_model_catalog' && error.catalogReason === 'unexpected_shape' &&
    !error.message.includes('a-private-model'));
});

test('invalid JSON has a safe fixed diagnostic code', async () => {
  const invalid = fixture({ modelResponse: new Response('<secret>private-response</secret>', { status: 200 }) });
  await assert.rejects(invalid.direct.listModels(), error =>
    error.catalogReason === 'invalid_json' && !JSON.stringify(error).includes('private-response'));
});

test('accepts bounded catalogs larger than the previous 256 KiB cap', async () => {
  const many = { models: Array.from({ length: 600 }, (_, i) =>
    ({ slug: 'model-' + i, display_name: 'OpenAI Model ' + i, visibility: 'list', description: 'x'.repeat(512) })) };
  const f = fixture({ modelResponse: json(many) });
  const out = await f.direct.listModels();
  assert.equal(out.length, 600);
});


test('ChatGPT plan sends the requested Thinking effort via Responses without Platform billing fields', async () => {
  const f = fixture();
  const events = await collect(f.direct.stream({ ...request(), effort: 'high' }));
  assert.equal(events.at(-1).type, 'done');
  const body = JSON.parse(f.calls.at(-1).options.body);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test('Thinking Off is translated to reasoning.none; unsupported values never reach OpenAI', async () => {
  const f = fixture();
  await collect(f.direct.stream({ ...request(), effort: 'off' }));
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body).reasoning, { effort: 'none' });
  const invalid = fixture();
  const events = await collect(invalid.direct.stream({ ...request(), effort: 'surprise' }));
  assert.equal(events[0].error.code, 'invalid_reasoning_effort');
  assert.equal(invalid.calls.length, 0);
});


test('ChatGPT streaming follows the shared start, request-audit and reasoning event contract', async () => {
  const stream = sse([
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"type":"reasoning"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Answer"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":7}}}',
    '', '',
  ].join('\n'));
  const f = fixture({ streamResponse: stream });
  const requests = [];
  const events = await collect(f.direct.stream(request(), {
    onRequest: r => { requests.push(r); },
  }));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    method: 'POST', url: CHATGPT_RESPONSES_URL,
    headers: { authorization: '(redacted)', 'content-type': 'application/json', accept: 'text/event-stream' },
    body: { model: 'gpt-test',
      input: [{ role: 'user', content: 'Where is my quest?' }],
      instructions: 'Keep answers short.', store: false, stream: true },
  });
  assert.equal(events[0].type, 'start');
  assert.ok(events.some(x => x.type === 'reasoning'), 'backend must see reasoning started');
  assert.equal(events.some(x => x.type === 'thinking'), false);
  assert.equal(events.find(x => x.type === 'text')?.delta, 'Answer');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(JSON.stringify({ events, requests }).includes('test-only-oauth-token'), false);
});

test('a failed response after HTTP 200 is recorded as started and is never marked done', async () => {
  const f = fixture({ streamResponse: sse('event: response.failed\n' +
    'data: {"type":"response.failed","response":{"error":{"message":"do-not-log-token"}}}\n\n') });
  const events = await collect(f.direct.stream(request()));
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.some(e => e.type === 'done'), false);
  assert.equal(JSON.stringify(events).includes('do-not-log-token'), false);
});

test('diagnostic request hook errors never interrupt the ChatGPT response', async () => {
  const f = fixture();
  const events = await collect(f.direct.stream(request(), {
    onRequest: () => { throw Error('UI not open'); },
  }));
  assert.equal(events.at(-1).type, 'done');
});


test('blocked network requests preserve the existing egress policy error kind', async () => {
  const makeRefusal = code => new TypeError('fetch failed', {
    cause: Object.assign(new Error('blocked'), { code }),
  });
  const modelsDenied = createChatGPTDirect({
    accessToken: async () => 'test-only-oauth-token',
    fetchFn: async () => { throw makeRefusal('EGRESS_BLOCKED'); },
  });
  await assert.rejects(modelsDenied.listModels(),
    err => err.code === 'egress_blocked' && err.egressCode === 'EGRESS_BLOCKED');
  const f = createChatGPTDirect({
    accessToken: async () => 'test-only-oauth-token',
    fetchFn: async url => {
      if (url === CHATGPT_MODELS_URL) return json(catalog);
      throw makeRefusal('EGRESS_STOPPED');
    },
  });
  const events = await collect(f.stream(request()));
  assert.equal(events.at(-1).error.kind, 'egress_blocked');
  assert.equal(events.at(-1).error.code, 'EGRESS_STOPPED');
  assert.equal(events.some(e => e.type === 'start'), false);
});


test('reach uses the shared provider contract and never sends an OAuth credential', async () => {
  const f = fixture();
  assert.deepEqual(await f.direct.reach(), { ok: true, status: 200 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.method, 'HEAD');
  assert.equal(f.calls[0].options.headers, undefined);
  assert.equal(f.calls[0].url, CHATGPT_MODELS_URL);
});

test('model discovery failure before a ChatGPT reply is retryable, never a Platform key fallback', async () => {
  const f = createChatGPTDirect({
    accessToken: async () => 'safe-model-token',
    fetchFn: async () => { throw Error('offline'); },
  });
  const events = await collect(f.stream(request()));
  assert.equal(events[0].error.kind, 'network_before_send');
  assert.equal(events[0].error.retryable, true);
  assert.equal(events[0].error.code, 'model_discovery_unavailable');
});
