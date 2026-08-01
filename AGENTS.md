# AGENTS.md — contributing to Lineage as an AI agent

[CLAUDE.md](CLAUDE.md) describes the architecture. This file is the part that is hard to infer from the code: the rules this repo learned by getting them wrong, and what "done" means here.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the boundary rules. Everything below is in addition to it.

## What "done" means

A change is finished when all three are true, verified by running them:

```bash
npm test           # every suite, bare — never piped
npm run type-check # strict TS across core, cli, desktop, desktop-node
```

- **Run test and type-check commands bare.** Piping through `grep`/`tail`/`Select-String` masks the exit code, and red runs have been committed that way twice.
- **Never claim a state you did not observe.** "Tests pass" requires the run in this session. If something is unverified, say so plainly.

## Tests: the bar is "does it bite"

A test that cannot fail is worse than no test — it converts an unguarded behaviour into a guarded-looking one. This repo has shipped seven tests that asserted nothing, and a fix whose test passed against a pasted copy of the fix.

- **Mutation-test your own test.** After writing it, break the production code it covers and confirm the test fails. Restore, confirm green. If breaking the code leaves the suite green, the test is decoration.
- **Test the wiring, not just the callee.** The recurring defect class here is a correct function nobody calls: a whole CLI command was dead because its parts were tested individually and nothing drove the function that connects them. Drive the real entry point — `getOperator(...).apply(...)`, the IPC handler, `startEvaluation` — not a hand-built stand-in.
- **Fixtures must be reachable by production code.** If no real code path can construct your fixture, the test proves nothing.

## Rules with scars

Each of these cost a debugging session at least once.

**Files are CRLF.** Scripted edits with `\n` patterns silently no-op. Use `\r?\n`, and grep to confirm the patch landed.

**Never patch source with `node -e` / shell heredocs containing template literals.** The shell eats `${...}` and backticks and produces syntactically broken source. Use a proper file edit.

**Never write a literal invisible character into source.** A raw U+2028/U+2029/U+200B in a regex or string is an esbuild hard break, not a style issue. Build them with `String.fromCharCode(0x200B)` or `\uXXXX` escapes, then byte-scan the file to confirm none landed.

**The renderer must never import the `@lineage/core` barrel.** It drags sql.js, `fs`, `path` and ajv into a browser context, where the Electron renderer plugin rewrites them to `require` — undefined under contextIsolation. The production window then renders nothing while dev mode looks fine. Shared engine logic gets a browser-safe subpath (see `@lineage/core/champion`); `apps/desktop/tests/renderer-import-boundary.test.ts` enforces it.

**Reject bad values at every entry point, including reads.** Write-side validation only protects rows written after it existed. Negative model prices, unpriced models, non-finite costs and plugin-reported spend all have to be refused where they are *read*, too — a stale catalog row with a negative price inverts fitness and disarms `budgetUSD`.

**An unmeasurable dimension must be disabled, never defaulted.** Defaulting a missing metric to a neutral-looking score hands every candidate a free pass; this bug class has hit `stability`, `safety` and quality independently. Drop the weight from the denominator instead.

**Money must reconcile.** Any change touching cost accrual has to keep `run.totals.usd` equal to the sum of the per-purpose breakdown *and* to what adapters actually billed — across crash/resume too. Multi-call operators check `ctx.shouldAbort(spentSoFarUSD)` between their own calls; the host gate only runs once, before the first.

**Anything a model wrote is untrusted input.** Judge justifications, changelog text and candidate output all reach prompts and the markdown report. Escape before interpolating, or evolution will find the channel — it has, repeatedly.

## Working on the engine

- `packages/core` has zero Electron dependencies; hosts inject `setStore`, `setSendUpdate`, `initializeDatabase(dbPath)`.
- Randomness goes through `rngFor(...)` so seeded runs reproduce; `Math.random()` in engine paths breaks that contract.
- Database migrations are append-only, and sql.js writes the whole file — a handle that saves without holding the lock erases concurrent commits.
- Long or billable phases (playoff, holdout, operator batches) each need their own stop check; `finishEvaluation` drains `inProgress`, which is empty during a generation transition.

## Verifying against a real run

Unit tests do not catch prompt-shaped failures. When a change touches operators, grading or reporting, run the CLI against a real config with a tiny budget and read the artifacts:

```bash
npm run --silent cli -- --estimate --config <cfg> --db ./scratch.db   # price it first, free
npm run --silent cli -- --config <cfg> --db ./scratch.db --output r.json
```

Always pass `--db` to a scratch path — the default database is shared with the desktop app. Read the generated markdown report, not just the exit code: that is where fabricated deltas, contaminated holdouts and all-carry dead runs become visible.

## Bug hunting

`docs/analysis/` holds the logs of twenty adversarial passes. The method, if you run one:

- Findings must be **proven with a runnable harness**, never reasoned from the code.
- Dedicate one hunter to attacking **the previous pass's own diff** — five of pass 19's nineteen findings were regressions introduced by pass 18.
- Leave the tree clean: harnesses live in a scratch directory, and any file you revert for a check gets restored exactly.

## Commits

Plain, imperative, no attribution trailers, no emoji. Say what changed and why it was wrong before — the commit log here is the project's memory of its own mistakes, and it is worth reading before you repeat one.
