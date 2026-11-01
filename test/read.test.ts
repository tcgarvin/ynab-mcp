import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertParseableRange, defaultSinceDate } from '../src/mcp/server';
import { YnabApiError, YnabClient } from '../src/ynab/client';
import {
  fromMilliunits,
  getMonth,
  getPayeeHistory,
  listTransactions,
  transactionsPath,
} from '../src/ynab/read';

function stubYnab(body: unknown, status = 200) {
  const stub = vi.fn(async (_url: URL) => Response.json(body, { status }));
  vi.stubGlobal('fetch', stub);
  return stub;
}

function transaction(overrides: Record<string, unknown>) {
  return {
    id: 'tx',
    date: '2026-10-01',
    amount: -1000,
    cleared: 'cleared',
    approved: true,
    deleted: false,
    account_name: 'Checking',
    ...overrides,
  };
}

const query = { planId: 'last-used', sinceDate: '2026-10-01', limit: 2 };

afterEach(() => vi.unstubAllGlobals());

describe('fromMilliunits', () => {
  it('converts thousandths to decimal currency', () => {
    expect(fromMilliunits(-294230)).toBe(-294.23);
  });
});

describe('defaultSinceDate', () => {
  it('goes back 30 days', () => {
    expect(defaultSinceDate(new Date('2026-10-31T12:00:00Z'))).toBe('2026-10-01');
  });
});

describe('assertParseableRange', () => {
  const now = new Date('2026-11-01T12:00:00Z');

  it('allows a full calendar month', () => {
    expect(() =>
      assertParseableRange(
        { sinceDate: '2026-10-01', untilDate: '2026-10-31', narrowed: false },
        now,
      ),
    ).not.toThrow();
  });

  it('refuses 31 days and suggests how to narrow it', () => {
    expect(() =>
      assertParseableRange(
        { sinceDate: '2026-10-01', untilDate: '2026-11-01', narrowed: false },
        now,
      ),
    ).toThrow('payee_id, category_id, or type');
  });

  it('measures to today when there is no end date', () => {
    expect(() =>
      assertParseableRange({ sinceDate: '2026-05-01', narrowed: false }, now),
    ).toThrow('184 days');
  });

  it('gives an open-ended range one extra day, as the caller can be a day behind UTC', () => {
    expect(() =>
      assertParseableRange({ sinceDate: '2026-10-01', narrowed: false }, now),
    ).not.toThrow();
    expect(() =>
      assertParseableRange({ sinceDate: '2026-09-30', narrowed: false }, now),
    ).toThrow('32 days');
  });

  it('allows the default range at any time of day', () => {
    const lateInTheDay = new Date('2026-11-01T23:59:59Z');
    expect(() =>
      assertParseableRange({ sinceDate: defaultSinceDate(lateInTheDay), narrowed: false }, lateInTheDay),
    ).not.toThrow();
  });

  it('allows any range YNAB will narrow first', () => {
    expect(() =>
      assertParseableRange({ sinceDate: '2016-05-01', narrowed: true }, now),
    ).not.toThrow();
  });
});

describe('transactionsPath', () => {
  it('uses the most specific endpoint for a filter', () => {
    expect(transactionsPath({ ...query, payeeId: 'p1' })).toBe(
      '/plans/last-used/payees/p1/transactions',
    );
  });

  it('rejects more than one filter', () => {
    expect(() => transactionsPath({ ...query, payeeId: 'p1', accountId: 'a1' })).toThrow(
      'at most one',
    );
  });
});

describe('listTransactions', () => {
  it('returns newest first, truncates, and totals every match', async () => {
    stubYnab({
      data: {
        transactions: [
          transaction({ id: 'old', date: '2026-10-01', amount: -100 }),
          transaction({ id: 'new', date: '2026-10-03', amount: -200 }),
          transaction({ id: 'mid', date: '2026-10-02', amount: -300 }),
        ],
      },
    });

    const result = await listTransactions(new YnabClient('token'), query);

    expect(result.transactions.map((t) => t.id)).toEqual(['new', 'mid']);
    expect(result.truncated).toBe(true);
    expect(result.matching_count).toBe(3);
    expect(result.total_amount).toBe(-0.6);
  });

  it('omits deleted transactions and deleted splits', async () => {
    stubYnab({
      data: {
        transactions: [
          transaction({ id: 'gone', deleted: true }),
          transaction({
            id: 'split',
            subtransactions: [
              { amount: -400, deleted: false, category_name: 'Food' },
              { amount: -600, deleted: true, category_name: 'Old' },
            ],
          }),
        ],
      },
    });

    const result = await listTransactions(new YnabClient('token'), query);

    expect(result.transactions.map((t) => t.id)).toEqual(['split']);
    expect(result.transactions[0]?.splits).toEqual([
      { amount: -0.4, payee: null, category: 'Food', memo: null },
    ]);
  });

  it('sends date filters to YNAB', async () => {
    const stub = stubYnab({ data: { transactions: [] } });

    await listTransactions(new YnabClient('token'), { ...query, untilDate: '2026-10-15' });

    const url = stub.mock.calls[0]?.[0];
    expect(url?.searchParams.get('since_date')).toBe('2026-10-01');
    expect(url?.searchParams.get('until_date')).toBe('2026-10-15');
  });
});

describe('listTransactions field selection', () => {
  it('returns only the requested fields', async () => {
    stubYnab({ data: { transactions: [transaction({ id: 't', payee_name: 'Kroger' })] } });

    const result = await listTransactions(new YnabClient('token'), {
      ...query,
      fields: ['date', 'payee'],
    });

    expect(JSON.parse(JSON.stringify(result.transactions))).toEqual([
      { date: '2026-10-01', payee: 'Kroger' },
    ]);
  });

  it('leaves empty memo, flag, and splits out of the output by default', async () => {
    stubYnab({ data: { transactions: [transaction({ memo: null, flag_color: '' })] } });

    const result = await listTransactions(new YnabClient('token'), query);

    expect(Object.keys(JSON.parse(JSON.stringify(result.transactions[0])))).toEqual([
      'id',
      'date',
      'amount',
      'payee',
      'category',
      'account',
      'cleared',
      'approved',
    ]);
  });

  it('includes memo and flag when set', async () => {
    stubYnab({ data: { transactions: [transaction({ memo: 'note', flag_color: 'red' })] } });

    const result = await listTransactions(new YnabClient('token'), query);

    expect(result.transactions[0]).toMatchObject({ memo: 'note', flag: 'red' });
  });

  it('returns payee_id only when asked for', async () => {
    stubYnab({ data: { transactions: [transaction({ payee_id: 'p1' })] } });

    const byDefault = await listTransactions(new YnabClient('token'), query);
    const requested = await listTransactions(new YnabClient('token'), {
      ...query,
      fields: ['payee_id'],
    });

    expect(byDefault.transactions[0]).not.toHaveProperty('payee_id');
    expect(requested.transactions[0]).toEqual({ payee_id: 'p1' });
  });

  it('returns only the count and total for a limit of zero', async () => {
    stubYnab({ data: { transactions: [transaction({ amount: -1500 })] } });

    const result = await listTransactions(new YnabClient('token'), { ...query, limit: 0 });

    expect(result.transactions).toEqual([]);
    expect(result.matching_count).toBe(1);
    expect(result.total_amount).toBe(-1.5);
  });
});

describe('getPayeeHistory', () => {
  const food = { category_id: 'food', category_name: 'Food' };
  const gas = { category_id: 'gas', category_name: 'Gas' };
  const kroger = { payee_name: 'Kroger' };
  const historyQuery = { planId: 'last-used', sinceDate: '2026-05-01', payeeIds: ['kroger'] };

  async function history(transactions: unknown[]) {
    stubYnab({ data: { transactions } });
    const result = await getPayeeHistory(new YnabClient('token'), historyQuery);
    return result.payees[0];
  }

  it('ranks categories by use', async () => {
    const result = await history([
      transaction({ ...kroger, ...gas, date: '2026-10-05' }),
      transaction({ ...kroger, ...food, date: '2026-10-01' }),
      transaction({ ...kroger, ...food, date: '2026-10-02' }),
    ]);

    expect(result).toEqual({
      payee_id: 'kroger',
      payee: 'Kroger',
      transaction_count: 3,
      last_date: '2026-10-05',
      categories: [
        { category_id: 'food', category: 'Food', count: 2 },
        { category_id: 'gas', category: 'Gas', count: 1 },
      ],
    });
  });

  it('breaks ties in favor of the most recently used category', async () => {
    const result = await history([
      transaction({ ...kroger, ...food, date: '2026-10-01' }),
      transaction({ ...kroger, ...gas, date: '2026-10-02' }),
    ]);

    expect(result?.categories.map((c) => c.category)).toEqual(['Gas', 'Food']);
  });

  it('keeps only the top three categories but counts every transaction', async () => {
    const categories = ['a', 'b', 'c', 'd'].map((id) => ({ category_id: id, category_name: id }));
    const result = await history(categories.map((c) => transaction({ ...kroger, ...c })));

    expect(result?.categories).toHaveLength(3);
    expect(result?.transaction_count).toBe(4);
  });

  it('ignores deleted, unapproved, uncategorized, split parent, and transfer rows', async () => {
    const result = await history([
      transaction({ ...kroger, ...food, deleted: true }),
      transaction({ ...kroger, ...food, approved: false }),
      transaction({ ...kroger, category_id: null, category_name: null }),
      transaction({ ...kroger, category_id: 'internal', category_name: 'Uncategorized' }),
      transaction({ ...kroger, category_id: 'internal-2', category_name: 'Split' }),
      transaction({ ...kroger, ...food, transfer_account_id: 'savings' }),
    ]);

    expect(result).toEqual({
      payee_id: 'kroger',
      payee: 'Kroger',
      transaction_count: 0,
      last_date: null,
      categories: [],
    });
  });

  it('counts the separate rows YNAB returns for split parts', async () => {
    const result = await history([
      transaction({ ...kroger, ...food, type: 'subtransaction', parent_transaction_id: 'p' }),
      transaction({ ...kroger, ...gas, type: 'subtransaction', parent_transaction_id: 'p' }),
    ]);

    expect(result?.transaction_count).toBe(2);
  });

  it('reports a payee with no transactions rather than leaving it out', async () => {
    const result = await history([]);

    expect(result).toMatchObject({ payee_id: 'kroger', payee: null, transaction_count: 0 });
  });

  it('asks YNAB for each payee separately, never the whole plan', async () => {
    const stub = stubYnab({ data: { transactions: [] } });

    await getPayeeHistory(new YnabClient('token'), {
      ...historyQuery,
      payeeIds: ['kroger', 'shell'],
      untilDate: '2026-10-15',
    });

    const urls = stub.mock.calls.map((call) => call[0]);
    expect(urls.map((url) => url.pathname)).toEqual([
      '/v1/plans/last-used/payees/kroger/transactions',
      '/v1/plans/last-used/payees/shell/transactions',
    ]);
    expect(urls[0]?.searchParams.get('since_date')).toBe('2026-05-01');
    expect(urls[0]?.searchParams.get('until_date')).toBe('2026-10-15');
  });

  it('fails the call when YNAB rejects any payee', async () => {
    stubYnab({ error: { id: '404', name: 'not_found', detail: 'Payee not found' } }, 404);

    await expect(getPayeeHistory(new YnabClient('token'), historyQuery)).rejects.toThrow(
      'Payee not found',
    );
  });
});

describe('getMonth', () => {
  it('hides hidden, deleted, and internal categories', async () => {
    const category = {
      id: 'c',
      name: 'Food',
      category_group_name: 'Needs',
      hidden: false,
      deleted: false,
      internal: false,
      budgeted: 5000,
      activity: -2000,
      balance: 3000,
    };
    stubYnab({
      data: {
        month: {
          month: '2026-10-01',
          income: 100000,
          budgeted: 5000,
          activity: -2000,
          to_be_budgeted: 95000,
          age_of_money: 30,
          categories: [
            category,
            { ...category, id: 'hidden', hidden: true },
            { ...category, id: 'deleted', deleted: true },
            { ...category, id: 'internal', internal: true },
          ],
        },
      },
    });

    const result = await getMonth(new YnabClient('token'), 'last-used', 'current');

    expect(result.ready_to_assign).toBe(95);
    expect(result.categories).toEqual([
      {
        id: 'c',
        group: 'Needs',
        name: 'Food',
        assigned: 5,
        activity: -2,
        available: 3,
        goal_underfunded: 0,
      },
    ]);
  });
});

describe('YnabClient response limit', () => {
  const emptyList = { transactions: [] };

  it('accepts a response under the limit', async () => {
    stubYnab({ data: emptyList, padding: 'x'.repeat(600_000) });

    const result = await listTransactions(new YnabClient('token'), query);

    expect(result.matching_count).toBe(0);
  });

  it('refuses a response over the limit', async () => {
    stubYnab({ data: emptyList, padding: 'x'.repeat(1_000_001) });

    await expect(listTransactions(new YnabClient('token'), query)).rejects.toThrow(
      'more data than this server processes',
    );
  });

  it('counts every response in a call that makes several requests', async () => {
    stubYnab({ data: emptyList, padding: 'x'.repeat(600_000) });

    await expect(
      getPayeeHistory(new YnabClient('token'), {
        planId: 'last-used',
        sinceDate: '2026-05-01',
        payeeIds: ['kroger', 'shell'],
      }),
    ).rejects.toThrow('more data than this server processes');
  });
});

describe('YnabClient errors', () => {
  it('explains rate limiting', async () => {
    stubYnab({ error: { id: '429', name: 'too_many_requests', detail: 'slow down' } }, 429);
    await expect(listTransactions(new YnabClient('token'), query)).rejects.toThrow('rate limit');
  });

  it('surfaces the detail from YNAB errors', async () => {
    stubYnab({ error: { id: '404', name: 'not_found', detail: 'Plan not found' } }, 404);
    await expect(listTransactions(new YnabClient('token'), query)).rejects.toThrow(
      'Plan not found',
    );
  });

  it('rejects responses that do not match the expected shape', async () => {
    stubYnab({ data: { transactions: [{ id: 'bad' }] } });
    await expect(listTransactions(new YnabClient('token'), query)).rejects.toBeInstanceOf(
      YnabApiError,
    );
  });
});
