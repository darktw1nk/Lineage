# `--report` Flag (combined spec + plan — lean treatment for a ~30-line feature)

**Date**: 2026-07-29
**Status**: Approved design

## Behavior

`--report <path|none>` controls the CLI's markdown run report:
- Absent → unchanged: `testoutputs/output-<run-name-slug>.md` next to `--output` (or under cwd).
- `none` (case-insensitive) → no report file, no "Report written" line; results.json/stdout untouched.
- Any other value → treated as a file path (absolute or cwd-relative); parent directories created; the report written exactly there.
- Unwritable path → clear stderr message, run exit code unaffected (the report is auxiliary).
- Applies to fresh runs AND `--resume` runs (both flow through `emitOutputs`).

## Implementation (packages/cli/src/index.ts)

1. `parseArgs`: return type + result literal gain `report?: string`; switch gains `case '--report': result.report = args[++i]; if (!result.report) { error + exit 1 }`.
2. Help text under `--resume`: `  --report <path|none>         Markdown report destination, or 'none' to skip`.
3. `handleRunEvolution`/`handleResumeRun` gain a trailing `reportArg?: string` param, passed from `args.report`, forwarded to `emitOutputs(result, evalConfig, cliConfig, outputPath, reportArg)`.
4. `emitOutputs` gains `reportArg?: string`; the report block becomes:
   - `none` → skip entirely;
   - path → `path.resolve(reportArg)` + `mkdirSync(dirname, { recursive: true })`, write there, wrap the write in try/catch with `Report write failed: <msg>` on stderr;
   - absent → existing derived-path logic.
5. Docs: `docs/cli.md` usage block line + one sentence where the report is described; `evolving-prompts` SKILL.md one-liner (`--report none` when only results.json matters).

## Verification (live, ~$0.001)

Minimal flash-lite config (1 node, 1 exact_match test, 1 generation), run three ways:
1. default → derived `testoutputs/output-*.md` exists, "Report written" on stderr;
2. `--report none` → no file, no "Report written" line, exit 0;
3. `--report <scratch>/custom-report.md` → file exists exactly there.
Full suite + bare type-check green.
