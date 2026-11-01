import { GrantType, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { authHandler } from '../src/auth/handler';
import { exchangeTokens } from '../src/auth/token-exchange';
import { isAllowedUser, MissingSettingsError, readSettings, type Env } from '../src/config';
import { mcpHandler } from '../src/mcp/handler';

const ORIGIN = 'https://ynab-mcp.tcgarvin.com';
const ALL_NAMES = ['YNAB_CLIENT_ID', 'YNAB_CLIENT_SECRET', 'ALLOWED_YNAB_USER_IDS'];

function envWith(values: Partial<Env>): Env {
  return values as Env;
}

const complete = {
  YNAB_CLIENT_ID: 'id-value',
  YNAB_CLIENT_SECRET: 'secret-value',
  ALLOWED_YNAB_USER_IDS: 'user-1, user-2',
};

afterEach(() => vi.unstubAllGlobals());

describe('readSettings', () => {
  it('reads complete settings and splits the allowlist', () => {
    expect(readSettings(envWith(complete))).toEqual({
      ynabClientId: 'id-value',
      ynabClientSecret: 'secret-value',
      allowedYnabUserIds: ['user-1', 'user-2'],
    });
  });

  it('names every missing setting', () => {
    expect(() => readSettings(envWith({}))).toThrow(MissingSettingsError);
    try {
      readSettings(envWith({}));
    } catch (error) {
      expect((error as MissingSettingsError).settings).toEqual(ALL_NAMES);
    }
  });

  it('names only the missing setting, and never a present value', () => {
    const { YNAB_CLIENT_SECRET: _omitted, ...rest } = complete;
    expect(() => readSettings(envWith(rest))).toThrow(/settings: YNAB_CLIENT_SECRET\./);
    try {
      readSettings(envWith(rest));
    } catch (error) {
      expect((error as Error).message).not.toContain('id-value');
      expect((error as Error).message).not.toContain('user-1');
    }
  });

  it('treats blank values as missing', () => {
    expect(() => readSettings(envWith({ ...complete, ALLOWED_YNAB_USER_IDS: ' , ' }))).toThrow(
      /ALLOWED_YNAB_USER_IDS/,
    );
  });
});

describe('isAllowedUser', () => {
  it('matches only listed ids', () => {
    const settings = readSettings(envWith(complete));
    expect(isAllowedUser(settings, 'user-2')).toBe(true);
    expect(isAllowedUser(settings, 'someone-else')).toBe(false);
  });
});

describe('when settings are missing', () => {
  it.each([
    ['GET', '/authorize?client_id=x'],
    ['POST', '/authorize'],
    ['GET', '/callback?code=x&state=y'],
  ])('%s %s explains what is missing', async (method, path) => {
    const response = await authHandler.fetch(
      new Request(`${ORIGIN}${path}`, { method }),
      envWith({}),
    );
    const html = await response.text();
    expect(response.status).toBe(503);
    for (const name of ALL_NAMES) expect(html).toContain(name);
  });

  it('never contacts YNAB', async () => {
    const stub = vi.fn();
    vi.stubGlobal('fetch', stub);
    await authHandler.fetch(new Request(`${ORIGIN}/callback?code=x&state=y`), envWith({}));
    expect(stub).not.toHaveBeenCalled();
  });

  it.each(['/', '/privacy'])('%s still works', async (path) => {
    const response = await authHandler.fetch(new Request(`${ORIGIN}${path}`), envWith({}));
    expect(response.status).toBe(200);
  });

  it('still answers 404 for unknown paths', async () => {
    const response = await authHandler.fetch(new Request(`${ORIGIN}/nope`), envWith({}));
    expect(response.status).toBe(404);
  });

  it('the MCP endpoint explains what is missing', async () => {
    const context = {
      auth: { scope: ['ynab:access'] },
      props: { ynabUserId: 'user-1', ynabAccessToken: 'token' },
    } as unknown as OAuthResourceContext<unknown> & ExecutionContext;
    const response = await mcpHandler.fetch(
      new Request(`${ORIGIN}/mcp`, { method: 'POST' }),
      envWith({}),
      context,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('ALLOWED_YNAB_USER_IDS');
  });

  it('token refresh fails as temporary, keeping the grant', async () => {
    const options = {
      grantType: GrantType.REFRESH_TOKEN,
      env: envWith({}),
      props: {
        ynabUserId: 'user-1',
        ynabAccessToken: 'a',
        ynabRefreshToken: 'r',
        ynabAccessTokenExpiresAt: 0,
      },
    } as Parameters<typeof exchangeTokens>[0];
    await expect(exchangeTokens(options)).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 503,
    });
  });
});
