import { Aggregate, Query } from "mongoose";

type QueryExecFn = typeof Query.prototype.exec;
type AggregateExecFn = typeof Aggregate.prototype.exec;

/**
 * Counts Mongoose query executions for the duration it's active. Used in tests to assert a hot
 * endpoint stays at a fixed number of round trips instead of silently regressing to N+1 as the
 * code around it changes. First applied to a membership lookup in B0; B11 patches
 * `Aggregate.prototype.exec` too (found while adding a budget test for `/v1/channels/mine`,
 * which is aggregation-based — the original B0 version only patched `Query.prototype.exec`,
 * which `.aggregate()` never goes through, so it silently counted 0 for every aggregation call).
 */
export class QueryCounter {
  private count = 0;
  private originalQueryExec: QueryExecFn | null = null;
  private originalAggregateExec: AggregateExecFn | null = null;

  start(): void {
    this.count = 0;
    const increment = () => {
      this.count += 1;
    };

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalQueryExec = Query.prototype.exec;
    this.originalQueryExec = originalQueryExec;
    function patchedQueryExec(
      this: Query<unknown, unknown>,
      ...args: Parameters<QueryExecFn>
    ): ReturnType<QueryExecFn> {
      increment();
      return originalQueryExec.apply(this, args) as ReturnType<QueryExecFn>;
    }
    Query.prototype.exec = patchedQueryExec as QueryExecFn;

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalAggregateExec = Aggregate.prototype.exec;
    this.originalAggregateExec = originalAggregateExec;
    function patchedAggregateExec(
      this: Aggregate<unknown>,
      ...args: Parameters<AggregateExecFn>
    ): ReturnType<AggregateExecFn> {
      increment();
      return originalAggregateExec.apply(
        this,
        args,
      ) as ReturnType<AggregateExecFn>;
    }
    Aggregate.prototype.exec = patchedAggregateExec as AggregateExecFn;
  }

  stop(): number {
    if (this.originalQueryExec) {
      Query.prototype.exec = this.originalQueryExec;
      this.originalQueryExec = null;
    }
    if (this.originalAggregateExec) {
      Aggregate.prototype.exec = this.originalAggregateExec;
      this.originalAggregateExec = null;
    }
    return this.count;
  }

  get(): number {
    return this.count;
  }
}
