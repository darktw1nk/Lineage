# Is evolution worth it?

The question this benchmark exists to answer: **does running a genetic algorithm beat
just asking a good model to rewrite the prompt once, for 20–90× the cost?**

Results table: [RESULTS.md](RESULTS.md). Reproduce: `node benchmarks/run.mjs`.

## Method

Three arms per task, scored on the **same held-out tests, by the same grader, on the
same candidate model with the same parameters**:

| Arm | What it is |
|---|---|
| **Seed** | The hand-written starting prompt, unchanged |
| **One-shot rewrite** | That prompt rewritten once by `gemini-2.5-flash`, given the training examples *and their expected answers*, told to maximize the score |
| **Evolution** | The champion of a 6-candidate × 4-generation run |

Arms 1 and 3 come from a single evolution run — the engine scores both the seed and the
champion on the holdout at the end, using the champion's model and parameters, so the
comparison isolates the prompt text. The one-shot arm is a second run whose seed *is* the
rewrite and which does no evolving, so its score goes through the identical grading path.

Model variation and parameter variation are disabled: the genome is prompt text only.
Every task has a fixed seed. Candidate model `gemini-2.5-flash-lite`, service/judge model
`gemini-2.5-flash`, 4 training tests and 2–3 held-out tests per task.

**The baseline is deliberately strong.** It sees the same training examples evolution
does, and it is a capable model. If evolution cannot beat that, it is not worth its cost.

## What happened

Evolution beat the one-shot rewrite on **4 of 5 tasks** and never lost. But the headline
hides the two findings that actually matter.

**1. A single blind rewrite made two of five tasks *worse*.** On open-ended summary the
seed scored 8.50 and the rewrite dropped it to 7.00; on tool-call, 7.33 → 6.67. The
rewrites read *better* — more structure, more rules — and scored worse. Nothing about the
one-shot workflow tells you this happened. That, and not raw score, is the case for
measuring: evolution never shipped a regression on any task, because every candidate was
scored before it could be chosen.

**2. Where the seed is already decent, evolution's gains are small.** Summary: 8.50 → 9.00.
Tool-call: 7.33 → 7.33 — evolution found *nothing* better than the starting prompt and
correctly kept it. The dramatic wins are all on tasks where the seed was genuinely broken
(classification 0.00 → 10.00, format contract 3.00 → 8.00). Evolution buys the most where
a naive prompt fails an explicit output contract.

**3. Cheap beats thorough when the task is easy.** On classification the one-shot rewrite
hit a perfect 10.00 for $0.002 — evolution matched it for $0.128, 64× the price. If your
task is simple and your prompt is bad, one good rewrite is enough.

## Caveats, stated plainly

- **The json_schema task is a bad test, and the numbers show it** (all arms fail: 0.00 /
  1.67 / 2.67). The schema is used for *grading* but is never shown to the candidate
  model, and the seed prompt names no fields — so models invent key names (`flight_number`
  instead of `flight`) and score near zero. The relative ordering still says something
  (graded feedback recovered more of the contract than a blind rewrite did), but the
  absolute scores measure a badly specified task, not model skill. A fair version would
  name the required fields in the prompt.
- **One run per arm.** LLM judging is noisy and n=1 per cell; treat single-point gaps
  under ~1.0 as inside the noise. The exact-match and tool-call tasks are deterministic
  and therefore firmer than the judged ones.
- **Small test sets** (4 train / 2–3 holdout). Enough to show direction, not enough for
  confidence intervals.
- **One model family** (Gemini). Results may differ on frontier models, which are better
  at following a terse prompt and may leave evolution less headroom.
- The costs are real API spend from the runs in RESULTS.md, not estimates.

## Honest summary

Evolution scored highest on every task it was run on, and it was the only method here that
never made a prompt worse. That second half is the point: the cheap alternative — one
rewrite by a strong model — regressed two of five tasks while producing prompts that *read*
better, and nothing in that workflow would have told you.

What you are buying is a measured answer instead of a hopeful one: many prompts tried,
every one scored, the winner chosen on evidence, and a held-out number that says whether
the gain is real. The gains over a one-shot rewrite ran +0.67 to +2.00 points; the gain
over shipping a regression is larger and harder to see.

The decision rule: **a one-shot rewrite is enough when the prompt is obviously bad and the
task is easy. Use this when the prompt is already decent, when a silent regression would
cost you, or when the prompt runs often enough that $0.15 of search is rounding error.**
