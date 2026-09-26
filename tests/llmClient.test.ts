import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmClient,
  readLlmConfig,
  modelForRole,
  OpenAiCompatibleClient,
  LLM_NOT_CONFIGURED_ERROR,
} from '../src/viero/agent/llmClient.js';

const baseEnv = {
  VIERO_LLM_BASE_URL: 'https://example.com/v1',
  VIERO_LLM_API_KEY: 'public-test-credential',
  VIERO_LLM_MODEL: 'openai/gpt-4o-mini',
};

test('readLlmConfig throws when VIERO_LLM_API_KEY is missing', () => {
  assert.throws(() => readLlmConfig({}), /LLM_NOT_CONFIGURED/);
});

test('readLlmConfig defaults baseUrl to OpenRouter when unset', () => {
  const cfg = readLlmConfig({ VIERO_LLM_API_KEY: 'sk-test' });
  assert.equal(cfg.baseUrl, 'https://openrouter.ai/api/v1');
});

test('readLlmConfig applies per-role model overrides with default fallback', () => {
  const cfg = readLlmConfig({
    ...baseEnv,
    VIERO_LLM_MODEL_SCREENER: 'openai/gpt-4o',
    VIERO_LLM_MODEL_GENERAL: 'anthropic/claude-3-5-sonnet',
  });
  assert.equal(cfg.models.SCREENER, 'openai/gpt-4o');
  assert.equal(cfg.models.MANAGER, baseEnv.VIERO_LLM_MODEL);
  assert.equal(cfg.models.GENERAL, 'anthropic/claude-3-5-sonnet');
});

test('readLlmConfig coerces numeric env vars and applies defaults', () => {
  const cfg = readLlmConfig({
    ...baseEnv,
    VIERO_LLM_TEMPERATURE: '0.7',
    VIERO_LLM_MAX_TOKENS: '2048',
    VIERO_LLM_TIMEOUT_MS: '45000',
  });
  assert.equal(cfg.temperature, 0.7);
  assert.equal(cfg.maxTokens, 2048);
  assert.equal(cfg.timeoutMs, 45000);

  const defaults = readLlmConfig(baseEnv);
  assert.equal(defaults.temperature, 0.2);
  assert.equal(defaults.maxTokens, 1024);
  assert.equal(defaults.timeoutMs, 90_000);
});

test('readLlmConfig rejects out-of-range or malformed values via zod', () => {
  assert.throws(() => readLlmConfig({ ...baseEnv, VIERO_LLM_TEMPERATURE: '3' }), /TEMPERATURE|temperature/i);
  assert.throws(() => readLlmConfig({ ...baseEnv, VIERO_LLM_MAX_TOKENS: '0' }), /MAX_TOKENS|max_tokens/i);
  assert.throws(() => readLlmConfig({ ...baseEnv, VIERO_LLM_TIMEOUT_MS: '-1' }), /TIMEOUT|timeout/i);
});

test('modelForRole returns the configured model for each role', () => {
  const cfg = readLlmConfig({
    ...baseEnv,
    VIERO_LLM_MODEL_SCREENER: 's',
    VIERO_LLM_MODEL_MANAGER: 'm',
    VIERO_LLM_MODEL_GENERAL: 'g',
  });
  assert.equal(modelForRole(cfg, 'SCREENER'), 's');
  assert.equal(modelForRole(cfg, 'MANAGER'), 'm');
  assert.equal(modelForRole(cfg, 'GENERAL'), 'g');
});

test('createLlmClient throws when API key is missing', () => {
  assert.throws(() => createLlmClient({}), /LLM_NOT_CONFIGURED/);
});

test('createLlmClient returns OpenAiCompatibleClient with default baseUrl', () => {
  const client = createLlmClient({ VIERO_LLM_API_KEY: 'sk-test' });
  assert.ok(client instanceof OpenAiCompatibleClient);
  assert.equal(client.isEnabled(), true);
  assert.equal(client.providerLabel(), 'openai-compatible:https://openrouter.ai/api/v1');
});

test('createLlmClient returns OpenAiCompatibleClient with configured baseUrl', () => {
  const client = createLlmClient(baseEnv);
  assert.ok(client instanceof OpenAiCompatibleClient);
  assert.equal(client.isEnabled(), true);
  assert.equal(client.providerLabel(), 'openai-compatible:https://example.com/v1');
});

test('OpenAiCompatibleClient posts the expected payload to /chat/completions', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'hello back', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new OpenAiCompatibleClient(readLlmConfig(baseEnv), fetchMock);
  const result = await client.chat({
    model: 'openai/gpt-4o-mini',
    systemPrompt: 'you are helpful',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you?' },
    ],
    temperature: 0.1,
    maxTokens: 256,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://example.com/v1/chat/completions');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer public-test-credential');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'openai/gpt-4o-mini');
  assert.equal(body.temperature, 0.1);
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'how are you?' },
  ]);
  assert.equal(result.content, 'hello back');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 4 });
});

test('OpenAiCompatibleClient maps tool calls and parses JSON args', async () => {
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_top_candidates', arguments: '{"limit":3}' } },
          { id: 'call_2', type: 'function', function: { name: 'broken', arguments: '{not valid json' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = new OpenAiCompatibleClient(readLlmConfig(baseEnv), fetchMock);
  const result = await client.chat({
    model: 'm',
    systemPrompt: 's',
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'get_top_candidates', description: 'top pools', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }],
    toolChoice: 'auto',
  });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls[0]!.args, { limit: 3 });
  assert.deepEqual(result.toolCalls[1]!.args, {});
});

test('OpenAiCompatibleClient sends Bearer authorization header using configured key', async () => {
  const calls: Array<{ init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    calls.push({ init: init ?? {} });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const client = new OpenAiCompatibleClient(readLlmConfig({ ...baseEnv, VIERO_LLM_API_KEY: 'public-test-credential' }), fetchMock);
  await client.chat({ model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer public-test-credential');
});

test('OpenAiCompatibleClient throws on non-2xx responses with sanitized body', async () => {
  const fetchMock: typeof fetch = async () =>
    new Response('error happened at https://secret.example/foo private-test-marker', { status: 500 });
  const client = new OpenAiCompatibleClient(readLlmConfig(baseEnv), fetchMock);
  await assert.rejects(
    client.chat({ model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] }),
    (err: Error) =>
      err.message.startsWith('LLM_HTTP_500:') &&
      !err.message.includes('secret.example') &&
      !err.message.includes('sk-or-v1'),
  );
});

test('OpenAiCompatibleClient throws LLM_NO_CHOICES on empty response', async () => {
  const fetchMock: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = new OpenAiCompatibleClient(readLlmConfig(baseEnv), fetchMock);
  await assert.rejects(
    client.chat({ model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] }),
    /LLM_NO_CHOICES/,
  );
});

test('OpenAiCompatibleClient maps finish_reason content_filter to error', async () => {
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = new OpenAiCompatibleClient(readLlmConfig(baseEnv), fetchMock);
  const result = await client.chat({ model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(result.finishReason, 'error');
});

test('OpenAiCompatibleClient honours caller-provided AbortSignal', async () => {
  const fetchMock: typeof fetch = (_input, init) => {
    if (init?.signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  const client = new OpenAiCompatibleClient(readLlmConfig(baseEnv), fetchMock);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    client.chat({ model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], signal: ac.signal }),
    /aborted|LLM_HTTP_/,
  );
});

test('createLlmClient throws when called with no env (LLM_NOT_CONFIGURED)', () => {
  assert.throws(() => createLlmClient({}), /LLM_NOT_CONFIGURED/);
});
