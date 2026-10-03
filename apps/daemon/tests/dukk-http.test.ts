import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  dukkEventToAgentPayload,
  parseDukkModels,
  parseDukkSseStream,
  type DukkServerEvent,
} from '../src/dukk-http.js';
import { resolveDukkConfig } from '../src/dukk-config.js';

// --- Translator: dukk SSE event -> DaemonAgentPayload -----------------------

test('translates text_delta to a text_delta payload', () => {
  assert.deepEqual(dukkEventToAgentPayload({ type: 'text_delta', text: 'olá' }), {
    type: 'text_delta',
    delta: 'olá',
  });
});

test('translates thinking_delta to a thinking_delta payload', () => {
  assert.deepEqual(
    dukkEventToAgentPayload({ type: 'thinking_delta', thinking: 'hmm' }),
    { type: 'thinking_delta', delta: 'hmm' },
  );
});

test('translates tool_use_started to a tool_use payload with empty input', () => {
  assert.deepEqual(
    dukkEventToAgentPayload({
      type: 'tool_use_started',
      tool_call_id: 'toolu_1',
      tool_name: 'read',
    }),
    { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
  );
});

test('translates tool_use_input_delta to a tool_input_delta payload', () => {
  assert.deepEqual(
    dukkEventToAgentPayload({
      type: 'tool_use_input_delta',
      tool_call_id: 'toolu_1',
      tool_name: 'read',
      partial_json: '{"path"',
    }),
    { type: 'tool_input_delta', id: 'toolu_1', name: 'read', delta: '{"path"' },
  );
});

test('translates tool_result, carrying the error flag only when set', () => {
  assert.deepEqual(
    dukkEventToAgentPayload({
      type: 'tool_result',
      tool_call_id: 'toolu_1',
      output: 'done',
    }),
    { type: 'tool_result', toolUseId: 'toolu_1', content: 'done' },
  );
  assert.deepEqual(
    dukkEventToAgentPayload({
      type: 'tool_result',
      tool_call_id: 'toolu_1',
      output: 'boom',
      is_error: true,
    }),
    { type: 'tool_result', toolUseId: 'toolu_1', content: 'boom', isError: true },
  );
});

test('translates usage_delta to a usage payload', () => {
  assert.deepEqual(
    dukkEventToAgentPayload({
      type: 'usage_delta',
      input_tokens: 10,
      output_tokens: 5,
    }),
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
  );
});

test('drops terminal and out-of-scope events (caller handles turn_* itself)', () => {
  for (const type of [
    'snapshot',
    'turn_started',
    'turn_completed',
    'turn_error',
    'turn_cancelled',
    'permission_request',
    'artifact_created',
    'sandbox_ready',
  ]) {
    assert.equal(
      dukkEventToAgentPayload({ type } as DukkServerEvent),
      null,
      `expected ${type} to be dropped`,
    );
  }
});

// --- SSE named-event parser -------------------------------------------------

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

test('parses named SSE records and yields their JSON data', async () => {
  const stream = chunks(
    'event: snapshot\ndata: {"type":"snapshot","seq":0}\n\n',
    'event: text_delta\ndata: {"type":"text_delta","text":"hi"}\n\n',
  );
  const out: DukkServerEvent[] = [];
  for await (const evt of parseDukkSseStream(stream)) out.push(evt);
  assert.deepEqual(out, [
    { type: 'snapshot', seq: 0 },
    { type: 'text_delta', text: 'hi' },
  ]);
});

test('reassembles a record split across chunk boundaries', async () => {
  const stream = chunks(
    'event: text_delta\ndata: {"type":"text_de',
    'lta","text":"split"}\n\n',
  );
  const out: DukkServerEvent[] = [];
  for await (const evt of parseDukkSseStream(stream)) out.push(evt);
  assert.deepEqual(out, [{ type: 'text_delta', text: 'split' }]);
});

test('skips keep-alive comments and malformed frames', async () => {
  const stream = chunks(
    ': keep-alive\n\n',
    'data: not-json\n\n',
    'data: {"type":"text_delta","text":"ok"}\n\n',
  );
  const out: DukkServerEvent[] = [];
  for await (const evt of parseDukkSseStream(stream)) out.push(evt);
  assert.deepEqual(out, [{ type: 'text_delta', text: 'ok' }]);
});

// --- Model catalog parsing --------------------------------------------------

test('parseDukkModels handles array, {models}, and provider-map shapes', () => {
  assert.deepEqual(parseDukkModels(['a', 'b']), [
    { id: 'a', label: 'a' },
    { id: 'b', label: 'b' },
  ]);
  assert.deepEqual(
    parseDukkModels({ models: [{ id: 'claude', name: 'Claude' }] }),
    [{ id: 'claude', label: 'Claude' }],
  );
  assert.deepEqual(parseDukkModels({ openai: { slug: 'gpt-4o' } }), [
    { id: 'gpt-4o', label: 'gpt-4o' },
  ]);
  assert.equal(parseDukkModels({}), null);
  assert.equal(parseDukkModels(null), null);
});

// --- Config resolution ------------------------------------------------------

test('resolveDukkConfig defaults to the local profile and engine port', () => {
  const cfg = resolveDukkConfig({ DUKK_TOKEN: 'tok' });
  assert.equal(cfg.profile, 'local');
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(cfg.environment, 'local');
  assert.equal(cfg.token, 'tok');
});

test('resolveDukkConfig switches to remote/sandbox and trims the base URL', () => {
  const cfg = resolveDukkConfig({
    DUKK_PROFILE: 'remote',
    DUKK_BASE_URL: 'https://api.dukk.com.br/',
    DUKK_TOKEN: 'jwt',
  });
  assert.equal(cfg.profile, 'remote');
  assert.equal(cfg.baseUrl, 'https://api.dukk.com.br');
  assert.equal(cfg.environment, 'sandbox');
  assert.equal(cfg.token, 'jwt');
});
