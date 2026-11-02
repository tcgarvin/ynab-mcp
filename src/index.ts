import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import {
  advertiseAcceptedAuthMethods,
  refuseDisallowedTokenRequest,
  TOKEN_PATH,
} from './auth/client-policy';
import { authHandler } from './auth/handler';
import { exchangeTokens } from './auth/token-exchange';
import { MCP_PATH, PUBLIC_ORIGIN, SCOPE_ACCESS, type Env } from './config';
import { mcpHandler } from './mcp/handler';

// No clientRegistrationEndpoint: registration lets anyone write to KV, and the allowed apps identify
// themselves with client metadata documents instead.
const provider = new OAuthProvider<Env>({
  apiRoute: MCP_PATH,
  apiHandler: mcpHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: TOKEN_PATH,
  scopesSupported: [SCOPE_ACCESS, 'offline_access'],
  requiredScopes: [SCOPE_ACCESS],
  resourceMetadata: {
    resource: `${PUBLIC_ORIGIN}${MCP_PATH}`,
    authorization_servers: [PUBLIC_ORIGIN],
    bearer_methods_supported: ['header'],
    resource_name: 'MCP Server for YNAB',
  },
  clientIdMetadataDocumentEnabled: true,
  tokenExchangeCallback: exchangeTokens,
});

export default {
  async fetch(request, env, ctx) {
    const refusal = await refuseDisallowedTokenRequest(request);
    if (refusal !== undefined) return refusal;
    return advertiseAcceptedAuthMethods(request, await provider.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
