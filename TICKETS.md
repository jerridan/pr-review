# Tickets

This file lists the work that remains after D1 to D4a. D1 is the local walking skeleton. D2 is the full reviewer set and repo configuration. D3 is the GitHub review posting and CI packaging. D4a is the evaluation harness. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

## D4b: More eval cases

Goal: grow the case set of the eval beyond the starter set of D4a (section 8). A larger set lets the metrics separate one prompt or model from another.

- Add cases from ReviewBench and Martian, with the sources `reviewbench` and `martian`.
- Add cases by bug injection into jerridan/websites and jerridan/walle, with the source `injection`. Each injected bug is one golden finding.
- Add cases from real records where a person acted on or dismissed a finding, with the source `record`.
- Make each case with `scripts/make-case.sh` and add it to the cases repo as its README says. Move the pin in `eval/cases.json` and write a new baseline with `--write-baseline` in the same PR.

## D4c: First experiments

Goal: run the first experiments on the eval and write the results to `docs/research/`.

- diff-bugs on Opus 5.5 low against Sonnet 5.5 medium, on cost per confirmed finding.
- One Opus reviewer at medium over the whole diff against the specialist set.
- The verifier on Sonnet 5.5 high against Opus 5.5 high.
- The 0 to 100 score against a 5-band scale.
- The non-blocking cap formula against real records.

## Smaller follow-ups found during D1 and D2

- The verifier prompt and the merge prompt have not been tuned on real findings. Review them against the first ten records.
- `pr-review smoke` uses Sonnet 5.5; consider Haiku 5.5 to make the check cheaper.
- The fixture's head commit touches `.github/workflows/`, so every acceptance run takes the full tier by the sensitive floor. Add a second fixture without a sensitive path to exercise triage.
- The verifier message numbers every line, and the quote check strips the prefixes back off. An alternative is to ask for quotes by line span and compare them with the span text. Measure it in D4c.
- `docs/research/passes-recall.md` holds the first run of `scripts/measure-passes.sh`. Both arms found the one planted bug in every run. So the fixture cannot separate one pass from two. Repeat it in D4c on a harder case set, and set the diff-bugs `passes` default from that.
- Cross-pass dedupe keys on the fingerprint: the file, the span text and the category. A second pass that reports a different claim on the same span and category never reaches the verifier. Measure how often this happens in D4c before changing the key.
- When the history block fails to build, the history reviewer still runs with the no-history text and the verdict is unchanged. Skip the reviewer instead and list it under `reviewers_skipped` with a reason, or make the verdict `incomplete`.
- Suppressions apply after verification, so a suppressed finding still costs one or two verifier calls. Check the rule in `onFinding` before verification and record the finding as suppressed without a query; design section 3.6 moves accordingly.
- The defaults for the caps, the verify threshold and the band are stated both in `RepoConfigSchema` and in `DEFAULT_CAPS`, `DEFAULT_VERIFY_CONFIG` and `DEFAULT_BAND`. Keep one source.

## Smaller follow-ups found during D3

- The workflow uploads `pr-<n>/` of the records branch as the artifact, so the artifact holds every record of the pull request. Upload the new file alone when that grows too large.
- `viewerLogin` reads the GraphQL `viewer` field. Under the Actions token the run uses `github-actions[bot]` and never calls it, so the call is untested against an installation token. Check it once with a real token before a local bot login depends on it.
- A later run posts nothing when the pull request has no new hunk, also with `--tier` or a label. Only `--fresh`, the `@pr-review full` comment or the `review:full` label event starts a new review. Decide whether `--tier full` on a reviewed head should force a fresh run too.
- A later run resolves a thread whose span text changed without a verifier call. D4c measures whether a verifier re-run on the new span posts fewer wrong resolutions.
- The GitHub text sanitizer caps at 20000 characters and removes HTML comments and format characters. Measure in D4c whether a prompt injection in a PR body still reaches a reviewer through the untrusted wrapper.
- A later run with no new hunk that resolved a stale thread posts a short review and writes a record with `identity.triage: null`, so the next run has no prior triage tier from that record. Carry the prior triage tier into that record, or read it from the record before it.
- Triage runs on the whole diff also when `--tier` or a label fixes the tier, for the categories of the brief. On a large pull request that query can reach its budget. Skip triage under an override, or raise its budget.
- A direct use of `action.yml` with a token other than the job token is unsupported: the viewer login is fixed to `github-actions[bot]` under GITHUB_ACTIONS. Read the login from the token instead.
- A reviewer subprocess runs with the head checkout as its cwd and `CLAUDE_CODE_OAUTH_TOKEN` in its env. The workspace keeps no git token now (`persist-credentials: false`). Whether `Read(./**)` follows a symlink out of the checkout is still unverified; add a test that no reviewer subprocess can reach `CLAUDE_CODE_OAUTH_TOKEN` through a symlink.
- A later run resolves a stale thread before it replies. When the reply then fails, the next run reads the thread as resolved by a person and marks the fingerprint dismissed. Record the resolved thread ids in the record and read them back, so a failed reply does not change the meaning of a resolve.
