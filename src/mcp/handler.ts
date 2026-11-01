import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { accessTokenPropsSchema } from '../auth/props';
import { isAllowedUser, MissingSettingsError, readSettings, SCOPE_ACCESS, type Env } from '../config';
import { YnabClient } from '../ynab/client';
import { buildMcpServer } from './server';

/**
 * Stateless MCP endpoint: every POST gets a fresh server and transport, so there are no sessions to
 * store and no Durable Objects to pay for. Standalone SSE (GET) is refused because this server
 * never sends unprompted messages.
 */
export const mcpHandler = {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    // OAuthProvider adds `auth` and `props` at runtime, but types apiHandler's context as plain.
    const ctx = executionContext as unknown as OAuthResourceContext<unknown>;
    if (!ctx.auth.scope.includes(SCOPE_ACCESS)) {
      return insufficientScope(ctx.auth, [SCOPE_ACCESS]);
    }

    const props = accessTokenPropsSchema.parse(ctx.props);
    // Checked on every request as well as at sign-in, so removing a user takes effect immediately.
    try {
      if (!isAllowedUser(readSettings(env), props.ynabUserId)) {
        return new Response('This YNAB account is not allowed on this server', { status: 403 });
      }
    } catch (error) {
      if (!(error instanceof MissingSettingsError)) throw error;
      console.error(error.message);
      return new Response(error.message, { status: 503 });
    }

    const server = buildMcpServer(new YnabClient(props.ynabAccessToken));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
