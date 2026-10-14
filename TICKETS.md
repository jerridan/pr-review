# Tickets

Work that remains after D1, the local walking skeleton, and D2, the full reviewer set and repo configuration. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

## D3: GitHub review posting and CI packaging

Goal: the tool runs in CI and posts one review per run, as section 3.7 and 3.9 describe.

- `--format github` with `--pr <n>`: one pull request review with event COMMENT, a short body with the verdict and the coverage line, inline comments on diff lines, findings outside the diff in the body with full-SHA permalinks, a neutral check run with the counts.
- Later runs: scope to the diff since the last reviewed head from the merge base, severity floor blocking, re-verify open threads and resolve the ones that no longer hold, never repost a dismissed fingerprint (section 7). Verdict recomputed from all open blocking findings. A push with no changed hunks posts nothing.
- Overrides: labels `review:full`, `review:fast`, `review:skip` and the comment `@pr-review full`.
- Records: upload as a workflow artifact and push to a `pr-review-records` branch.
- Packaging (section 9.2): a composite action that runs from source, a reusable workflow that wraps it with the trigger list, permissions, comment filter and fork gate, and the Actions setting that lets your other repos use it. A Claude Code `/review` command in your plugin marketplace that calls the CLI.
- Sanitize PR title and body (HTML comments, invisible characters) before they enter a prompt.
- Acceptance: the second half of the charter criterion. On a PR in a repo you own, the command posts exactly one review whose body states the verdict.

## D4: Evaluation harness

Goal: measure a change to a prompt, a threshold or a model before it ships (section 8).

- `pr-review eval --cases <dir> --repeat 3`: each case is a frozen checkout, a diff and golden findings with severity and category. Seed from ReviewBench and Martian cases, from bug injection into your own merged PRs, and from D1 records where a finding was acted on or dismissed.
- Scoring: match by file and span first; one judge call with thinking on, on a different model from the reviewer, only for ambiguous pairs. No holistic score. Report grounded recall, precision, findings per PR, cost per PR, and the spread across repeats.
- First experiments: diff-bugs on Opus 5.5 low against Sonnet 5.5 medium on cost per confirmed finding; one Opus reviewer at medium over the whole diff against the specialist set; the verifier on Sonnet 5.5 high against Opus 5.5 high; the 0 to 100 score against a 5-band scale; the non-blocking cap formula against real records.
- A CI gate that fails when recall or precision drops past a set margin.
- `pr-review explain <record.json>` to show why each finding was kept or dropped.

## Smaller follow-ups found during D1 and D2

- The verifier prompt and the merge prompt have not been tuned on real findings. Review them against the first ten records.
- `pr-review smoke` uses Sonnet 5.5; consider Haiku 5.5 to make the check cheaper.
- The fixture's head commit touches `.github/workflows/`, so every acceptance run takes the full tier by the sensitive floor. Add a second fixture without a sensitive path to exercise triage.
- The default record directory `./pr-review-records` sits inside the repo under review (skeptical review nit, declined for D1); D3 moves records to workflow artifacts and a branch.
- The verifier message numbers every line and the quote check strips the prefixes back off; an alternative is to ask for quotes by line span and compare against the span text, to be measured in D4.
- The acceptance run on 2026-10-13 cost about $0.61 for one reviewer pass and one verification on a 2-file fixture. Track this per run in D4.
- `docs/research/passes-recall.md` holds the first run of `scripts/measure-passes.sh`: both arms found the one planted bug in every run, so the fixture cannot separate one pass from two. Repeat it in the D4 harness on a harder case set, and set the diff-bugs `passes` default from that.
- The skip fields and `pre_existing` in `.pr-review/config.yaml` are parsed and recorded but not applied; D3 applies them when it has the PR metadata.
- Cross-pass dedupe keys on the fingerprint (file, span text, category), so a second pass that reports a different claim on the same span and category never reaches the verifier. Measure how often this happens in the D4 harness before changing the key.
- When the history block fails to build, the history reviewer still runs with the no-history text and the verdict is unchanged. Skip the reviewer instead and list it under `reviewers_skipped` with a reason, or make the verdict `incomplete`.
- Suppressions apply after verification, so a suppressed finding still costs one or two verifier calls. Check the rule in `onFinding` before verification and record the finding as suppressed without a query; design section 3.6 moves accordingly.
- The defaults for the caps, the verify threshold and the band are stated both in `RepoConfigSchema` and in `DEFAULT_CAPS`, `DEFAULT_VERIFY_CONFIG` and `DEFAULT_BAND`. Keep one source.
