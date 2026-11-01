import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          YNAB_CLIENT_ID: 'test-client-id',
          YNAB_CLIENT_SECRET: 'test-client-secret',
          ALLOWED_YNAB_USER_IDS: 'allowed-user',
        },
      },
    }),
  ],
});
