import { z } from 'zod';

const API_BASE = 'https://api.ynab.com/v1';

/** YNAB's limit per rolling hour. This server is stateless, so it can only report it, not pace it. */
export const YNAB_REQUESTS_PER_HOUR = 200;
// Bounds the CPU any one tool call can spend parsing, including calls that make several requests.
// Roughly 1,300 transactions, and enough for the full payee list of a plan with about 8,000 payees.
const MAX_RESPONSE_CHARS_PER_CLIENT = 1_000_000;

const errorBodySchema = z.object({ error: z.object({ detail: z.string() }) });

export class YnabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'YnabApiError';
  }
}

export type QueryParams = Record<string, string | undefined>;

/** Thin client for the YNAB API. One instance serves one MCP request. */
export class YnabClient {
  private responseChars = 0;

  constructor(private readonly accessToken: string) {}

  get<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    query: QueryParams = {},
  ): Promise<z.output<Schema>> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return this.send(url, path, schema, { method: 'GET' });
  }

  patch<Schema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    return this.send(new URL(`${API_BASE}${path}`), path, schema, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async send<Schema extends z.ZodType>(
    url: URL,
    path: string,
    schema: Schema,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<z.output<Schema>> {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw await toApiError(response);

    // Checked on the text because parsing is the expensive step this limit exists to avoid.
    const text = await response.text();
    this.responseChars += text.length;
    if (this.responseChars > MAX_RESPONSE_CHARS_PER_CLIENT) {
      throw new YnabApiError(
        response.status,
        'YNAB returned more data than this server processes in one call. Use a shorter date ' +
          'range or fewer payees.',
      );
    }

    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const location = issue === undefined ? 'unknown field' : issue.path.join('.');
      throw new YnabApiError(
        response.status,
        `YNAB returned an unexpected response for ${path} (at ${location})`,
      );
    }
    return parsed.data;
  }
}

async function toApiError(response: Response): Promise<YnabApiError> {
  const { status } = response;
  if (status === 401) {
    return new YnabApiError(status, 'YNAB rejected this connection. Reconnect the YNAB server.');
  }
  if (status === 429) {
    return new YnabApiError(
      status,
      `YNAB rate limit reached (${YNAB_REQUESTS_PER_HOUR} requests per rolling hour). Retrying ` +
        'now will not help, so stop and try again later.',
    );
  }
  const body = errorBodySchema.safeParse(await response.json().catch(() => null));
  const detail = body.success ? body.data.error.detail : 'no details provided';
  return new YnabApiError(status, `YNAB API error ${status}: ${detail}`);
}
