import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSinceDate } from '../src/mcp/server';
import { YnabApiError, YnabClient } from '../src/ynab/client';
import { fromMilliunits, listTransactions, transactionsPath, getMonth } from '../src/ynab/read';

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
