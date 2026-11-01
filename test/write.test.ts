import { afterEach, describe, expect, it, vi } from 'vitest';
import { YnabClient } from '../src/ynab/client';
import { categorizeTransactions, type CategorizationRequest } from '../src/ynab/write';

function stubSave(data: unknown, status = 200) {
  const bodies: unknown[] = [];
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: URL, init: RequestInit) => {
      methods.push(init.method ?? '');
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(data, { status });
    }),
  );
  return { bodies, methods };
}

const request: CategorizationRequest = { transactionId: 't1', categoryId: 'food', approved: true };
const saved = { id: 't1', approved: true, category_id: 'food', category_name: 'Food' };

afterEach(() => vi.unstubAllGlobals());

describe('categorizeTransactions', () => {
  it('sends only the id, category, and approval status', async () => {
    const { bodies, methods } = stubSave({ data: { transactions: [saved] } });

    await categorizeTransactions(new YnabClient('token'), 'plan', [request]);

    expect(methods).toEqual(['PATCH']);
    expect(bodies).toEqual([
      { transactions: [{ id: 't1', category_id: 'food', approved: true }] },
    ]);
  });

  it('always sends approved, so an unapproved value is explicit too', async () => {
    const { bodies } = stubSave({ data: { transactions: [{ ...saved, approved: false }] } });

    await categorizeTransactions(new YnabClient('token'), 'plan', [
      { ...request, approved: false },
    ]);

    expect(bodies[0]).toEqual({
      transactions: [{ id: 't1', category_id: 'food', approved: false }],
    });
  });

  it('reports a change as updated when YNAB saved it', async () => {
    stubSave({ data: { transactions: [saved] } });

    const result = await categorizeTransactions(new YnabClient('token'), 'plan', [request]);

    expect(result.updated_count).toBe(1);
    expect(result.not_applied_count).toBe(0);
    expect(result.results[0]).toEqual({
      id: 't1',
      status: 'updated',
      category: 'Food',
      approved: true,
    });
  });

  it('accepts a single-transaction response shape', async () => {
    stubSave({ data: { transaction: saved } });

    const result = await categorizeTransactions(new YnabClient('token'), 'plan', [request]);

    expect(result.updated_count).toBe(1);
  });

  it('reports not_applied when YNAB silently keeps another category', async () => {
    stubSave({
      data: { transactions: [{ ...saved, category_id: 'split-id', category_name: 'Split' }] },
    });

    const result = await categorizeTransactions(new YnabClient('token'), 'plan', [request]);

    expect(result.updated_count).toBe(0);
    expect(result.not_applied_count).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'not_applied', category: 'Split' });
  });

  it('reports not_applied when YNAB leaves a transaction out of its response', async () => {
    stubSave({ data: { transactions: [saved] } });

    const result = await categorizeTransactions(new YnabClient('token'), 'plan', [
      request,
      { ...request, transactionId: 'missing' },
    ]);

    expect(result.updated_count).toBe(1);
    expect(result.results[1]).toMatchObject({ id: 'missing', status: 'not_applied' });
  });

  it('raises YNAB validation errors', async () => {
    stubSave({ error: { id: '400', name: 'bad_request', detail: 'Bad category' } }, 400);

    await expect(
      categorizeTransactions(new YnabClient('token'), 'plan', [request]),
    ).rejects.toThrow('Bad category');
  });
});
