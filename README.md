# MCP Server for YNAB

A private remote MCP server that lets an AI assistant read YNAB data and categorize transactions.
It runs on the Cloudflare Workers Free plan at `https://ynab-mcp.tcgarvin.com/mcp`.

## Tools

| Tool                          | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `list_plans`                  | Plans (budgets) and their currencies                         |
| `list_accounts`               | Accounts and balances                                        |
| `get_month`                   | Ready to Assign, and each category's amounts and id          |
| `list_payees`                 | Payees and their ids                                         |
| `list_transactions`           | Search transactions by date, account, category, payee, type  |
| `list_scheduled_transactions` | Upcoming and recurring transactions                          |
| `categorize_transactions`     | Set the category and approval status of existing transactions |

## How it works

- **Sign-in:** the Worker is its own OAuth server for MCP clients, and sends users to YNAB to sign
  in. Clients only ever hold tokens issued by this server. YNAB tokens stay encrypted in Workers KV.
- **Access:** only YNAB user ids in `ALLOWED_YNAB_USER_IDS` can sign in or make requests.
- **Setup errors:** if a required secret isn't set, sign-in and MCP requests return a 503 naming the
  missing settings, without their values.
- **Writes:** YNAB's only write-capable OAuth access is full access, so the limit on what can change
  comes from this server offering just one write tool.
- **State:** every MCP request is stateless, so there are no sessions or Durable Objects.

## Cost

The Free plan costs $0, and going over a limit makes requests fail rather than generating a bill.
Limits are 100,000 requests per day, 10 ms of CPU per request, and 1,000 KV writes per day. To stay
within the CPU limit, transaction searches default to 30 days and return at most 500 results.

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
