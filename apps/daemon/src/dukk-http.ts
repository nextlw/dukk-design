import type { DaemonAgentPayload } from '@open-design/contracts';
import type { RuntimeModelOption } from './runtimes/types.js';
import type { DukkConfig } from './dukk-config.js';

// ---------------------------------------------------------------------------
// dukk engine HTTP/SSE client
//
// The dukk engine (dukk-server / api.dukk.com.br) is NOT a local CLI — it is a
// session-based HTTP server that streams turn events over SSE. This module is
// the daemon's client: it creates a session, sends the composed prompt, and
// translates the engine's named SSE events into the daemon's `DaemonAgentPayload`
// union so the existing chat UI renders them with zero front-end changes.
//
// Contract (dukk-core crates/server, mirrored by api.dukk.com.br):
//   GET  /v1/health                                  -> { ok, version }
//   GET  /v1/opencode/models                          -> model catalog
//   POST /v1/sessions                                 -> { session_id, session }
//   POST /v1/sessions/{id}/messages                   -> { turn_id }
//   GET  /v1/sessions/{id}/events?since=N             -> text/event-stream
//   POST /v1/sessions/{id}/turns/{turn}/cancel        -> 204
// ---------------------------------------------------------------------------

// dukk SSE event shapes the MVP cares about (streaming.rs `ServerEvent`).
// Fields not listed (sandbox/artifact/permission/questions/plan) are ignored
// for now — see the translator's default branch.
export type DukkServerEvent = {
  type: string;
  seq?: number;
  session_id?: string;
  turn_id?: string;
  text?: string;
  thinking?: string;
  tool_call_id?: string;
  tool_name?: string;
  partial_json?: string;
  output?: string;
  is_error?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
};

function authHeaders(config: DukkConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return headers;
}

// --- Health -----------------------------------------------------------------

export async function dukkHealthOk(
  config: DukkConfig,
  timeoutMs = 2500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}/v1/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// --- Models -----------------------------------------------------------------

// Parse the engine's /v1/opencode/models payload into picker options. The
// OpenCode catalog shape varies (array, `{ models: [...] }`, or a provider map),
// so we extract defensively and return null on anything unusable so detection
// falls back to the static hints.
export function parseDukkModels(payload: unknown): RuntimeModelOption[] | null {
  const out: RuntimeModelOption[] = [];
  const push = (id: unknown, label?: unknown) => {
    if (typeof id !== 'string' || !id.trim()) return;
    out.push({ id: id.trim(), label: typeof label === 'string' && label.trim() ? label.trim() : id.trim() });
  };
  const visitEntry = (entry: unknown) => {
    if (typeof entry === 'string') return push(entry);
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      push(e.id ?? e.slug ?? e.model ?? e.name, e.name ?? e.label ?? e.id);
    }
  };
  if (Array.isArray(payload)) {
    payload.forEach(visitEntry);
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.models)) obj.models.forEach(visitEntry);
    else if (Array.isArray(obj.data)) obj.data.forEach(visitEntry);
    else for (const value of Object.values(obj)) visitEntry(value);
  }
  return out.length > 0 ? out : null;
}

export async function fetchDukkModels(
  config: DukkConfig,
  timeoutMs = 5000,
): Promise<RuntimeModelOption[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}/v1/opencode/models`, {
      method: 'GET',
      headers: authHeaders(config),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseDukkModels(await res.json().catch(() => null));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Translator (pure) ------------------------------------------------------

// Map one dukk SSE event onto the daemon's chat payload union. Returns null for
// events the MVP intentionally drops (snapshot, sandbox/artifact/permission/
// questions/plan, and the terminal turn_* events which the caller observes
// separately to end the run).
export function dukkEventToAgentPayload(
  evt: DukkServerEvent,
): DaemonAgentPayload | null {
  switch (evt.type) {
    case 'text_delta':
      return typeof evt.text === 'string' ? { type: 'text_delta', delta: evt.text } : null;
    case 'thinking_delta':
      return typeof evt.thinking === 'string'
        ? { type: 'thinking_delta', delta: evt.thinking }
        : null;
    case 'tool_use_started':
      return evt.tool_call_id
        ? { type: 'tool_use', id: evt.tool_call_id, name: evt.tool_name ?? 'tool', input: {} }
        : null;
    case 'tool_use_input_delta':
      return evt.tool_call_id && typeof evt.partial_json === 'string'
        ? {
            type: 'tool_input_delta',
            id: evt.tool_call_id,
            name: evt.tool_name ?? 'tool',
            delta: evt.partial_json,
          }
        : null;
    case 'tool_result':
      return evt.tool_call_id
        ? {
            type: 'tool_result',
            toolUseId: evt.tool_call_id,
            content: typeof evt.output === 'string' ? evt.output : '',
            ...(evt.is_error ? { isError: true } : {}),
          }
        : null;
    case 'usage_delta':
      return {
        type: 'usage',
        usage: {
          ...(typeof evt.input_tokens === 'number' ? { input_tokens: evt.input_tokens } : {}),
          ...(typeof evt.output_tokens === 'number' ? { output_tokens: evt.output_tokens } : {}),
        },
      };
    default:
      return null;
  }
}

// --- SSE line parser --------------------------------------------------------

// Parse a `text/event-stream` body (async-iterable of Uint8Array/string chunks,
// as Node's `fetch` Response.body provides) into successive dukk events. Each
// SSE record is `event: <name>\n data: <json>\n\n`; we only need the JSON in
// `data` (it carries its own `type`), so the `event:` line is ignored.
export async function* parseDukkSseStream(
  body: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<DukkServerEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let sep: number;
    // Records are separated by a blank line. Handle both \n\n and \r\n\r\n.
    while ((sep = indexOfRecordEnd(buffer)) !== -1) {
      const rawRecord = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, '');
      const dataLines: string[] = [];
      for (const line of rawRecord.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      try {
        const evt = JSON.parse(payload) as DukkServerEvent;
        if (evt && typeof evt.type === 'string') yield evt;
      } catch {
        // Keep-alive comments or malformed frames — skip.
      }
    }
  }
}

function indexOfRecordEnd(buffer: string): number {
  const a = buffer.indexOf('\n\n');
  const b = buffer.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

// --- HTTP calls -------------------------------------------------------------

async function dukkFetchJson<T>(
  config: DukkConfig,
  pathName: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${pathName}`, {
    ...init,
    headers: { ...authHeaders(config), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`dukk ${init.method ?? 'GET'} ${pathName} -> ${res.status} ${text.slice(0, 500)}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

type CreateSessionBody = {
  conv_id?: string;
  model?: string;
  cwd?: string;
  environment: 'local' | 'sandbox';
  permission_mode: string;
};

// --- Orchestrator -----------------------------------------------------------

export type DukkChatResult = { ok: true } | { ok: false; error: string };

export type RunDukkChatParams = {
  config: DukkConfig;
  prompt: string;
  model: string | null;
  cwd: string | null;
  conversationId: string | null;
  signal: AbortSignal;
  // Forward a translated payload to the chat SSE (server.ts wires this to
  // `send('agent', payload)`).
  emit: (payload: DaemonAgentPayload) => void;
  // Surface the engine session/turn ids so the caller can store them for
  // cancellation telemetry.
  onSession?: (sessionId: string, turnId: string | null) => void;
};

// Drive one chat turn against the dukk engine end to end: open a session, open
// the SSE stream, send the user message, and pump translated events until the
// turn terminates. Resolves `{ ok }` on turn_completed and `{ ok: false }` on
// turn_error; rethrows on abort so the caller's cancel path owns the terminal
// run state.
export async function runDukkHttpChat(params: RunDukkChatParams): Promise<DukkChatResult> {
  const { config, prompt, model, cwd, conversationId, signal, emit, onSession } = params;
  if (!config.token) {
    return { ok: false, error: 'dukk engine token ausente — configure DUKK_TOKEN ou rode o dukk-server local.' };
  }

  // 1. Create (or reuse) the session.
  const sessionBody: CreateSessionBody = {
    environment: config.environment,
    permission_mode: config.permissionMode,
    ...(conversationId ? { conv_id: conversationId } : {}),
    ...(model ? { model } : {}),
    ...(cwd && config.environment === 'local' ? { cwd } : {}),
  };
  const created = await dukkFetchJson<{ session_id: string }>(config, '/v1/sessions', {
    method: 'POST',
    body: JSON.stringify(sessionBody),
    signal,
  });
  const sessionId = created.session_id;
  if (!sessionId) return { ok: false, error: 'dukk não retornou session_id' };

  // 2. Open the SSE stream BEFORE sending the message so no early delta is
  //    lost (since=0 also replays the snapshot + any queued events).
  const eventsRes = await fetch(`${config.baseUrl}/v1/sessions/${sessionId}/events?since=0`, {
    method: 'GET',
    headers: { ...authHeaders(config), Accept: 'text/event-stream' },
    signal,
  });
  if (!eventsRes.ok || !eventsRes.body) {
    const text = await eventsRes.text().catch(() => '');
    return { ok: false, error: `dukk events stream falhou: ${eventsRes.status} ${text.slice(0, 300)}` };
  }

  // 3. Send the composed prompt as the user message; this starts the turn.
  const sent = await dukkFetchJson<{ turn_id: string }>(
    config,
    `/v1/sessions/${sessionId}/messages`,
    { method: 'POST', body: JSON.stringify({ content: prompt }), signal },
  );
  let turnId: string | null = sent.turn_id ?? null;
  onSession?.(sessionId, turnId);

  // 4. Pump events until the turn terminates.
  try {
    for await (const evt of parseDukkSseStream(
      eventsRes.body as AsyncIterable<Uint8Array | string>,
    )) {
      if (evt.type === 'turn_started' && evt.turn_id) {
        turnId = evt.turn_id;
        onSession?.(sessionId, turnId);
        continue;
      }
      if (evt.type === 'turn_completed') return { ok: true };
      if (evt.type === 'turn_cancelled') return { ok: false, error: 'canceled' };
      if (evt.type === 'turn_error') {
        return { ok: false, error: evt.error || 'dukk turn_error' };
      }
      const payload = dukkEventToAgentPayload(evt);
      if (payload) emit(payload);
    }
    // Stream closed without an explicit terminal event — treat as completed.
    return { ok: true };
  } catch (err) {
    if (signal.aborted) {
      // Best-effort: stop the server-side turn before surfacing the abort.
      await cancelDukkTurn(config, sessionId, turnId).catch(() => {});
      throw err;
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cancelDukkTurn(
  config: DukkConfig,
  sessionId: string,
  turnId: string | null,
): Promise<void> {
  if (!turnId) return;
  await fetch(`${config.baseUrl}/v1/sessions/${sessionId}/turns/${turnId}/cancel`, {
    method: 'POST',
    headers: authHeaders(config),
  }).catch(() => {});
}
