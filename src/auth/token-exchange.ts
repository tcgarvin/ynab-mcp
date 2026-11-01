import {
  GrantType,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import { MissingSettingsError, readSettings, type Env } from '../config';
import { refreshTokens, YnabTokenError } from '../ynab/oauth';
import { grantPropsSchema, type AccessTokenProps, type GrantProps } from './props';

/** Our tokens expire first, so clients refresh before the YNAB token underneath them dies. */
const EXPIRY_MARGIN_SECONDS = 300;
const MIN_ACCESS_TOKEN_TTL_SECONDS = 60;

function accessTokenResult(grant: GrantProps): TokenExchangeCallbackResult {
  const accessTokenProps: AccessTokenProps = {
    ynabUserId: grant.ynabUserId,
    ynabAccessToken: grant.ynabAccessToken,
  };
  const remaining = grant.ynabAccessTokenExpiresAt - Math.floor(Date.now() / 1000);
  return {
    accessTokenProps,
    accessTokenTTL: Math.max(remaining - EXPIRY_MARGIN_SECONDS, MIN_ACCESS_TOKEN_TTL_SECONDS),
  };
}

/** Keeps each client access token paired with a live YNAB token, refreshing YNAB when needed. */
export async function exchangeTokens(
  options: TokenExchangeCallbackOptions<Env>,
): Promise<TokenExchangeCallbackResult> {
  const grant = grantPropsSchema.parse(options.props);

  if (options.grantType === GrantType.AUTHORIZATION_CODE) {
    return accessTokenResult(grant);
  }
  if (options.grantType !== GrantType.REFRESH_TOKEN) {
    throw new OAuthError('unsupported_grant_type', {
      description: 'Only authorization_code and refresh_token are supported',
    });
  }

  try {
    const tokens = await refreshTokens(readSettings(options.env), grant.ynabRefreshToken);
    const refreshed: GrantProps = {
      ynabUserId: grant.ynabUserId,
      ynabAccessToken: tokens.accessToken,
      ynabRefreshToken: tokens.refreshToken,
      ynabAccessTokenExpiresAt: tokens.accessTokenExpiresAt,
    };
    return { ...accessTokenResult(refreshed), newProps: refreshed };
  } catch (error) {
    if (error instanceof MissingSettingsError) {
      console.error(error.message);
      // Temporary, so the grant survives until the setting is restored.
      throw new OAuthError('temporarily_unavailable', {
        description: error.message,
        statusCode: 503,
      });
    }
    if (!(error instanceof YnabTokenError)) throw error;
    // invalid_grant makes the library revoke this grant, so the client signs in again instead of
    // retrying forever. Anything else leaves the grant intact for a later retry.
    if (error.failure === 'revoked') {
      throw new OAuthError('invalid_grant', { description: 'YNAB access was revoked' });
    }
    throw new OAuthError('temporarily_unavailable', {
      description: 'YNAB is unavailable',
      statusCode: 503,
    });
  }
}
