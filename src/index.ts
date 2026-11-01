import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { authHandler } from './auth/handler';
import { exchangeTokens } from './auth/token-exchange';
import { MCP_PATH, PUBLIC_ORIGIN, SCOPE_ACCESS, type Env } from './config';
import { mcpHandler } from './mcp/handler';

export default new OAuthProvider<Env>({
  apiRoute: MCP_PATH,
  apiHandler: mcpHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/register',
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
