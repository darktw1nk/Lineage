"""
A fourth arm for the benchmark: DSPy's MIPROv2 on the same tasks.

Fairness rules, all of them load-bearing:
  * same candidate model (gemini-2.5-flash-lite) and same prompt-optimizer model
    (gemini-2.5-flash) as the Lineage arms;
  * same training examples and the same held-out examples;
  * scored by the SAME metric Lineage used for that task — Levenshtein-based
    partial credit on 0-10 for exact_match tasks — reimplemented here to match
    packages/core/src/utils/distance.ts, then verified against the engine's own
    numbers by scoring the seed prompt and comparing.

DSPy optimizes a *program* (signature + demos + instructions), not a bare prompt
string, so this is not an apples-to-apples "who writes a better prompt" test. It
answers the question users actually ask: for the same task, budget and models,
which toolchain gets a higher held-out score?

    python benchmarks/dspy_arm.py benchmarks/tasks/01-format-contract.json
"""
import json
import os
import sys

import dspy


# --- scoring: mirror of the engine's levenshteinScore0to10 -------------------
def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def score_0_to_10(expected: str, actual: str) -> float:
    """packages/core/src/utils/distance.ts: 10 * (1 - dist/maxLen), clamped."""
    e, a = (expected or "").strip(), (actual or "").strip()
    if not e and not a:
        return 10.0
    longest = max(len(e), len(a))
    if longest == 0:
        return 10.0
    return max(0.0, min(10.0, 10.0 * (1.0 - levenshtein(e, a) / longest)))


def main() -> int:
    task_path = sys.argv[1]
    task = json.loads(open(task_path, encoding="utf-8").read())

    if any(t.get("mode") != "exact_match" for t in task["testSet"]):
        print(json.dumps({"skipped": "this arm only scores exact_match tasks"}))
        return 0

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print(json.dumps({"error": "GEMINI_API_KEY not set"}))
        return 1

    candidate = dspy.LM("gemini/gemini-2.5-flash-lite", api_key=api_key, temperature=0.0, cache=False)
    optimizer_lm = dspy.LM("gemini/gemini-2.5-flash", api_key=api_key, temperature=0.7, cache=False)
    dspy.configure(lm=candidate)

    train = [t for t in task["testSet"] if not t.get("holdout")]
    held = [t for t in task["testSet"] if t.get("holdout")]

    trainset = [dspy.Example(request=t["prompt"], answer=t["expected"]).with_inputs("request") for t in train]
    devset = [dspy.Example(request=t["prompt"], answer=t["expected"]).with_inputs("request") for t in held]

    program = dspy.Predict("request -> answer")

    def metric(example, pred, trace=None):
        return score_0_to_10(example.answer, getattr(pred, "answer", "")) / 10.0

    def evaluate(prog, examples):
        scores = []
        for ex in examples:
            try:
                pred = prog(request=ex.request)
                scores.append(score_0_to_10(ex.answer, getattr(pred, "answer", "")))
            except Exception as exc:  # a failed call scores 0, as in the engine
                print(f"  [dspy] call failed: {exc}", file=sys.stderr)
                scores.append(0.0)
        return sum(scores) / len(scores) if scores else 0.0

    baseline_holdout = evaluate(program, devset)
    print(f"  [dspy] unoptimized program on holdout: {baseline_holdout:.2f}", file=sys.stderr)

    # MIPROv2 bootstraps demos from SUCCESSFUL traces; on a task the base program
    # always fails it has nothing to bootstrap and degenerates to zero-shot. Give
    # DSPy its strongest option in this regime too: the training examples handed
    # over directly as labelled demos, which is what a DSPy user would reach for
    # with four examples. Reported alongside, so the comparison is not a strawman.
    labeled = dspy.LabeledFewShot(k=len(trainset)).compile(program, trainset=trainset)
    labeled_holdout = evaluate(labeled, devset)
    print(f"  [dspy] LabeledFewShot on holdout: {labeled_holdout:.2f}", file=sys.stderr)

    tele = dspy.MIPROv2(metric=metric, prompt_model=optimizer_lm, task_model=candidate,
                        auto=os.environ.get("DSPY_AUTO", "light"), num_threads=4, verbose=False)
    optimized = tele.compile(program, trainset=trainset, requires_permission_to_run=False)

    optimized_holdout = evaluate(optimized, devset)
    print(f"  [dspy] MIPROv2 on holdout: {optimized_holdout:.2f}", file=sys.stderr)

    instructions = ""
    demos = 0
    try:
        pred = optimized.predictors()[0]
        instructions = pred.signature.instructions
        demos = len(getattr(pred, "demos", []) or [])
    except Exception:
        pass

    print(json.dumps({
        "task": task["name"],
        "baseline_holdout": round(baseline_holdout, 4),
        "labeled_fewshot_holdout": round(labeled_holdout, 4),
        "optimized_holdout": round(optimized_holdout, 4),
        "instructions": instructions,
        "demos": demos,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
