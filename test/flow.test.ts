import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';

const { OAUTH_KV: kv } = env as unknown as Env;
const ORIGIN = 'https://ynab-mcp.tcgarvin.com';
const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLIENT_REDIRECT = 'http://localhost:3118/callback';
const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CODEX_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';

// Copied from what OpenAI serves at these URLs, since their shape decides how the OAuth library
// negotiates client authentication.
const OPENAI_METADATA_DOCUMENTS: Record<string, unknown> = {
  [CHATGPT_CLIENT_ID]: {
    client_id: CHATGPT_CLIENT_ID,
    client_uri: 'https://chatgpt.com/',
    redirect_uris: [CHATGPT_REDIRECT],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'ChatGPT',
    logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
    token_endpoint_auth_signing_alg: 'RS256',
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
  },
  [CODEX_CLIENT_ID]: {
    client_id: CODEX_CLIENT_ID,
    client_uri: 'https://chatgpt.com/codex',
    application_type: 'native',
    redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
    token_endpoint_auth_method: 'none',
    token_endpoint_auth_methods_supported: ['none'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Codex',
    logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
  },
};

interface YnabStubOptions {
  userId?: string;
  refreshError?: { status: number; error: string };
}

/** Stands in for YNAB, recording which access token each API call used. */
function stubYnab(options: YnabStubOptions = {}) {
  const apiTokens: string[] = [];
  const tokenGrants: string[] = [];
  const fetchedUrls: string[] = [];
  let issued = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      fetchedUrls.push(url.href);

      if (url.href === CLIENT_ID) {
        return Response.json({
          client_id: CLIENT_ID,
          client_name: 'Test <Client>',
          client_uri: 'https://claude.ai',
          redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
      }

      const openaiDocument = OPENAI_METADATA_DOCUMENTS[url.href];
      if (openaiDocument !== undefined) {
        return Response.json(openaiDocument);
      }

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
  return { apiTokens, tokenGrants, fetchedUrls };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

const CODE_VERIFIER = 'a'.repeat(64);

async function codeChallenge(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CODE_VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function openConsent(
  clientId = CLIENT_ID,
  redirectUri = CLIENT_REDIRECT,
  scope = 'ynab:access',
) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
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
async function signInAtYnab(clientId = CLIENT_ID, redirectUri = CLIENT_REDIRECT) {
  const consent = await openConsent(clientId, redirectUri);
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

async function signIn(requestedClientId = CLIENT_ID, redirectUri = CLIENT_REDIRECT) {
  const { clientId, callback } = await signInAtYnab(requestedClientId, redirectUri);
  const code = new URL(callback.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  const response = await requestToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
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
  stubYnab();
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
    const { html } = await openConsent();
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
    const consent = await openConsent();
    const response = await submitConsent('deny', consent.handle, consent.cookie);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(tokenGrants).toEqual([]);
  });

  it('refuses a consent submission without the browser cookie', async () => {
    const consent = await openConsent();
    const response = await submitConsent('approve', consent.handle, '');
    expect(response.status).toBe(400);
  });

  it('refuses a consent cookie presented at the YNAB callback', async () => {
    const consent = await openConsent();
    const response = await SELF.fetch(`${ORIGIN}/callback?code=c&state=${consent.handle}`, {
      headers: { Cookie: consent.cookie },
    });
    expect(response.status).toBe(400);
  });

  it('keeps the consent page out of frames and caches', async () => {
    const { response } = await openConsent();
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('clears the transaction cookie after approval and after the callback', async () => {
    stubYnab();
    const consent = await openConsent();
    const toYnab = await submitConsent('approve', consent.handle, consent.cookie);
    const consentName = consent.cookie.split('=')[0];
    expect(toYnab.headers.getSetCookie()).toContainEqual(expect.stringMatching(`^${consentName}=;`));

    const { callback } = await signInAtYnab();
    expect(callback.headers.getSetCookie()).toContainEqual(expect.stringContaining('Max-Age=0'));
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

describe('which clients can connect', () => {
  const EVIL_REDIRECT = 'https://evil.example/callback';
  const EVIL_CLIENT = 'https://evil.example/client-metadata';

  it('offers no client registration', async () => {
    const response = await SELF.fetch(`${ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [EVIL_REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    expect(response.status).toBe(404);
  });

  it('advertises what apps need to choose client metadata documents', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.registration_endpoint).toBeUndefined();
  });

  it('advertises only the public client flow, so ChatGPT does not choose private_key_jwt', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.token_endpoint_auth_signing_alg_values_supported).toBeUndefined();
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('meets what OpenAI requires for its stable URLs', async () => {
    const authorizationServer = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const body = (await authorizationServer.json()) as Record<string, unknown>;
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.issuer).toBe(ORIGIN);

    const resource = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    const { authorization_servers: servers } = (await resource.json()) as {
      authorization_servers: string[];
    };
    expect(servers).toEqual([body.issuer]);
  });

  describe.each([
    ['ChatGPT', CHATGPT_CLIENT_ID, CHATGPT_REDIRECT],
    ['Codex', CODEX_CLIENT_ID, 'http://127.0.0.1:5555/callback'],
  ])('%s', (name, clientId, redirectUri) => {
    it('names itself on the consent page, for the scopes it requests', async () => {
      const { response, html } = await openConsent(
        clientId,
        redirectUri,
        'ynab:access offline_access',
      );
      expect(response.status).toBe(200);
      expect(html).toContain(`Allow ${name} to access`);
    });

    it('receives the code with the issuer it checks', async () => {
      const { callback } = await signInAtYnab(clientId, redirectUri);
      const location = new URL(callback.headers.get('Location') ?? '');
      expect(location.origin + location.pathname).toBe(redirectUri);
      expect(location.searchParams.get('iss')).toBe(ORIGIN);
      expect(location.searchParams.get('state')).toBe('client-state');
      expect(location.searchParams.has('code')).toBe(true);
    });

    it('receives the issuer when the user denies', async () => {
      const consent = await openConsent(clientId, redirectUri);
      const response = await submitConsent('deny', consent.handle, consent.cookie);
      const location = new URL(response.headers.get('Location') ?? '');
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('iss')).toBe(ORIGIN);
    });

    it('must use PKCE, and receives the issuer when refused for not using it', async () => {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'ynab:access',
        state: 'client-state',
        resource: `${ORIGIN}/mcp`,
      });
      const response = await SELF.fetch(`${ORIGIN}/authorize?${params}`, { redirect: 'manual' });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('Location') ?? '');
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('iss')).toBe(ORIGIN);
    });

    it('signs in as a public client, calls a tool, and refreshes', async () => {
      const { apiTokens, fetchedUrls } = stubYnab();
      const { tokens } = await signIn(clientId, redirectUri);
      await mcp(tokens.access_token, 'tools/call', { name: 'list_plans', arguments: {} });
      expect(apiTokens.at(-1)).toBe('Bearer ynab-access-1');

      const refreshed = await requestToken({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      });
      expect(refreshed.status).toBe(200);
      expect(fetchedUrls).not.toContain('https://chatgpt.com/oauth/jwks.json');
    });

    it('writes nothing for a visitor who is not on the allowlist', async () => {
      stubYnab({ userId: 'stranger' });
      const before = (await kv.list()).keys;
      const { callback } = await signInAtYnab(clientId, redirectUri);
      expect(callback.status).toBe(403);
      expect((await kv.list()).keys).toEqual(before);
    });

    it('refuses a client assertion, even naming this client', async () => {
      const { fetchedUrls } = stubYnab();
      const response = await requestToken({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: 'c',
        client_assertion: 'x.y.z',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      });
      expect(response.status).toBe(401);
      expect(fetchedUrls).toEqual([]);
    });
  });

  it.each([
    ['a redirect to another site', CLIENT_ID, EVIL_REDIRECT],
    ['a lookalike of the Claude callback', CLIENT_ID, 'https://claude.ai.evil.example/api/mcp/auth_callback'],
    ['remote http', CLIENT_ID, 'http://evil.example/callback'],
    ['a metadata document on another site', EVIL_CLIENT, CLIENT_REDIRECT],
    ['a metadata document on a lookalike host', 'https://claude.ai.evil.example/client', CLIENT_REDIRECT],
    ['a metadata document over http', 'http://claude.ai/client', CLIENT_REDIRECT],
    ['a metadata URL with userinfo', 'https://claude.ai@evil.example/client', CLIENT_REDIRECT],
    ['an unlisted metadata document on ChatGPT', 'https://chatgpt.com/oauth/abc/client.json', CHATGPT_REDIRECT],
    ['a ChatGPT metadata URL with a query', `${CHATGPT_CLIENT_ID}?x=1`, CHATGPT_REDIRECT],
    ['a metadata document on a ChatGPT lookalike', 'https://chatgpt.com.evil.example/oauth/client.json', CHATGPT_REDIRECT],
    ['an unlisted ChatGPT callback', CHATGPT_CLIENT_ID, 'https://chatgpt.com/connector/oauth/abc'],
    ['a lookalike of the ChatGPT callback', CHATGPT_CLIENT_ID, 'https://chatgpt.com.evil.example/connector_platform_oauth_redirect'],
    ['another site as ChatGPT\'s callback', CHATGPT_CLIENT_ID, EVIL_REDIRECT],
  ])('refuses %s without fetching or redirecting', async (_name, clientId, redirectUri) => {
    const { fetchedUrls } = stubYnab();
    const { response } = await openConsent(clientId, redirectUri);
    expect(response.status).toBe(400);
    expect(response.headers.has('Location')).toBe(false);
    expect(fetchedUrls).toEqual([]);
  });

  it('still shows consent to a client registered before registration was removed', async () => {
    await kv.put(
      'client:legacy-client',
      JSON.stringify({
        clientId: 'legacy-client',
        clientName: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback', EVIL_REDIRECT],
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        tokenEndpointAuthMethod: 'none',
      }),
    );
    const allowed = await openConsent('legacy-client', 'https://claude.ai/api/mcp/auth_callback');
    expect(allowed.response.status).toBe(200);
    const refused = await openConsent('legacy-client', EVIL_REDIRECT);
    expect(refused.response.status).toBe(400);
  });

  it('completes sign-in on a loopback port the metadata document does not name', async () => {
    const { callback } = await signInAtYnab(CLIENT_ID, 'http://127.0.0.1:53111/callback');
    const location = new URL(callback.headers.get('Location') ?? '');
    expect(location.origin).toBe('http://127.0.0.1:53111');
    expect(location.searchParams.has('code')).toBe(true);
  });

  it.each([
    ['a client assertion', { client_assertion: 'x.y.z', client_assertion_type: 'jwt-bearer' }, {}],
    ['only an assertion type', { client_assertion_type: 'jwt-bearer' }, {}],
    ['a foreign metadata URL', { client_id: EVIL_CLIENT }, {}],
    ['Basic authentication', {}, { Authorization: `Basic ${btoa(`${EVIL_CLIENT}:secret`)}` }],
  ])('refuses %s at the token endpoint without fetching', async (_name, fields, headers) => {
    const { fetchedUrls } = stubYnab();
    const response = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c', ...fields }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client');
    expect(fetchedUrls).toEqual([]);
  });
});

describe('KV writes', () => {
  async function kvKeys(): Promise<string[]> {
    return (await kv.list()).keys.map((key) => key.name);
  }

  it('writes nothing for a visitor who is not on the allowlist, at any step', async () => {
    stubYnab({ userId: 'stranger' });
    const before = await kvKeys();

    const consent = await openConsent();
    expect(consent.response.status).toBe(200);
    expect(await kvKeys()).toEqual(before);

    const denied = await openConsent();
    await submitConsent('deny', denied.handle, denied.cookie);
    expect(await kvKeys()).toEqual(before);

    const { callback } = await signInAtYnab();
    expect(callback.status).toBe(403);
    expect(await kvKeys()).toEqual(before);
  });

  it('writes the grant once an allowed user has signed in', async () => {
    const before = await kvKeys();
    await signInAtYnab();
    const added = (await kvKeys()).filter((key) => !before.includes(key));
    expect(added).toEqual([expect.stringMatching(/^grant:allowed-user:/)]);
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
