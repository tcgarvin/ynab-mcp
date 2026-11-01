import { z } from 'zod';

/** Stored encrypted on the grant. Holds the long-lived YNAB refresh token. */
export const grantPropsSchema = z.object({
  ynabUserId: z.string(),
  ynabAccessToken: z.string(),
  ynabRefreshToken: z.string(),
  ynabAccessTokenExpiresAt: z.number(),
});
export type GrantProps = z.output<typeof grantPropsSchema>;

/** Stored encrypted on each access token. Omits the refresh token, which requests don't need. */
export const accessTokenPropsSchema = grantPropsSchema.pick({
  ynabUserId: true,
  ynabAccessToken: true,
});
export type AccessTokenProps = z.output<typeof accessTokenPropsSchema>;
