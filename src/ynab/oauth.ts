import { z } from 'zod';
import { CALLBACK_PATH, PUBLIC_ORIGIN, type Settings } from '../config';

const AUTHORIZE_URL = 'https://app.ynab.com/oauth/authorize';
const TOKEN_URL = 'https://app.ynab.com/oauth/token';
const REDIRECT_URI = `${PUBLIC_ORIGIN}${CALLBACK_PATH}`;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const tokenErrorSchema = z.object({ error: z.string() });

export interface YnabTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  accessTokenExpiresAt: number;
}

/** `revoked` means the grant can never work again; `unavailable` may succeed on retry. */
export type YnabTokenFailure = 'revoked' | 'unavailable';

export class YnabTokenError extends Error {
  constructor(
    readonly failure: YnabTokenFailure,
    message: string,
  ) {
    super(message);
    this.name = 'YnabTokenError';
  }
}

export function buildAuthorizeUrl(
  settings: Settings,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    client_id: settings.ynabClientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params}`;
}

export function exchangeCode(
  settings: Settings,
  code: string,
  codeVerifier: string,
): Promise<YnabTokens> {
  return requestTokens(settings, {
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
  });
}

export function refreshTokens(settings: Settings, refreshToken: string): Promise<YnabTokens> {
  return requestTokens(settings, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function requestTokens(
  settings: Settings,
  grant: Record<string, string>,
): Promise<YnabTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.ynabClientId,
      client_secret: settings.ynabClientSecret,
      ...grant,
    }),
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = tokenErrorSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error : 'unknown_error';
    const failure: YnabTokenFailure = code === 'invalid_grant' ? 'revoked' : 'unavailable';
    throw new YnabTokenError(failure, `YNAB token request failed: ${response.status} ${code}`);
  }

  const tokens = tokenResponseSchema.safeParse(body);
  if (!tokens.success) {
    // Deliberately omits the body, which may contain tokens.
    throw new YnabTokenError('unavailable', 'YNAB token response had an unexpected shape');
  }
  return {
    accessToken: tokens.data.access_token,
    refreshToken: tokens.data.refresh_token,
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + tokens.data.expires_in,
  };
}
