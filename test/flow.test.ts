import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://ynab-mcp.tcgarvin.com';
const CLIENT_REDIRECT = 'https://client.example/callback';

interface YnabStubOptions {
  userId?: string;
  refreshError?: { status: number; error: string };
}

/** Stands in for YNAB, recording which access token each API call used. */
function stubYnab(options: YnabStubOptions = {}) {
  const apiTokens: string[] = [];
  const tokenGrants: string[] = [];
  let issued = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.href === 'https://app.ynab.com/oauth/token') {
        const form = await request.formData();
        const grant = String(form.get('grant_type'));
        tokenGrants.push(grant);
        if (grant === 'refresh_token' && options.refreshError !== undefined) {
          const { status, error } = options.refreshError;
          return Response.json({ error }, { status });
        }
        issued += 1;
        return Response.json({
          access_token: `ynab-access-${issued}`,
          refresh_token: `ynab-refresh-${issued}`,
          token_type: 'bearer',
          expires_in: 7200,
        });
      }

      apiTokens.push(request.headers.get('Authorization') ?? '');
      if (url.pathname === '/v1/user') {
        return Response.json({ data: { user: { id: options.userId ?? 'allowed-user' } } });
      }
      if (url.pathname === '/v1/plans') {
        return Response.json({ data: { plans: [{ id: 'plan-1', name: 'Home' }] } });
      }
      if (request.method === 'PATCH') {
        const body = (await request.json()) as {
          transactions: { id: string; category_id: string; approved: boolean }[];
        };
        return Response.json({
          data: {
            transactions: body.transactions.map((item) => ({ ...item, category_name: 'Food' })),
          },
        });
      }
      return Response.json({ error: { id: '404', name: 'not_found', detail: 'nope' } }, { status: 404 });
    }),
  );
  return { apiTokens, tokenGrants };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

async function registerClient(): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test <Client>',
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

const CODE_VERIFIER = 'a'.repeat(64);

async function codeChallenge(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CODE_VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function openConsent(clientId: string) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    scope: 'ynab:access',
    state: 'client-state',
    code_challenge: await codeChallenge(),
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  });
  const response = await SELF.fetch(`${ORIGIN}/authorize?${params}`);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { response, html, handle, cookie: cookieHeader(response) };
}

function submitConsent(decision: string, handle: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle, decision }),
  });
}

/** Runs the browser part of sign-in, stopping at the redirect back from YNAB. */
async function signInAtYnab() {
  const clientId = await registerClient();
  const consent = await openConsent(clientId);
  const toYnab = await submitConsent('approve', consent.handle, consent.cookie);
  expect(toYnab.status).toBe(302);
  const ynabUrl = new URL(toYnab.headers.get('Location') ?? '');
  const callback = await SELF.fetch(
    `${ORIGIN}/callback?code=ynab-code&state=${ynabUrl.searchParams.get('state')}`,
    { redirect: 'manual', headers: { Cookie: cookieHeader(toYnab) } },
  );
  return { clientId, ynabUrl, callback };
}

async function requestToken(fields: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ resource: `${ORIGIN}/mcp`, ...fields }),
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function signIn() {
  const { clientId, callback } = await signInAtYnab();
  const code = new URL(callback.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  const response = await requestToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: CLIENT_REDIRECT,
    code_verifier: CODE_VERIFIER,
  });
  expect(response.status).toBe(200);
  return { clientId, tokens: (await response.json()) as TokenResponse };
}

function mcp(accessToken: string, method: string, params: unknown = {}) {
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discovery', () => {
  it('challenges unauthenticated MCP requests with resource metadata', async () => {
    const response = await SELF.fetch(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
  });

  it('publishes protected resource metadata', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
  });
});

describe('sign-in', () => {
  it('escapes the client name on the consent page', async () => {
    const { html } = await openConsent(await registerClient());
    expect(html).not.toContain('Test <Client>');
    expect(html).toContain('Test &#60;Client&#62;');
  });

  it('asks YNAB for write access with PKCE', async () => {
    stubYnab();
    const { ynabUrl } = await signInAtYnab();
    expect(ynabUrl.origin + ynabUrl.pathname).toBe('https://app.ynab.com/oauth/authorize');
    expect(ynabUrl.searchParams.has('scope')).toBe(false);
    expect(ynabUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(ynabUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
  });

  it('never contacts YNAB when the user denies', async () => {
    const { tokenGrants } = stubYnab();
    const consent = await openConsent(await registerClient());
    const response = await submitConsent('deny', consent.handle, consent.cookie);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(tokenGrants).toEqual([]);
  });

  it('refuses a consent submission without the browser cookie', async () => {
    const consent = await openConsent(await registerClient());
    const response = await submitConsent('approve', consent.handle, '');
    expect(response.status).toBe(400);
  });

  it('refuses YNAB accounts that are not on the allowlist, and shows their id', async () => {
    stubYnab({ userId: 'stranger' });
    const { callback } = await signInAtYnab();
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain('stranger');
  });

  it('never gives YNAB tokens to the MCP client', async () => {
    stubYnab();
    const { tokens } = await signIn();
    expect(JSON.stringify(tokens)).not.toContain('ynab-access');
    expect(JSON.stringify(tokens)).not.toContain('ynab-refresh');
  });

  it('expires client tokens before the YNAB token', async () => {
    stubYnab();
    const { tokens } = await signIn();
    expect(tokens.expires_in).toBeLessThanOrEqual(6900);
  });
});

describe('MCP endpoint', () => {
  it('marks only the categorize and annotate tools as writing', async () => {
    stubYnab();
    const { tokens } = await signIn();
    const response = await mcp(tokens.access_token, 'tools/list');
    const body = (await response.json()) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      'annotate_transactions',
      'categorize_transactions',
      'get_month',
      'get_payee_history',
      'list_accounts',
      'list_payees',
      'list_plans',
      'list_scheduled_transactions',
      'list_transactions',
    ]);
    const writing = body.result.tools.filter((tool) => !tool.annotations.readOnlyHint);
    expect(writing.map((tool) => tool.name).sort()).toEqual([
      'annotate_transactions',
      'categorize_transactions',
    ]);
  });

  it('answers initialize', async () => {
    stubYnab();
    const { tokens } = await signIn();
    const response = await mcp(tokens.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('ynab-mcp');
  });

  it('tells agents about the request, date range, data, and UTC limits', async () => {
    stubYnab();
    const { tokens } = await signIn();
    const response = await mcp(tokens.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const body = (await response.json()) as { result: { instructions: string } };
    for (const limit of ['200 requests per rolling hour', 'at most 30 days', '1 MB', 'UTC']) {
      expect(body.result.instructions).toContain(limit);
    }
  });

  it('calls YNAB with the stored token', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'list_plans',
      arguments: {},
    });
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0]?.text ?? '')).toEqual([
      { id: 'plan-1', name: 'Home', currency: null, last_modified_on: null },
    ]);
    expect(apiTokens.at(-1)).toBe('Bearer ynab-access-1');
  });

  it('reports YNAB failures as tool errors', async () => {
    stubYnab();
    const { tokens } = await signIn();
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'list_payees',
      arguments: {},
    });
    const body = (await response.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain('nope');
  });

  it('rejects ids that could alter the YNAB path', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const callsBefore = apiTokens.length;
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'list_payees',
      arguments: { plan_id: '../../user' },
    });
    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(apiTokens.length).toBe(callsBefore);
  });

  it('categorizes through the MCP endpoint', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'categorize_transactions',
      arguments: {
        categorizations: [{ transaction_id: 't1', category_id: 'food', approved: true }],
      },
    });
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0]?.text ?? '')).toMatchObject({ updated_count: 1 });
    expect(apiTokens.at(-1)).toBe('Bearer ynab-access-1');
  });

  it('refuses the same transaction twice in one call', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const callsBefore = apiTokens.length;
    const item = { transaction_id: 't1', category_id: 'food', approved: true };
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'categorize_transactions',
      arguments: { categorizations: [item, item] },
    });
    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(apiTokens.length).toBe(callsBefore);
  });

  it('refuses a long transaction range without calling YNAB', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const callsBefore = apiTokens.length;
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'list_transactions',
      arguments: { since_date: '2020-01-01', account_id: 'checking' },
    });
    const body = (await response.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain('narrow it');
    expect(apiTokens.length).toBe(callsBefore);
  });

  it('refuses more than ten payees in one history call', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const callsBefore = apiTokens.length;
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'get_payee_history',
      arguments: { payee_ids: Array.from({ length: 11 }, (_, index) => `p${index}`) },
    });
    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(apiTokens.length).toBe(callsBefore);
  });

  it('refuses an annotation that changes nothing', async () => {
    const { apiTokens } = stubYnab();
    const { tokens } = await signIn();
    const callsBefore = apiTokens.length;
    const response = await mcp(tokens.access_token, 'tools/call', {
      name: 'annotate_transactions',
      arguments: { annotations: [{ transaction_id: 't1', approved: true }] },
    });
    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(apiTokens.length).toBe(callsBefore);
  });

  it('refuses GET', async () => {
    stubYnab();
    const { tokens } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(response.status).toBe(405);
  });

  it('refuses an invalid bearer token', async () => {
    const response = await mcp('not-a-real-token', 'tools/list');
    expect(response.status).toBe(401);
  });
});

describe('token refresh', () => {
  it('refreshes YNAB and uses the new token', async () => {
    const { apiTokens, tokenGrants } = stubYnab();
    const { clientId, tokens } = await signIn();

    const response = await requestToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    expect(response.status).toBe(200);
    const refreshed = (await response.json()) as TokenResponse;

    expect(tokenGrants).toEqual(['authorization_code', 'refresh_token']);
    await mcp(refreshed.access_token, 'tools/call', { name: 'list_plans', arguments: {} });
    expect(apiTokens.at(-1)).toBe('Bearer ynab-access-2');
  });

  it('revokes the grant when YNAB says access is gone', async () => {
    stubYnab({ refreshError: { status: 400, error: 'invalid_grant' } });
    const { clientId, tokens } = await signIn();

    const response = await requestToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('keeps the grant through a temporary YNAB failure', async () => {
    const stub = { status: 500, error: 'server_error' };
    stubYnab({ refreshError: stub });
    const { clientId, tokens } = await signIn();

    const response = await requestToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('temporarily_unavailable');
  });
});

describe('public pages', () => {
  it.each(['/', '/privacy'])('%s carries the required YNAB disclaimer', async (path) => {
    const response = await SELF.fetch(`${ORIGIN}${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('not affiliated');
  });

  it('privacy policy states when it was last updated', async () => {
    const response = await SELF.fetch(`${ORIGIN}/privacy`);
    expect(await response.text()).toContain('Last updated');
  });
});
