import { AuthorizationError } from '@cloudflare/workers-oauth-provider';

/**
 * Which apps may connect. This server has one owner, so naming their apps costs nothing, and it means
 * a phishing link can't send an authorization code to a site an attacker runs.
 *
 * Values are from https://claude.com/docs/connectors/building/authentication,
 * https://developers.openai.com/apps-sdk/build/auth and
 * https://learn.chatgpt.com/docs/extend/mcp. To connect another MCP client, add its metadata document
 * and redirect URI here.
 *
 * OpenAI's values are its stable ones, which it uses because this server returns `iss` in every
 * authorization response. Its per-connection `{callback_id}` URLs aren't needed, and allowing them
 * would need a pattern. Claude's hosted metadata URL isn't documented, so only its host can be named.
 */
const METADATA_DOCUMENT_HOSTS = new Set(['claude.ai', 'claude.com']);
const METADATA_DOCUMENT_URLS = new Set([
  'https://chatgpt.com/oauth/client.json',
  'https://chatgpt.com/oauth/codex/client.json',
]);
const HOSTED_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// The shape of ids from the /register endpoint this server used to offer. These are only looked up
// in KV, so connections made before it was removed keep working, and no new ones can appear.
const REGISTERED_CLIENT_ID = /^[A-Za-z0-9_-]+$/;

export const TOKEN_PATH = '/oauth/token';
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

export function isAllowedClientId(clientId: string): boolean {
  if (REGISTERED_CLIENT_ID.test(clientId) || METADATA_DOCUMENT_URLS.has(clientId)) return true;
  const url = parseUrl(clientId);
  return (
    url !== undefined &&
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    METADATA_DOCUMENT_HOSTS.has(url.hostname)
  );
}

export function isAllowedRedirectUri(redirectUri: string): boolean {
  if (HOSTED_REDIRECT_URIS.has(redirectUri)) return true;
  // Native apps listen on a port chosen at runtime, and only software on the user's own computer
  // can receive this redirect.
  const url = parseUrl(redirectUri);
  return url !== undefined && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Checked before the OAuth library sees the request, so a refused client_id is never fetched. Throws
 * without a redirect target, because a refused client's redirect URI isn't trusted.
 */
export function assertAllowedAuthorizeRequest(url: URL): void {
  const clientId = url.searchParams.get('client_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  if (!isAllowedClientId(clientId) || !isAllowedRedirectUri(redirectUri)) {
    throw new AuthorizationError('invalid_request', {
      description: 'This private server only accepts sign-ins from Claude and ChatGPT apps.',
    });
  }
}

function invalidClient(description: string): Response {
  return Response.json({ error: 'invalid_client', error_description: description }, { status: 401 });
}

/**
 * Refuses what this server's public clients never send, before the OAuth library acts on it. Without
 * this, anyone could publish a metadata document naming their own key and sign assertions against
 * it: the library verifies those and records each one in KV, spending the daily write limit, and
 * fetches any metadata URL it's given.
 *
 * Returns a response only when refusing. Malformed requests are left for the library to reject.
 */
export async function refuseDisallowedTokenRequest(request: Request): Promise<Response | undefined> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== TOKEN_PATH) return undefined;

  if (request.headers.get('Authorization')?.toLowerCase().startsWith('basic ')) {
    return invalidClient('Only public clients using PKCE are accepted.');
  }

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (form.has('client_assertion') || form.has('client_assertion_type')) {
    return invalidClient('Only public clients using PKCE are accepted.');
  }
  const clientIds = form.getAll('client_id').map(String);
  if (!clientIds.every((clientId) => clientId === '' || isAllowedClientId(clientId))) {
    return invalidClient('Client not found');
  }
  return undefined;
}

/**
 * Advertises only what refuseDisallowedTokenRequest accepts. The OAuth library also lists secrets and
 * private_key_jwt, and ChatGPT uses private_key_jwt whenever a server lists it, so it would never
 * reach the public client flow it also supports.
 */
export async function advertiseAcceptedAuthMethods(
  request: Request,
  response: Response,
): Promise<Response> {
  const isMetadata =
    request.method === 'GET' &&
    new URL(request.url).pathname === AUTHORIZATION_SERVER_METADATA_PATH &&
    response.ok;
  if (!isMetadata) return response;

  const metadata = (await response.json()) as Record<string, unknown>;
  delete metadata.token_endpoint_auth_signing_alg_values_supported;
  metadata.token_endpoint_auth_methods_supported = ['none'];
  return new Response(JSON.stringify(metadata), response);
}
