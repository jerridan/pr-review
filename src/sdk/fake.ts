// A fake SDK client for tests. It runs no model and needs no network.
import type { QueryOutcome, QueryRequest, SdkClient } from "./client.js";
import { buildQueryOptions, type RunOptions } from "./options.js";

export type FakeScript = (
  req: QueryRequest,
) => QueryOutcome<unknown> | Promise<QueryOutcome<unknown>>;

/**
 * Make a fake client that returns what the script gives. It records each
 * request in "calls". It builds the query options as the real client
 * does, so a request that the real client rejects fails here too.
 */
export function createFakeSdkClient(script: FakeScript): SdkClient & { calls: QueryRequest[] } {
  const calls: QueryRequest[] = [];
  return {
    calls,
    async query<T>(req: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>> {
      calls.push(req);
      buildQueryOptions(req, options);
      return (await script(req)) as QueryOutcome<T>;
    },
  };
}
