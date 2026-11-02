# MCP Server for YNAB

A private remote MCP server that lets an AI assistant read YNAB data, and categorize and annotate
transactions.
It runs on the Cloudflare Workers Free plan at `https://ynab-mcp.tcgarvin.com/mcp`.

## Tools

| Tool                          | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `list_plans`                  | Plans (budgets) and their currencies                         |
| `list_accounts`               | Accounts and balances                                        |
| `get_month`                   | Ready to Assign, and each category's amounts and id          |
| `list_payees`                 | Payees and their ids                                         |
| `get_payee_history`           | Most used categories for up to 10 payees                     |
| `list_transactions`           | Search transactions by date, account, category, payee, type  |
| `list_scheduled_transactions` | Upcoming and recurring transactions                          |
| `categorize_transactions`     | Set the category and approval status of existing transactions |
| `annotate_transactions`       | Set the memo and flag color of existing transactions         |

## How it works

- **Sign-in:** the Worker is its own OAuth server for MCP clients, and sends users to YNAB to sign
  in. Clients only ever hold tokens issued by this server. YNAB tokens stay encrypted in Workers KV.
- **Access:** only YNAB user ids in `ALLOWED_YNAB_USER_IDS` can sign in or make requests.
- **Clients:** only Claude's and ChatGPT's apps, including Claude Code and Codex, can connect. They
  identify themselves with client metadata documents
  ([Claude](https://claude.com/docs/connectors/building/authentication),
  [ChatGPT](https://developers.openai.com/apps-sdk/build/auth),
  [Codex](https://learn.chatgpt.com/docs/extend/mcp)) and connect as public clients using PKCE.
  Sign-in codes only ever go to those apps' callback URLs or to the user's own computer, so a phishing
  link can't deliver one to a site an attacker runs. An attacker with their own Claude or ChatGPT
  account could still send a link to a sign-in they started there, so only approve sign-ins you just
  started yourself. To use another MCP client, add it to `src/auth/client-policy.ts`.
- **KV writes:** sign-in state stays in encrypted cookies until YNAB has identified an allowed user,
  so anonymous visitors can't spend the daily KV write limit that token refresh depends on.
- **Setup errors:** if a required secret isn't set, sign-in and MCP requests return a 503 naming the
  missing settings, without their values.
- **Writes:** YNAB's only write-capable OAuth access is full access, so the limit on what can change
  comes from this server offering just two write tools. Neither can change amounts, dates, payees, or
  budget assignments, or create or delete anything.
- **State:** every MCP request is stateless, so there are no sessions or Durable Objects.

## Cost

The Free plan costs $0, and going over a limit makes requests fail rather than generating a bill.
Limits are 100,000 requests per day, 10 ms of CPU per request, and 1,000 KV writes per day. Nothing
stops anonymous traffic from using up the request limit, which would take the server down until the
limit resets. To stay
within the CPU limit, transaction searches return at most 500 results and cover at most 30 days,
unless they have a payee, category, or type filter, which YNAB applies before the server parses
anything. Any tool call fails if YNAB returns more than about 1 MB. The server is stateless, so it
can't pace YNAB's 200 requests per hour; the instructions it gives agents explain that limit, the
others here, and that "today" means the UTC date. Payee history is fetched per payee for the same reason. YNAB has no way to filter
payees by name, so name search isn't offered: it would parse every payee on each call.

## Setup

1. Log in to Cloudflare, then deploy. The first deploy creates the KV namespace and custom domain:

   ```sh
   npx wrangler login
   npm run deploy
   ```

2. [Register an OAuth application with YNAB](https://app.ynab.com/settings/developer):
   - **Name:** `MCP Server for YNAB`. YNAB's terms only allow "YNAB" in a name after "for".
   - **Redirect URI:** `https://ynab-mcp.tcgarvin.com/callback`
   - **Privacy policy URL:** `https://ynab-mcp.tcgarvin.com/privacy`

3. Set the secrets in your own terminal, so they stay out of any AI session's transcript. Use `none`
   for the allowlist for now:

   ```sh
   npx wrangler secret put YNAB_CLIENT_ID
   npx wrangler secret put YNAB_CLIENT_SECRET
   npx wrangler secret put ALLOWED_YNAB_USER_IDS
   ```

4. Connect an MCP client to `https://ynab-mcp.tcgarvin.com/mcp` and sign in. The server refuses you
   and shows your YNAB user id. Save that id as `ALLOWED_YNAB_USER_IDS`, then sign in again.

## Development

```sh
npm test            # Runs in the Workers runtime, with YNAB mocked
npm run typecheck
```

`wrangler dev` isn't useful for testing sign-in, because the OAuth URLs are fixed to the production
domain.

## Revoking access

Revoke the app in YNAB's account settings. The server deletes the stored connection the next time a
client tries to refresh it.

## Privacy

See the [privacy policy](https://ynab-mcp.tcgarvin.com/privacy).

---

We are not affiliated, associated, or in any way officially connected with YNAB or any of its
subsidiaries or affiliates. The official YNAB website can be found at https://www.ynab.com. The
names YNAB and You Need A Budget, as well as related names, tradenames, marks, trademarks, emblems,
and images are registered trademarks of YNAB.
