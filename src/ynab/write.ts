import { z } from 'zod';
import type { YnabClient } from './client';

export interface CategorizationRequest {
  transactionId: string;
  categoryId: string;
  approved: boolean;
}

const savedTransactionSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
  category_id: z.string().nullish(),
  category_name: z.string().nullish(),
});
type SavedTransaction = z.output<typeof savedTransactionSchema>;

const saveResponseSchema = z.object({
  data: z.object({
    // YNAB documents `transactions` for multi-item saves, so a single-item save may use `transaction`.
    transaction: savedTransactionSchema.nullish(),
    transactions: z.array(savedTransactionSchema).nullish(),
  }),
});

/**
 * Applies category changes to existing transactions and reports what YNAB actually saved.
 *
 * A successful response doesn't prove a change applied: YNAB ignores category changes on split
 * transactions and Credit Card Payment categories, so each result is compared with the request.
 * `approved` is always sent because YNAB documents an omitted value as unapproved, which could
 * otherwise un-approve transactions the user already reviewed.
 */
export async function categorizeTransactions(
  client: YnabClient,
  planId: string,
  requests: CategorizationRequest[],
) {
  const { data } = await client.patch(
    `/plans/${encodeURIComponent(planId)}/transactions`,
    {
      transactions: requests.map((request) => ({
        id: request.transactionId,
        category_id: request.categoryId,
        approved: request.approved,
      })),
    },
    saveResponseSchema,
  );

  const saved = new Map<string, SavedTransaction>();
  for (const transaction of [...(data.transactions ?? []), ...(data.transaction ? [data.transaction] : [])]) {
    saved.set(transaction.id, transaction);
  }

  const results = requests.map((request) => toResult(request, saved.get(request.transactionId)));
  return {
    updated_count: results.filter((result) => result.status === 'updated').length,
    not_applied_count: results.filter((result) => result.status === 'not_applied').length,
    results,
  };
}

function toResult(request: CategorizationRequest, saved: SavedTransaction | undefined) {
  const id = request.transactionId;
  if (saved === undefined) {
    return {
      id,
      status: 'not_applied' as const,
      reason: 'YNAB did not return this transaction as saved. Check the id.',
    };
  }
  if (saved.category_id !== request.categoryId) {
    return {
      id,
      status: 'not_applied' as const,
      reason:
        'YNAB kept a different category. Split transactions and Credit Card Payment categories ' +
        'cannot be set this way.',
      category: saved.category_name ?? null,
      approved: saved.approved,
    };
  }
  return {
    id,
    status: 'updated' as const,
    category: saved.category_name ?? null,
    approved: saved.approved,
  };
}
