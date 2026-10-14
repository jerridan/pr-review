# Tickets

Work that remains after D1, the local walking skeleton, D2, the full reviewer set and repo configuration, and D3, the GitHub review posting and CI packaging. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

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
- The verifier message numbers every line and the quote check strips the prefixes back off; an alternative is to ask for quotes by line span and compare against the span text, to be measured in D4.
- The acceptance run on 2026-10-13 cost about $0.61 for one reviewer pass and one verification on a 2-file fixture. Track this per run in D4.
- `docs/research/passes-recall.md` holds the first run of `scripts/measure-passes.sh`: both arms found the one planted bug in every run, so the fixture cannot separate one pass from two. Repeat it in the D4 harness on a harder case set, and set the diff-bugs `passes` default from that.
- Cross-pass dedupe keys on the fingerprint (file, span text, category), so a second pass that reports a different claim on the same span and category never reaches the verifier. Measure how often this happens in the D4 harness before changing the key.
- When the history block fails to build, the history reviewer still runs with the no-history text and the verdict is unchanged. Skip the reviewer instead and list it under `reviewers_skipped` with a reason, or make the verdict `incomplete`.
- Suppressions apply after verification, so a suppressed finding still costs one or two verifier calls. Check the rule in `onFinding` before verification and record the finding as suppressed without a query; design section 3.6 moves accordingly.
- The defaults for the caps, the verify threshold and the band are stated both in `RepoConfigSchema` and in `DEFAULT_CAPS`, `DEFAULT_VERIFY_CONFIG` and `DEFAULT_BAND`. Keep one source.

## Smaller follow-ups found during D3

- The workflow uploads `pr-<n>/` of the records branch as the artifact, so the artifact holds every record of the pull request. Upload the new file alone when that grows too large.
- `viewerLogin` reads the GraphQL `viewer` field. Under the Actions token the run uses `github-actions[bot]` and never calls it, so the call is untested against an installation token. Check it once with a real token before a local bot login depends on it.
- A later run posts nothing when the pull request has no new hunk, also with `--tier` or a label. Only `--fresh`, the `@pr-review full` comment or the `review:full` label event starts a new review. Decide whether `--tier full` on a reviewed head should force a fresh run too.
- A thread whose span text changed is resolved without a verifier call. D4 measures whether a verifier re-run on the new span posts fewer wrong resolutions.
- The GitHub text sanitizer caps at 20000 characters and removes HTML comments and format characters. Measure in D4 whether a prompt injection in a PR body still reaches a reviewer through the untrusted wrapper.
- A later run with no new hunk that resolved a stale thread posts a short review and writes a record with `identity.triage: null`, so the next run has no prior triage tier from that record. Carry the prior triage tier into that record, or read it from the record before it.
- Triage runs on the whole diff also when `--tier` or a label fixes the tier, for the categories of the brief. On a large pull request that query can reach its budget. Skip triage under an override, or raise its budget.
- A direct use of `action.yml` with a token other than the job token is unsupported: the viewer login is fixed to `github-actions[bot]` under GITHUB_ACTIONS. Read the login from the token instead.
- A fork run executes no code from the head, but a reviewer subprocess runs with the head checkout as its cwd and `CLAUDE_CODE_OAUTH_TOKEN` in its env, while the workspace `.git/config` holds the job token that `actions/checkout` persisted. Whether `Read(./**)` follows a symlink out of the checkout is unverified. Harden it: set `persist-credentials: false` on the pull request checkout, give the records push its credentials in that step only, and add a test that no reviewer subprocess can reach a credential through a symlink.
