import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** `body` must already be escaped. */
function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  button { font: inherit; padding: .4rem 1rem; margin-right: .5rem; }
  footer { margin-top: 3rem; font-size: .8rem; opacity: .75; }
</style>
<main>${body}</main>
<footer>
  <p><a href="/privacy">Privacy policy</a></p>
  <p>We are not affiliated, associated, or in any way officially connected with YNAB or any of its
  subsidiaries or affiliates. The official YNAB website can be found at
  <a href="https://www.ynab.com">https://www.ynab.com</a>. The names YNAB and You Need A Budget, as
  well as related names, tradenames, marks, trademarks, emblems, and images are registered
  trademarks of YNAB.</p>
</footer>
</html>`;
}

export function landingPage(): Response {
  const body = `<h1>MCP Server for YNAB</h1>
<p>A private, single-user server that lets the owner's AI assistant read their YNAB data, and
categorize and annotate their transactions. Connect an MCP client to <code>/mcp</code>.</p>`;
  return new Response(layout('MCP Server for YNAB', body), { headers: HTML_HEADERS });
}

export function privacyPage(): Response {
  const body = `<h1>Privacy policy</h1>
<p><em>Last updated: November 1, 2026</em></p>
<p>MCP Server for YNAB is a private server for its owner's personal use. Only YNAB accounts on the
owner's allowlist can sign in.</p>
<h2>What it does with your data</h2>
<p>When an AI assistant you connected makes a request, the server fetches the relevant YNAB data
and returns it to that assistant, or changes the category, memo, flag, and approval status of the
transactions it names. Your YNAB authorization grants full access to your plan, but the server only offers those
actions. Your data is used only for this purpose, and is not sold, or shared with anyone else. Your
assistant's provider handles what it receives under its own terms.</p>
<h2>What is stored</h2>
<p>YNAB budget data passes through the server and is not stored. The server stores your YNAB user
id and your YNAB OAuth tokens, encrypted, along with hashed credentials for connected assistants.
It never sees your YNAB password.</p>
<h2>Security and hosting</h2>
<p>The server runs on Cloudflare Workers, and its stored data is held in Cloudflare Workers KV. All
connections use HTTPS.</p>
<h2>Retention and deletion</h2>
<p>Stored tokens expire within 30 days of signing in. To delete your data sooner, revoke this app's
access in your YNAB account settings. The server deletes its stored connection the next time it
finds that access is revoked.</p>`;
  return new Response(layout('Privacy policy', body), { headers: HTML_HEADERS });
}

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin =
    details.clientDomain === undefined
      ? 'This app registered itself, so its name is not verified.'
      : `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`;
  const loopbackWarning = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  const body = `<h1>Allow ${name} to access your YNAB data?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<p>It will be able to <strong>read</strong> your plans, accounts, categories, payees, and
transactions, and <strong>change the category, memo, flag, and approval status</strong> of
existing transactions. This server offers no way to create or delete anything, or to change amounts.</p>
<p>The authorization you give YNAB on the next screen is for full access, because YNAB has no
narrower option that allows changes.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Continue to YNAB</button>
  <button name="decision" value="deny">Deny</button>
</form>`;
  return layout(`Authorize ${details.clientName}`, body);
}

export function errorPage(status: number, title: string, message: string): Response {
  const body = `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
  return new Response(layout(title, body), { status, headers: HTML_HEADERS });
}
