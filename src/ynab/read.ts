import { z } from 'zod';
import type { YnabClient } from './client';

/**
 * Read operations, shaped for an LLM: decimal amounts, no deleted or hidden entries, and only the
 * fields that help answer questions. Keeping responses small also matters for the Workers Free
 * plan's 10 ms CPU limit per request.
 */

/** YNAB stores amounts as integer thousandths of a currency unit. */
export function fromMilliunits(milliunits: number): number {
  return milliunits / 1000;
}

/**
 * Orders ISO dates correctly, and names consistently enough for a tie-break. Used instead of
 * localeCompare, whose first call in a new isolate spends about 4 ms of the 10 ms CPU limit loading
 * collation data.
 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const nullableText = z.string().nullish();

const plansSchema = z.object({
  data: z.object({
    plans: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        last_modified_on: z.string().nullish(),
        currency_format: z.object({ iso_code: z.string() }).nullish(),
      }),
    ),
  }),
});

const accountsSchema = z.object({
  data: z.object({
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        on_budget: z.boolean(),
        closed: z.boolean(),
        deleted: z.boolean(),
        balance: z.number(),
        cleared_balance: z.number(),
        uncleared_balance: z.number(),
      }),
    ),
  }),
});

const monthSchema = z.object({
  data: z.object({
    month: z.object({
      month: z.string(),
      income: z.number(),
      budgeted: z.number(),
      activity: z.number(),
      to_be_budgeted: z.number(),
      age_of_money: z.number().nullish(),
      categories: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          category_group_name: nullableText,
          hidden: z.boolean(),
          deleted: z.boolean(),
          internal: z.boolean(),
          budgeted: z.number(),
          activity: z.number(),
          balance: z.number(),
          goal_under_funded: z.number().nullish(),
        }),
      ),
    }),
  }),
});

const payeesSchema = z.object({
  data: z.object({
    payees: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        transfer_account_id: nullableText,
        deleted: z.boolean(),
      }),
    ),
  }),
});

const transactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  memo: nullableText,
  cleared: z.string(),
  approved: z.boolean(),
  deleted: z.boolean(),
  flag_color: nullableText,
  account_name: z.string(),
  payee_id: nullableText,
  payee_name: nullableText,
  category_id: nullableText,
  category_name: nullableText,
  transfer_account_id: nullableText,
  // Absent on the category and payee endpoints, which return splits as separate rows.
  subtransactions: z
    .array(
      z.object({
        amount: z.number(),
        memo: nullableText,
        payee_name: nullableText,
        category_name: nullableText,
        deleted: z.boolean(),
      }),
    )
    .default([]),
});
type Transaction = z.output<typeof transactionSchema>;

const transactionsSchema = z.object({
  data: z.object({ transactions: z.array(transactionSchema) }),
});

const scheduledSchema = z.object({
  data: z.object({
    scheduled_transactions: z.array(
      z.object({
        id: z.string(),
        date_next: z.string(),
        frequency: z.string(),
        amount: z.number(),
        memo: nullableText,
        deleted: z.boolean(),
        account_name: z.string(),
        payee_name: nullableText,
        category_name: nullableText,
      }),
    ),
  }),
});

export async function listPlans(client: YnabClient) {
  const { data } = await client.get('/plans', plansSchema);
  return data.plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    currency: plan.currency_format?.iso_code ?? null,
    last_modified_on: plan.last_modified_on ?? null,
  }));
}

export async function listAccounts(client: YnabClient, planId: string, includeClosed: boolean) {
  const { data } = await client.get(`${planPath(planId)}/accounts`, accountsSchema);
  return data.accounts
    .filter((account) => !account.deleted && (includeClosed || !account.closed))
    .map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      on_budget: account.on_budget,
      closed: account.closed,
      balance: fromMilliunits(account.balance),
      cleared_balance: fromMilliunits(account.cleared_balance),
      uncleared_balance: fromMilliunits(account.uncleared_balance),
    }));
}

export async function getMonth(client: YnabClient, planId: string, month: string) {
  const { data } = await client.get(
    `${planPath(planId)}/months/${encodeURIComponent(month)}`,
    monthSchema,
  );
  const detail = data.month;
  return {
    month: detail.month,
    ready_to_assign: fromMilliunits(detail.to_be_budgeted),
    income: fromMilliunits(detail.income),
    assigned: fromMilliunits(detail.budgeted),
    activity: fromMilliunits(detail.activity),
    age_of_money_days: detail.age_of_money ?? null,
    categories: detail.categories
      .filter((category) => !category.deleted && !category.hidden && !category.internal)
      .map((category) => ({
        id: category.id,
        group: category.category_group_name ?? null,
        name: category.name,
        assigned: fromMilliunits(category.budgeted),
        activity: fromMilliunits(category.activity),
        available: fromMilliunits(category.balance),
        goal_underfunded: fromMilliunits(category.goal_under_funded ?? 0),
      })),
  };
}

export async function listPayees(client: YnabClient, planId: string) {
  const { data } = await client.get(`${planPath(planId)}/payees`, payeesSchema);
  return data.payees
    .filter((payee) => !payee.deleted)
    .map((payee) => ({
      id: payee.id,
      name: payee.name,
      is_transfer: Boolean(payee.transfer_account_id),
    }));
}

/** What list_transactions can return for each transaction. */
export const TRANSACTION_FIELDS = [
  'id',
  'date',
  'amount',
  'payee',
  'payee_id',
  'category',
  'account',
  'memo',
  'flag',
  'cleared',
  'approved',
  'splits',
] as const;
export type TransactionField = (typeof TRANSACTION_FIELDS)[number];
const DEFAULT_TRANSACTION_FIELDS = TRANSACTION_FIELDS.filter((field) => field !== 'payee_id');

// Undefined values are dropped by JSON.stringify, so empty memos, flags, and splits cost no context.
const transactionFieldReaders = {
  id: (transaction: Transaction) => transaction.id,
  date: (transaction: Transaction) => transaction.date,
  amount: (transaction: Transaction) => fromMilliunits(transaction.amount),
  payee: (transaction: Transaction) => transaction.payee_name ?? null,
  payee_id: (transaction: Transaction) => transaction.payee_id ?? null,
  category: (transaction: Transaction) => transaction.category_name ?? null,
  account: (transaction: Transaction) => transaction.account_name,
  memo: (transaction: Transaction) => transaction.memo || undefined,
  flag: (transaction: Transaction) => transaction.flag_color || undefined,
  cleared: (transaction: Transaction) => transaction.cleared,
  approved: (transaction: Transaction) => transaction.approved,
  splits: (transaction: Transaction) => {
    const splits = transaction.subtransactions.filter((split) => !split.deleted);
    if (splits.length === 0) return undefined;
    return splits.map((split) => ({
      amount: fromMilliunits(split.amount),
      payee: split.payee_name ?? null,
      category: split.category_name ?? null,
      memo: split.memo ?? null,
    }));
  },
} satisfies Record<TransactionField, (transaction: Transaction) => unknown>;

type ListedTransaction = {
  [Field in TransactionField]?: ReturnType<(typeof transactionFieldReaders)[Field]>;
};

function pickTransactionFields(
  transaction: Transaction,
  fields: readonly TransactionField[],
): ListedTransaction {
  const listed: Record<string, unknown> = {};
  for (const field of fields) listed[field] = transactionFieldReaders[field](transaction);
  return listed;
}

export interface TransactionQuery {
  planId: string;
  sinceDate: string;
  untilDate?: string | undefined;
  accountId?: string | undefined;
  categoryId?: string | undefined;
  payeeId?: string | undefined;
  type?: 'uncategorized' | 'unapproved' | undefined;
  limit: number;
  fields?: readonly TransactionField[] | undefined;
}

export function transactionsPath(query: TransactionQuery): string {
  const { planId, accountId, categoryId, payeeId } = query;
  const filters = [accountId, categoryId, payeeId].filter((id) => id !== undefined);
  if (filters.length > 1) {
    throw new Error('Use at most one of account_id, category_id, and payee_id.');
  }
  const base = planPath(planId);
  if (accountId !== undefined) return `${base}/accounts/${encodeURIComponent(accountId)}/transactions`;
  if (categoryId !== undefined) return `${base}/categories/${encodeURIComponent(categoryId)}/transactions`;
  if (payeeId !== undefined) return `${base}/payees/${encodeURIComponent(payeeId)}/transactions`;
  return `${base}/transactions`;
}

export async function listTransactions(client: YnabClient, query: TransactionQuery) {
  const { data } = await client.get(transactionsPath(query), transactionsSchema, {
    since_date: query.sinceDate,
    until_date: query.untilDate,
    type: query.type,
  });
  const matching = data.transactions
    .filter((transaction) => !transaction.deleted)
    .sort((a, b) => compareText(b.date, a.date));
  // Summed as integers so the total has no floating point drift, and over every match so it stays
  // correct when the returned list is cut off at the limit.
  const totalMilliunits = matching.reduce((sum, transaction) => sum + transaction.amount, 0);

  return {
    since_date: query.sinceDate,
    until_date: query.untilDate ?? null,
    matching_count: matching.length,
    returned_count: Math.min(matching.length, query.limit),
    truncated: matching.length > query.limit,
    total_amount: fromMilliunits(totalMilliunits),
    transactions: matching
      .slice(0, query.limit)
      .map((transaction) =>
        pickTransactionFields(transaction, query.fields ?? DEFAULT_TRANSACTION_FIELDS),
      ),
  };
}

const MAX_CATEGORIES_PER_PAYEE = 3;
// YNAB's placeholders, not choices: an uncategorized transaction, and the parent row of a split whose
// parts are returned as their own rows.
const NON_DECISION_CATEGORIES = new Set(['Uncategorized', 'Split']);

export interface PayeeHistoryQuery {
  planId: string;
  sinceDate: string;
  untilDate?: string | undefined;
  payeeIds: readonly string[];
}

interface CategoryTally {
  categoryId: string;
  category: string;
  count: number;
  lastDate: string;
}

/**
 * Each payee's most used categories. Asks YNAB for one payee at a time, so the server only parses
 * that payee's rows however long the date range is. Fetching the whole plan instead would cost CPU
 * for every transaction in the range, whichever payees were asked about.
 */
export async function getPayeeHistory(client: YnabClient, query: PayeeHistoryQuery) {
  const payees = await Promise.all(
    query.payeeIds.map((payeeId) => getOnePayeeHistory(client, query, payeeId)),
  );
  return { since_date: query.sinceDate, until_date: query.untilDate ?? null, payees };
}

/**
 * Only approved transactions count: YNAB fills in a guessed category on import, and counting
 * unreviewed guesses would make a wrong guess look like an established habit.
 */
async function getOnePayeeHistory(client: YnabClient, query: PayeeHistoryQuery, payeeId: string) {
  const { data } = await client.get(
    `${planPath(query.planId)}/payees/${encodeURIComponent(payeeId)}/transactions`,
    transactionsSchema,
    { since_date: query.sinceDate, until_date: query.untilDate },
  );

  const tallies = new Map<string, CategoryTally>();
  let transactionCount = 0;
  let lastDate: string | null = null;
  for (const row of data.transactions) {
    const { category_id: categoryId, category_name: category, date } = row;
    if (row.deleted || !row.approved || row.transfer_account_id) continue;
    if (!categoryId || !category || NON_DECISION_CATEGORIES.has(category)) continue;

    transactionCount += 1;
    if (lastDate === null || date > lastDate) lastDate = date;
    const tally = tallies.get(categoryId);
    if (tally === undefined) {
      tallies.set(categoryId, { categoryId, category, count: 1, lastDate: date });
    } else {
      tally.count += 1;
      if (date > tally.lastDate) tally.lastDate = date;
    }
  }

  return {
    payee_id: payeeId,
    payee: data.transactions[0]?.payee_name ?? null,
    transaction_count: transactionCount,
    last_date: lastDate,
    // Ties go to the category used most recently, since habits change.
    categories: [...tallies.values()]
      .sort((a, b) => b.count - a.count || compareText(b.lastDate, a.lastDate))
      .slice(0, MAX_CATEGORIES_PER_PAYEE)
      .map((tally) => ({
        category_id: tally.categoryId,
        category: tally.category,
        count: tally.count,
      })),
  };
}

export async function listScheduledTransactions(client: YnabClient, planId: string) {
  const { data } = await client.get(`${planPath(planId)}/scheduled_transactions`, scheduledSchema);
  return data.scheduled_transactions
    .filter((scheduled) => !scheduled.deleted)
    .sort((a, b) => compareText(a.date_next, b.date_next))
    .map((scheduled) => ({
      id: scheduled.id,
      next_date: scheduled.date_next,
      frequency: scheduled.frequency,
      amount: fromMilliunits(scheduled.amount),
      payee: scheduled.payee_name ?? null,
      category: scheduled.category_name ?? null,
      account: scheduled.account_name,
      memo: scheduled.memo ?? null,
    }));
}

function planPath(planId: string): string {
  return `/plans/${encodeURIComponent(planId)}`;
}
