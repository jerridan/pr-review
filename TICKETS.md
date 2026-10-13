# Tickets

Work that remains after D1, the local walking skeleton. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

## D2: Full reviewer set and repo configuration

Goal: every built-in reviewer from section 3.4 runs, and a target repo can shape the review from `.pr-review/`.

- Add the six remaining built-in reviewers under `prompts/reviewers/`: conventions, tests, security, history, description-drift, docs-and-comments. Each has its own evidence source, triggers and do-not-flag scope. History needs git blame and log through read-only Bash or a gather helper; decide which.
- Load `.pr-review/config.yaml`, `.pr-review/rules.md` and `.pr-review/reviewers/*.md` from the base branch only (section 6). Config covers thresholds, suppressions, sensitive and generated globs, skip rules, caps, model and effort overrides per role, `pre_existing`.
- Inject `rules.md` and the base-branch `CLAUDE.md` into every reviewer prompt. Keep `settingSources: []`.
- Honour `passes` above 1 with dedupe, and measure whether a second pass of diff-bugs raises recall on the fixture set.
- Custom reviewer Bash policy: grant Bash only when `trusted: true` and the author has write access; otherwise run without it and say so in coverage.
- Add the run-level token ceiling and the per-repo overrides for the concurrency limit.
- Acceptance: a fixture repo with a `.pr-review/` directory changes which reviewers run and which findings are suppressed, and the record shows the config hash.

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

## Smaller follow-ups found during D1

- The verifier prompt and the merge prompt have not been tuned on real findings. Review them against the first ten records.
- `pr-review smoke` uses Sonnet 5.5; consider Haiku 5.5 to make the check cheaper.
- The fixture's head commit touches `.github/workflows/`, so every acceptance run takes the full tier by the sensitive floor. Add a second fixture without a sensitive path to exercise triage.
- The acceptance run on 2026-10-13 cost about $0.61 for one reviewer pass and one verification on a 2-file fixture. Track this per run in D4.
