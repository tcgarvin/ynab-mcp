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
  memo: z.string().nullish(),
  flag_color: z.string().nullish(),
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
  const saved = await saveTransactions(
    client,
    planId,
    requests.map((request) => ({
      id: request.transactionId,
      category_id: request.categoryId,
      approved: request.approved,
    })),
  );
  return summarize(requests.map((request) => toResult(request, saved.get(request.transactionId))));
}

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export interface AnnotationRequest {
  transactionId: string;
  approved: boolean;
  /** Replaces the memo. Null clears it, and leaving it out keeps it. */
  memo?: string | null | undefined;
  /** Replaces the flag. Null clears it, and leaving it out keeps it. */
  flagColor?: FlagColor | null | undefined;
}

/**
 * Sets memos and flags on existing transactions and reports what YNAB actually saved. `approved` is
 * always sent, for the same reason as in categorizeTransactions.
 */
export async function annotateTransactions(
  client: YnabClient,
  planId: string,
  requests: AnnotationRequest[],
) {
  const saved = await saveTransactions(
    client,
    planId,
    requests.map((request) => ({
      id: request.transactionId,
      approved: request.approved,
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      ...(request.flagColor === undefined ? {} : { flag_color: request.flagColor }),
    })),
  );
  return summarize(
    requests.map((request) => toAnnotationResult(request, saved.get(request.transactionId))),
  );
}

async function saveTransactions(
  client: YnabClient,
  planId: string,
  transactions: Record<string, unknown>[],
): Promise<Map<string, SavedTransaction>> {
  const { data } = await client.patch(
    `/plans/${encodeURIComponent(planId)}/transactions`,
    { transactions },
    saveResponseSchema,
  );
  const saved = new Map<string, SavedTransaction>();
  for (const transaction of [...(data.transactions ?? []), ...(data.transaction ? [data.transaction] : [])]) {
    saved.set(transaction.id, transaction);
  }
  return saved;
}

function summarize<Result extends { status: 'updated' | 'not_applied' }>(results: Result[]) {
  return {
    updated_count: results.filter((result) => result.status === 'updated').length,
    not_applied_count: results.filter((result) => result.status === 'not_applied').length,
    results,
  };
}

function notSaved(id: string) {
  return {
    id,
    status: 'not_applied' as const,
    reason: 'YNAB did not return this transaction as saved. Check the id.',
  };
}

function toAnnotationResult(request: AnnotationRequest, saved: SavedTransaction | undefined) {
  const id = request.transactionId;
  if (saved === undefined) return notSaved(id);

  // YNAB reports "no value" as null or an empty string, and may trim memo whitespace.
  const savedMemo = saved.memo?.trim() || null;
  const savedFlag = saved.flag_color || null;
  const memoApplied = request.memo === undefined || (request.memo?.trim() || null) === savedMemo;
  const flagApplied = request.flagColor === undefined || request.flagColor === savedFlag;
  const current = { memo: savedMemo, flag_color: savedFlag, approved: saved.approved };
  if (!memoApplied || !flagApplied) {
    return {
      id,
      status: 'not_applied' as const,
      reason: 'YNAB saved a different memo or flag than requested.',
      ...current,
    };
  }
  return { id, status: 'updated' as const, ...current };
}

function toResult(request: CategorizationRequest, saved: SavedTransaction | undefined) {
  const id = request.transactionId;
  if (saved === undefined) return notSaved(id);
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
