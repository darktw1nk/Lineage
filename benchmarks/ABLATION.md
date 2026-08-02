# Do the search features help?

Every arm is the baseline plus **exactly one** change, so a result names a feature
rather than a bundle. Same seed within a task, so operator plans, parent assignment and
the holdout split are identical across arms — the difference is the search behaviour.
Scores are on **held-out tests** the run never trained on.

Shape: 8 generations, population 10, top-4 selection, 10% elitism.
Settings: `diversity 0.5`, `novelty 0.5`, `restartAfter 2`, `adaptivity 0.7`.

> This shape was chosen deliberately. An earlier attempt at 4 generations / population 6
> could not answer the question at all: `restartAfter: 2` never fired, `adaptivity`'s
> share shifts rounded to zero children, and only 3 parents were selected. Those deltas
> were noise wearing the costume of evidence.

Excluded tasks, so the omission is not silent:

- `02-classification` — saturates at 10.00 — cannot discriminate
- `05-json-schema` — documented bad test (schema never shown to the model)
- `04-tool-call` — every arm scored an identical holdout 7.33 (= the seed prompt) across 12 runs — cannot discriminate

| Task | Seed | off | diversity | novelty | restart | adaptivity | all |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| bench-01-format-contract | 401 | 8.67 | 7.33 (-1.33) | 8.00 (-0.67) | 8.33 (-0.33) | 8.00 (-0.67) | 7.67 (-1.00) |
| bench-01-format-contract | 402 | 8.67 | 8.00 (-0.67) | 8.33 (-0.33) | 7.67 (-1.00) | 8.67 (±0) | 7.33 (-1.33) |
| bench-03-open-ended-summary | 401 | 9.00 | 8.00 (-1.00) | 9.00 (±0) | 8.50 (-0.50) | 7.50 (-1.50) | 8.50 (-0.50) |
| bench-03-open-ended-summary | 402 | 8.00 | 9.00 (+1.00) | 1.50 (-6.50) | 7.00 (-1.00) | 9.00 (+1.00) | 9.00 (+1.00) |

## Verdict per feature

| Feature | Better | Worse | Same | Mean Δ vs baseline | Mean cost Δ |
|---|:---:|:---:|:---:|:---:|:---:|
| `diversity` | 1 | 3 | 0 | -0.50 | +$0.0060 |
| `novelty` | 0 | 3 | 1 | -1.87 | $-0.0010 |
| `restart` | 0 | 4 | 0 | -0.71 | $-0.0054 |
| `adaptivity` | 1 | 2 | 1 | -0.29 | +$0.0012 |
| `all` | 1 | 3 | 0 | -0.46 | +$0.0001 |

4 task/seed cells × 6 arms = 24 runs, $1.01 total.

## What the numbers mean

**None of the four earned its keep.** Every feature has a negative mean on held-out
tests, and `restart` lost every single cell it was measured in. This is not a case of a
mechanism failing to engage — `firing.mjs` confirms each arm fired its own mechanism and
only its own, tens of times per arm, while the baseline fired none.

**`novelty` is actively dangerous, and the worst cell shows why.** On
`03-open-ended-summary` seed 402 it scored 9.00 on training and **1.50 on holdout**
against a baseline of 8.00 — worse than the seed prompt it started from. Its champion:

> `Summarize the meeting transcript.` / `The candidate was strong in system design, the`
> `best of the quarter, but weak on SQL, needing help with window functions...`

That is a training case’s ANSWER pasted into the prompt. Novelty rewards prompts unlike
anything already evaluated, and memorised training content is maximally unlike a normal
instruction — so the mechanism selects for precisely the prompts that cannot generalise.
The holdout caught it, which is the system working; enabling novelty is what created it.

**Recommendation:** leave all four off, which is already the default. `novelty` should
carry an explicit warning rather than sit in the docs as a neutral tuning knob.
`adaptivity` (-0.29) is within noise of zero and is the only one worth re-testing at a
gentler setting; the others were measured at their intended strengths and lost.

**Caveat, stated so the result is not oversold:** 4 cells on 2 tasks with one service
model. That is enough to refute "these help" — nothing here beat baseline — but not
enough to prove they always hurt. Two of five benchmark tasks could not discriminate at
all, which is itself a gap in the benchmark suite.

Run `node benchmarks/firing.mjs` for evidence of whether each mechanism actually engaged —
a feature that never fired can be neither credited nor blamed.