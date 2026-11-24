import { AuthorizationError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import type { Settings } from '../config';

/**
 * Sign-in state kept in an encrypted cookie instead of KV.
 *
 * The OAuth library's beginConsent() and beginUpstream() each write to KV, and anyone can reach them
 * without signing in, so a thousand anonymous requests would use up the Free plan's daily writes and
 * break token refresh for the owner. Here, sign-in writes nothing until YNAB has identified an
 * allowed user. The guarantees match the library's helpers: only this server can create a
 * transaction, it works only in the browser that started it, and it expires after ten minutes.
 *
 * Unlike a KV record, a sealed cookie can't be deleted on the server, so reuse is prevented by the
 * browser clearing the cookie, and by YNAB's authorization codes working only once.
 */

const TTL_SECONDS = 600;
// Browsers drop larger cookies silently, which would look like a sign-in from another browser.
const MAX_COOKIE_VALUE_CHARS = 3800;
const KEY_INFO = new TextEncoder().encode('ynab-mcp sign-in transaction v1');

export type TransactionKind = 'consent' | 'upstream';

interface SealedRecord<Data> {
  request: AuthRequest;
  data: Data;
  /** Epoch seconds. */
  expiresAt: number;
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Derived rather than a separate secret, so there's nothing extra to set up. */
async function deriveKey(settings: Settings): Promise<CryptoKey> {
  const secret = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(settings.ynabClientSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: KEY_INFO },
    secret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** One cookie per transaction, so sign-ins in two tabs don't collide. */
async function cookieName(kind: TransactionKind, handle: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle));
  return `__Host-ynab-${kind}-${base64Url(new Uint8Array(digest)).slice(0, 22)}`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** Binds the ciphertext to its kind and handle, so one can't stand in for another. */
function associatedData(kind: TransactionKind, handle: string): Uint8Array {
  return new TextEncoder().encode(`${kind}:${handle}`);
}

/** Seals a transaction. The handle goes to the form or to YNAB, and the cookie to the browser. */
export async function beginTransaction<Data>(
  settings: Settings,
  kind: TransactionKind,
  request: AuthRequest,
  data: Data,
): Promise<{ handle: string; cookie: string }> {
  const handle = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const record: SealedRecord<Data> = {
    request,
    data,
    expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(kind, handle) },
    await deriveKey(settings),
    new TextEncoder().encode(JSON.stringify(record)),
  );
  const value = `${base64Url(iv)}.${base64Url(new Uint8Array(sealed))}`;
  if (value.length > MAX_COOKIE_VALUE_CHARS) {
    throw new AuthorizationError('invalid_request', {
      description: 'This sign-in request is too long.',
    });
  }
  const name = await cookieName(kind, handle);
  return {
    handle,
    cookie: `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}`,
  };
}

/** Opens a transaction from the browser's cookie, and returns the header that clears that cookie. */
export async function finishTransaction<Data>(
  settings: Settings,
  kind: TransactionKind,
  request: Request,
  handle: string,
): Promise<{ request: AuthRequest; data: Data; clearCookie: string }> {
  const name = await cookieName(kind, handle);
  const value = readCookie(request, name);
  if (value === undefined) {
    throw new AuthorizationError('invalid_request', {
      description: 'This sign-in was not started in this browser, or has expired. Start again.',
    });
  }

  const record = await openRecord<Data>(settings, kind, handle, value);
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) throw expiredOrInvalid();
  return {
    request: record.request,
    data: record.data,
    clearCookie: `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  };
}

function expiredOrInvalid(): AuthorizationError {
  return new AuthorizationError('invalid_request', {
    description: 'This sign-in has expired or is not valid. Start again.',
  });
}

async function openRecord<Data>(
  settings: Settings,
  kind: TransactionKind,
  handle: string,
  value: string,
): Promise<SealedRecord<Data>> {
  const [iv, sealed] = value.split('.');
  if (iv === undefined || sealed === undefined) throw expiredOrInvalid();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: associatedData(kind, handle) },
      await deriveKey(settings),
      fromBase64Url(sealed),
    );
    // Trusted without validation: decryption succeeding proves this server wrote it.
    return JSON.parse(new TextDecoder().decode(plain)) as SealedRecord<Data>;
  } catch (error) {
    // Tampered ciphertext or invalid base64. Anything else is a bug, and should surface as a 500.
    if (error instanceof DOMException) throw expiredOrInvalid();
    throw error;
  }
}
