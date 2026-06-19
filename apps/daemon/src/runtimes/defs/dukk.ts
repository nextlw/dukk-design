import { DEFAULT_MODEL_OPTION } from './shared.js';
import { resolveDukkConfig } from '../../dukk-config.js';
import { fetchDukkModels } from '../../dukk-http.js';
import type { RuntimeAgentDef, RuntimeEnv } from '../types.js';

// Static model hints shown when the engine's /v1/opencode/models catalog can't
// be reached (offline detection, token missing). These mirror the providers
// dukk-server fronts; `default` lets the engine's own config pick.
const DUKK_FALLBACK_MODELS = [
  DEFAULT_MODEL_OPTION,
  { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { id: 'claude-opus-4-6', label: 'claude-opus-4-6' },
  { id: 'gpt-4o', label: 'gpt-4o' },
];

// The dukk engine is an HTTP/SSE server (dukk-server local or api.dukk.com.br),
// NOT a local CLI. `transport: 'http'` routes detection and the chat run
// through the daemon's HTTP path (dukk-http.ts) instead of PATH-scan + spawn.
// `bin` / `versionArgs` / `buildArgs` are declared only to satisfy the shared
// RuntimeAgentDef type; they are never resolved or spawned for http transports.
export const dukkAgentDef = {
  id: 'dukk',
  name: 'Dukk',
  transport: 'http',
  bin: 'dukk',
  versionArgs: ['--version'],
  fallbackModels: DUKK_FALLBACK_MODELS,
  // Detection ignores `resolvedBin` for http transports and queries the engine
  // catalog directly. Falls back to the static hints when unreachable.
  fetchModels: async (_resolvedBin: string, env: RuntimeEnv) =>
    fetchDukkModels(resolveDukkConfig(env as NodeJS.ProcessEnv)),
  buildArgs: () => [],
  // Marker only — the http path returns before the spawn-time streamFormat
  // dispatch in server.ts, so no stream handler is registered for it.
  streamFormat: 'dukk-sse',
  docsUrl: 'https://api.dukk.com.br',
} satisfies RuntimeAgentDef;
