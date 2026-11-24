import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginTransaction, finishTransaction } from '../src/auth/sign-in-transaction';
import type { Settings } from '../src/config';

const SETTINGS: Settings = {
  ynabClientId: 'id',
  ynabClientSecret: 'secret',
  allowedYnabUserIds: ['user'],
};
const AUTH_REQUEST: AuthRequest = {
  responseType: 'code',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  redirectUri: 'http://localhost:3118/callback',
  scope: ['ynab:access'],
  state: 'client-state',
};
const DATA = { codeVerifier: 'verifier' };

function requestWithCookie(cookie: string): Request {
  return new Request('https://ynab-mcp.tcgarvin.com/callback', {
    headers: { Cookie: cookie.split(';')[0] ?? '' },
  });
}

function begin() {
  return beginTransaction(SETTINGS, 'upstream', AUTH_REQUEST, DATA);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sign-in transactions', () => {
  it('returns what was sealed, and a header that clears the cookie', async () => {
    const { handle, cookie } = await begin();
    const opened = await finishTransaction(SETTINGS, 'upstream', requestWithCookie(cookie), handle);
    expect(opened.request).toEqual(AUTH_REQUEST);
    expect(opened.data).toEqual(DATA);
    expect(opened.clearCookie).toContain('Max-Age=0');
  });

  it('sets a cookie only this host can read back over HTTPS', async () => {
    const { cookie } = await begin();
    expect(cookie).toMatch(/^__Host-ynab-upstream-/);
    expect(cookie).toContain('; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
  });

  it('keeps the contents out of the cookie text', async () => {
    const { cookie } = await begin();
    const value = cookie.split(';')[0]?.split('=')[1] ?? '';
    const decoded = atob((value.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/'));
    expect(decoded).not.toContain('verifier');
    expect(cookie).not.toContain('verifier');
  });

  it('refuses a request without the cookie', async () => {
    const { handle } = await begin();
    await expect(
      finishTransaction(SETTINGS, 'upstream', requestWithCookie(''), handle),
    ).rejects.toThrow(/not started in this browser/);
  });

  it('refuses another transaction’s handle', async () => {
    const first = await begin();
    const second = await begin();
    await expect(
      finishTransaction(SETTINGS, 'upstream', requestWithCookie(first.cookie), second.handle),
    ).rejects.toThrow(/not started in this browser/);
  });

  it('refuses a transaction of another kind', async () => {
    const { handle, cookie } = await begin();
    await expect(
      finishTransaction(SETTINGS, 'consent', requestWithCookie(cookie), handle),
    ).rejects.toThrow(/not started in this browser/);
  });

  it('refuses a ciphertext moved to another cookie name', async () => {
    const first = await begin();
    const second = await begin();
    const firstValue = first.cookie.split(';')[0]?.split('=')[1] ?? '';
    const secondName = second.cookie.split('=')[0] ?? '';
    await expect(
      finishTransaction(
        SETTINGS,
        'upstream',
        requestWithCookie(`${secondName}=${firstValue}`),
        second.handle,
      ),
    ).rejects.toThrow(/expired or is not valid/);
  });

  it.each([
    ['changed ciphertext', (value: string) => `${value.slice(0, -2)}AA`],
    ['invalid base64', () => 'not base64!.not base64!'],
    ['no separator', () => 'abc'],
  ])('refuses %s', async (_name, tamper) => {
    const { handle, cookie } = await begin();
    const [name, value] = (cookie.split(';')[0] ?? '').split('=') as [string, string];
    await expect(
      finishTransaction(
        SETTINGS,
        'upstream',
        requestWithCookie(`${name}=${tamper(value)}`),
        handle,
      ),
    ).rejects.toThrow(/expired or is not valid/);
  });

  it('refuses a transaction sealed with another secret', async () => {
    const { handle, cookie } = await beginTransaction(
      { ...SETTINGS, ynabClientSecret: 'attacker-guess' },
      'upstream',
      AUTH_REQUEST,
      DATA,
    );
    await expect(
      finishTransaction(SETTINGS, 'upstream', requestWithCookie(cookie), handle),
    ).rejects.toThrow(/expired or is not valid/);
  });

  it('refuses a transaction after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { handle, cookie } = await begin();

    vi.setSystemTime(new Date('2026-11-01T00:09:59Z'));
    await expect(
      finishTransaction(SETTINGS, 'upstream', requestWithCookie(cookie), handle),
    ).resolves.toBeDefined();

    vi.setSystemTime(new Date('2026-11-01T00:10:00Z'));
    await expect(
      finishTransaction(SETTINGS, 'upstream', requestWithCookie(cookie), handle),
    ).rejects.toThrow(/expired or is not valid/);
  });

  it('refuses to seal more than a browser would keep', async () => {
    await expect(
      beginTransaction(SETTINGS, 'upstream', { ...AUTH_REQUEST, state: 'x'.repeat(4000) }, DATA),
    ).rejects.toThrow(/too long/);
  });
});
