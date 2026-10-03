import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolved connection profile for the dukk engine (dukk-server local or the
// api.dukk.com.br SaaS). The daemon reaches the engine over HTTP/SSE, so all
// it needs is a base URL, a bearer token, and the execution environment to
// request when creating a session.
export type DukkConfig = {
  profile: 'local' | 'remote';
  baseUrl: string;
  token: string | null;
  // Session execution environment requested on POST /v1/sessions. Local
  // dukk-server runs on the same host (shared filesystem) so `local` is the
  // natural default; the SaaS blocks `local` in production and needs
  // `sandbox` instead (wired in phase 2).
  environment: 'local' | 'sandbox';
  // Permission posture for the engine's own tool loop. The daemon runs
  // head-less, so we mirror the bypass posture other non-interactive adapters
  // use (Qoder `bypass_permissions`, Claude `bypassPermissions`).
  permissionMode: string;
};

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_REMOTE_BASE_URL = 'https://api.dukk.com.br';

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// dukk-server writes its bearer to `~/.dukk/server-token` (dukk-core
// crates/server/src/main.rs `default_token_path`). The elai→dukk rename
// migrated the legacy `~/.elai/server-token` one-shot, but a host that never
// ran the migration may still only have the legacy file — try it as a
// fallback so a fresh daemon checkout works against an older engine.
function readLocalTokenFile(env: EnvLike): string | null {
  const explicit = env.DUKK_TOKEN_FILE;
  const candidates = explicit
    ? [explicit]
    : [
        path.join(os.homedir(), '.dukk', 'server-token'),
        path.join(os.homedir(), '.elai', 'server-token'),
      ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw) return raw;
    } catch {
      // Missing/unreadable token file is expected when the engine isn't
      // running locally; fall through to the next candidate.
    }
  }
  return null;
}

// Resolve the dukk connection profile from the daemon process environment.
//   DUKK_PROFILE   'local' (default) | 'remote'
//   DUKK_BASE_URL  override base URL for either profile
//   DUKK_TOKEN     explicit bearer (wins over the local token file; the only
//                  way to supply the SaaS Clerk JWT until the connector flow
//                  lands in phase 2)
//   DUKK_TOKEN_FILE  override the local token file path
//   DUKK_ENVIRONMENT 'local' (default) | 'sandbox'
//   DUKK_PERMISSION_MODE  override the engine permission posture
export function resolveDukkConfig(env: EnvLike = process.env): DukkConfig {
  const profile = env.DUKK_PROFILE === 'remote' ? 'remote' : 'local';
  const baseUrl = stripTrailingSlash(
    env.DUKK_BASE_URL ||
      (profile === 'remote' ? DEFAULT_REMOTE_BASE_URL : DEFAULT_LOCAL_BASE_URL),
  );
  const token =
    (typeof env.DUKK_TOKEN === 'string' && env.DUKK_TOKEN.trim()
      ? env.DUKK_TOKEN.trim()
      : null) ?? (profile === 'local' ? readLocalTokenFile(env) : null);
  const environment =
    env.DUKK_ENVIRONMENT === 'sandbox'
      ? 'sandbox'
      : profile === 'remote'
        ? 'sandbox'
        : 'local';
  const permissionMode =
    typeof env.DUKK_PERMISSION_MODE === 'string' && env.DUKK_PERMISSION_MODE
      ? env.DUKK_PERMISSION_MODE
      : 'danger-full-access';
  return { profile, baseUrl, token, environment, permissionMode };
}

// Optional per-turn default model id (DUKK_MODEL / ELAI_MODEL mirror the
// engine's own env precedence). Returned only when the user didn't pick one.
export function resolveDukkDefaultModel(env: EnvLike = process.env): string | null {
  const raw = env.DUKK_MODEL || env.ELAI_MODEL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
