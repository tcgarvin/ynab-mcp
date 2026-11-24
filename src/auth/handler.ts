import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
} from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import {
  CALLBACK_PATH,
  isAllowedUser,
  MissingSettingsError,
  readSettings,
  SCOPE_ACCESS,
  type Env,
  type Settings,
} from '../config';
import { YnabClient } from '../ynab/client';
import { buildAuthorizeUrl, exchangeCode, YnabTokenError } from '../ynab/oauth';
import { assertAllowedAuthorizeRequest } from './client-policy';
import { consentPage, errorPage, landingPage, privacyPage } from './pages';
import type { GrantProps } from './props';
import { base64Url, beginTransaction, finishTransaction } from './sign-in-transaction';

interface UpstreamData {
  codeVerifier: string;
}

const ynabUserSchema = z.object({ data: z.object({ user: z.object({ id: z.string() }) }) });

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function redirect(location: string, headers: Headers): Response {
  headers.set('Location', location);
  return new Response(null, { status: 302, headers });
}

async function showConsent(request: Request, env: Env, settings: Settings): Promise<Response> {
  assertAllowedAuthorizeRequest(new URL(request.url));
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const { handle, cookie } = await beginTransaction(settings, 'consent', authRequest, {});
  return new Response(consentPage(details, handle), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}

async function submitConsent(request: Request, settings: Settings): Promise<Response> {
  const form = await request.formData();
  const consent = await finishTransaction<object>(
    settings,
    'consent',
    request,
    String(form.get('handle')),
  );
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', consent.clearCookie);

  if (form.get('decision') !== 'approve') {
    return redirect(authorizationErrorRedirect(consent.request, 'access_denied'), headers);
  }

  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const { handle, cookie } = await beginTransaction<UpstreamData>(
    settings,
    'upstream',
    { ...consent.request, scope: [SCOPE_ACCESS] },
    { codeVerifier },
  );
  headers.append('Set-Cookie', cookie);
  return redirect(buildAuthorizeUrl(settings, handle, await s256(codeVerifier)), headers);
}

async function handleCallback(request: Request, env: Env, settings: Settings): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const params = new URL(request.url).searchParams;
  const upstream = await finishTransaction<UpstreamData>(
    settings,
    'upstream',
    request,
    params.get('state') ?? '',
  );
  const { request: authRequest, data } = upstream;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', upstream.clearCookie);

  if (params.has('error')) {
    return redirect(authorizationErrorRedirect(authRequest, 'access_denied'), headers);
  }
  const code = params.get('code');
  if (code === null) {
    return errorPage(400, 'Sign-in failed', 'YNAB did not return an authorization code.');
  }

  const tokens = await exchangeCode(settings, code, data.codeVerifier);
  const { data: userData } = await new YnabClient(tokens.accessToken).get('/user', ynabUserSchema);
  const userId = userData.user.id;

  if (!isAllowedUser(settings, userId)) {
    // Showing the id is safe, since it's the visitor's own, and it's how the owner finds the value
    // to put in ALLOWED_YNAB_USER_IDS during setup.
    return errorPage(
      403,
      'Account not allowed',
      `This server is private. The YNAB account with user id ${userId} is not on its allowlist.`,
    );
  }

  const props: GrantProps = {
    ynabUserId: userId,
    ynabAccessToken: tokens.accessToken,
    ynabRefreshToken: tokens.refreshToken,
    ynabAccessTokenExpiresAt: tokens.accessTokenExpiresAt,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId,
    metadata: {},
    scope: [SCOPE_ACCESS],
    props,
  });
  return redirect(redirectTo, headers);
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (pathname === '/' && method === 'GET') return landingPage();
  if (pathname === '/privacy' && method === 'GET') return privacyPage();

  const isSignIn =
    (pathname === '/authorize' && (method === 'GET' || method === 'POST')) ||
    (pathname === CALLBACK_PATH && method === 'GET');
  if (!isSignIn) return errorPage(404, 'Not found', 'There is nothing at this address.');

  // Checked before the consent page, so setup problems appear before anyone is sent to YNAB.
  const settings = readSettings(env);
  if (pathname === CALLBACK_PATH) return handleCallback(request, env, settings);
  return method === 'GET' ? showConsent(request, env, settings) : submitConsent(request, settings);
}

/** Pages and sign-in. The OAuth library sends every other path here, except its own endpoints. */
export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof MissingSettingsError) {
        console.error(error.message);
        return errorPage(503, 'Server setup incomplete', error.message);
      }
      if (error instanceof AuthorizationError) {
        // redirectTo is set only once the client and its exact redirect URI have been validated.
        if (error.redirectTo !== undefined) return Response.redirect(error.redirectTo, 302);
        return errorPage(400, 'Sign-in failed', error.description);
      }
      if (error instanceof CimdFetchError) {
        return errorPage(400, 'Sign-in failed', 'This app could not be verified.');
      }
      if (error instanceof YnabTokenError) {
        console.error(error.message);
        return errorPage(502, 'Sign-in failed', 'YNAB could not complete the sign-in. Try again.');
      }
      throw error;
    }
  },
};
