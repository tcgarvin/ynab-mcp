import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export const PUBLIC_ORIGIN = 'https://ynab-mcp.tcgarvin.com';
export const MCP_PATH = '/mcp';
export const CALLBACK_PATH = '/callback';
/** Covers every tool: reading YNAB data and categorizing existing transactions. */
export const SCOPE_ACCESS = 'ynab:access';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  // Worker secrets, absent until set. Read them through readSettings().
  YNAB_CLIENT_ID?: string;
  YNAB_CLIENT_SECRET?: string;
  /** Comma-separated YNAB user ids allowed to sign in. */
  ALLOWED_YNAB_USER_IDS?: string;
}

export interface Settings {
  ynabClientId: string;
  ynabClientSecret: string;
  allowedYnabUserIds: string[];
}

/** Names the missing settings. Safe to show publicly, as it never includes setting values. */
export class MissingSettingsError extends Error {
  constructor(readonly settings: string[]) {
    super(
      `This server is missing required settings: ${settings.join(', ')}. ` +
        'Set each one with: npx wrangler secret put <NAME>',
    );
    this.name = 'MissingSettingsError';
  }
}

export function readSettings(env: Env): Settings {
  const ynabClientId = env.YNAB_CLIENT_ID?.trim() ?? '';
  const ynabClientSecret = env.YNAB_CLIENT_SECRET?.trim() ?? '';
  const allowedYnabUserIds = (env.ALLOWED_YNAB_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  const missing = [
    ...(ynabClientId === '' ? ['YNAB_CLIENT_ID'] : []),
    ...(ynabClientSecret === '' ? ['YNAB_CLIENT_SECRET'] : []),
    ...(allowedYnabUserIds.length === 0 ? ['ALLOWED_YNAB_USER_IDS'] : []),
  ];
  if (missing.length > 0) throw new MissingSettingsError(missing);

  return { ynabClientId, ynabClientSecret, allowedYnabUserIds };
}

export function isAllowedUser(settings: Settings, ynabUserId: string): boolean {
  return settings.allowedYnabUserIds.includes(ynabUserId);
}
