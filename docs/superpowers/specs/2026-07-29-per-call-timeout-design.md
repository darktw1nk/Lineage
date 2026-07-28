# Per-Call Timeouts (AbortSignal)

**Date**: 2026-07-29
**Status**: Approved design, pending implementation plan

## Verified problem

No `AbortController`/`AbortSignal` exists anywhere in `packages/core/src/providers/`. The only backstop is undici's built-in ~300s headers/body timeouts, and a slow-drip response (bytes trickling under that threshold) hangs forever. `BaseProviderAdapter.call` (`base.ts:43`) holds a global semaphore slot for the whole `callAPI` including all retries, so `parallelLimit` hung calls freeze the entire run — and freeze pause too (`evaluationLoop` waits for `inProgress` to drain before declaring "paused"). `withRetry` cannot help: it fires on rejection, and a hung request never rejects.

## Design

### Shared primitive (`packages/core/src/providers/retry.ts`)

```ts
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response>;
```

- `AbortController` + `setTimeout(() => controller.abort(), timeoutMs)`; `clearTimeout` in `finally`.
- An abort (error `name === 'AbortError'` or `controller.signal.aborted`) rethrows as `new RetryableError(`Request timed out after ${timeoutMs}ms`, 408)` — **timeouts are retryable**: each retry attempt gets a fresh controller and a fresh timeout budget (the controller lives inside the `withRetry` closure, per attempt). Any other fetch error rethrows untouched.
- Worst case per node call drops from unbounded to `timeoutMs × total attempts` (default 120s × 3 = 6 min hard ceiling); the semaphore slot then frees and the engine's existing node-failure path takes over (node fails, run continues).

### Adapters (all five)

- `callAPI` opts (base.ts abstract signature) and `ProviderAdapter.call` opts (`types.ts`) gain `timeoutMs?: number`.
- Each adapter's completion `fetch(...)` becomes `fetchWithTimeout(url, init, opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)` — the default lives at the fetch site so every call is protected even when a host passes nothing.
- `OpenRouterAdapter.fetchModels` (catalog sync) uses a fixed `fetchWithTimeout(..., 60_000)`.

### Config plumbing

- `EvaluationConfig.callTimeoutMs?: number`. The engine passes it straight through (`timeoutMs: config.callTimeoutMs`); the guard lives adapter-side in one expression: `const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;` — absent, zero, and negative all fall back to the 120s default.
- Every `adapter.call({...})` site in core passes `timeoutMs: config.callTimeoutMs` (all have `config` in scope: candidate sampling in `evaluator_v2.ts`, LLM grading + safety in `fitness.ts`, mutation proposal/apply in `mutations.ts`, crossover, metaprompting, pairwise judge). `modelvariation`/`paramvariation` make no LLM calls.
- CLI: `CliConfig.callTimeoutMs` passthrough (same pattern as `samplesPerTest`).
- Desktop: "Call Timeout (seconds)" input in the Evaluation harness section — displays `(config.callTimeoutMs ?? 120000) / 1000`, stores milliseconds.
- Docs: `docs/cli.md` fidelity bullet; `evolving-prompts` skill one-liner (slow/hanging providers → `callTimeoutMs`).

## Out of scope

Streaming responses; per-provider default tiers; a cross-retry deadline (per-attempt only); further pause-machinery changes (bounded attempts already unblock pause); aborting sibling calls when a run stops.

## Testing

- **Unit (`fetchWithTimeout`)**: hung fetch stub + 50ms timeout rejects in ~50ms with `RetryableError` (statusCode 408, message contains `timed out`); resolving fetch passes the Response through and clears the timer; a non-abort fetch error (e.g. TypeError) rethrows as-is.
- **Adapter-level** (fake timers): one adapter with a permanently hung `fetch` stub and `timeoutMs: 50` — the call ultimately rejects (after `withRetry` exhausts attempts, advancing timers through abort timeouts and backoff sleeps) and the global semaphore slot is released (a subsequent call with a resolving stub completes).
- **Forwarding**: seed-forwarding-test style — each of the five adapters actually passes an `AbortSignal` to fetch (stub records `init.signal` presence) and honors `timeoutMs`.
- **Live**: a flash-lite run with `"callTimeoutMs": 5` (all calls abort instantly) finishes gracefully — nodes fail, process exits nonzero, no hang, stderr shows `timed out` retries; the same config without the field runs normally.
- Definition of done: full suite + type-check green; live both-ways verification.
