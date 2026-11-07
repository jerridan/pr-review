# Tickets

This file lists the work that remains after D1 to D4a. D1 is the local walking skeleton. D2 is the full reviewer set and repo configuration. D3 is the GitHub review posting and CI packaging. D4a is the evaluation harness. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

The order of the deliverables is D5, then D4b, then D6, D7 and D8 in any order, then D4c. D5 gives the eval the metrics and the labels that D6 to D8 need to show their effect. The issues 18 to 28 of this repo hold the evidence behind D5 to D8. Each issue states its numbers from a run of this tool on six keyed pull requests.

## D5: Eval foundation

Goal: make the eval able to show where a change helps and where it hurts, before any prompt or threshold moves. Closes issues 26 and 27.

- Write `docs/design/severity-policy.md`. It defines blocking, suggestion and nit by consequence and by the path a person needs to reach the problem. It also defines the three outcomes that do not post: don't post, not real and unsure. It covers normal and unusual paths, stored data, tests and missing tests, partly true claims, messages and status codes, process findings and accessibility. An accessibility problem that stops a keyboard or screen-reader user from a task is blocking. The verifier prompt, the eval judge prompt and the labeler all use this one policy. Section 3.5 and decision 7 point to it.
- Add a labeling loop in `scripts/`, with its prompts under `prompts/`. A scorer model labels the severity and the category of each golden finding under the policy. A judge model from another model family accepts the label or rejects it with a reason. A rejected label goes back to the scorer with the reason, at most twice. An accepted label is gold. A label that never converges goes to a human queue file. The loop writes the first-pass acceptance rate to the case set, because that rate is the bar a severity agreement is read against. The judge credential stays outside the tool: `scripts/` only, never `src/`. Note this in section 1 and section 8.
- Build the golden findings of a case from a pool, not from the output of this tool alone: every finding from every recorded run, plus two blind reviews by a strong model with no sight of any comment. Anonymise the pool. Two model families adjudicate each item. Keep an item that both rate at 75 or above.
- Score `stages.reviewers[].findings` against the goldens beside `posted.findings`. Print raw recall, posted recall and the per-stage drop counts from `explain` in the eval table.
- Report precision against adjudicated extras: a posted finding that matches no golden goes to the judge before it counts as false.
- Report cost per PR beside every metric. Each later deliverable adds reading, passes or posts, so the cost must stay visible.

## D4b: More eval cases

Goal: grow the case set of the eval beyond the starter set of D4a (section 8). A larger set lets the metrics separate one prompt or model from another. Depends on D5: every new case takes its severity labels from the labeling loop, and its goldens from the pool.

- Add cases from ReviewBench and Martian, with the sources `reviewbench` and `martian`. Their severity scales differ from ours. The labeling loop maps them onto the policy; do not copy the source label.
- Add cases by bug injection into jerridan/websites and jerridan/walle, with the source `injection`. Each injected bug is one golden finding.
- Add cases from real records where a person acted on or dismissed a finding, with the source `record`.
- Make each case with `scripts/make-case.sh` and add it to the cases repo as its README says. Move the pin in `eval/cases.json` and write a new baseline with `--write-baseline` in the same PR.
- The gate margin tightens as the set grows, because a larger set has a smaller spread. Re-derive each margin from the new baseline run by the rule in the README.

## D6: Verifier inputs and rubric

Goal: make the verifier score whether a claim is true, and give it the inputs it needs to check one. Closes issues 18, 19 and 24. Depends on D5 for the measurement and for the policy.

- The score answers one question: is the claim true of the code. Remove the question on whether a careful reviewer posts the finding. The severity step applies the policy and decides what posts, including don't post. Post when `claim_holds` is true and the score is at or above the threshold. Keep the escalation band. Let agreement on `claim_holds` from the escalation override a score below the threshold.
- Add an `unsure` result for a claim the repository cannot settle. It never posts. The record and the eval count it apart from a rejection.
- Give the verifier the same description block the reviewers get: the PR title, labels and body when the run has them, else the commit messages.
- Give the verifier the git facts it needs as data blocks from gather: the log and blame of the changed lines and the diff against the merge base. Gather reads git, not the verifier. The verifier gets no Bash. Section 3.4 and section 6 keep that rule.
- Inline a window of `WINDOW_LINES` around the span when the head file exceeds `INLINE_FILE_MAX_LINES`. Keep Read available for the rest.
- Ship only when the eval shows precision at or above the baseline. Low noise is the first goal of section 1.

## D7: Reviewer briefing and reading plans

Goal: give the finders the briefing and the reading procedure that find the serious items. Closes issues 20 and 25. Depends on D5 for the measurement.

- Gather fills the description block with the PR title, labels and body when the run has a PR, as section 3.1 already says. Today it uses the commit messages always. Fix the gap.
- The reviewer user message lists the changed files and tells the reviewer to read each one in full before it reports. Keep the triage hotspots. Keep the diff available, but not as the only context.
- Give diff-bugs, history and tests a reading plan in concrete steps: the changed files in full, then the callers and callees of the changed code, then the tests that cover the changed behaviour. Write steps, not exhortations. The 5.5 guidance says a line such as "be thorough" costs tokens and adds nothing.
- Each finding names the file and the line it rests on. This rule exists; keep it.
- Run the injection measurement of D4c with this change, because the PR body now reaches every reviewer and the verifier.

## D8: Passes default

Goal: set two passes for the reviewers that find serious bugs. Closes issue 21. Depends on D5 for the measurement.

- Set `passes: 2` for history and tests at the full tier. diff-bugs and security already have it. The fast tier stays at one pass.
- Report recall, precision and cost per PR for one pass against two on the D4b case set, with at least 20 runs per arm. `docs/research/passes-recall.md` could not separate the arms on the fixture.
- Add a per-reviewer turn budget, default 150 turns, as the knob a repo uses to buy depth. Issue 22 shows the dispatch mechanism is a cost knob and not a recall knob.

## Design updates from issues 22, 23 and 28

Goal: record three decisions in the design. No code change. Can ride with any deliverable above.

- Section 10: one SDK `query()` per reviewer pass is the dispatch mechanism. A subagent mode, if ever added, is a budget option for the deep reviewers and not a recall lever. Closes issue 22.
- Section 6: when a trusted custom reviewer gets Bash, the run allows read-only git commands and denies fetch, pull, checkout, switch and gh by deny rules, not by the allow list alone. The record lists every permission denial. Closes issue 28.
- Section 3.6: the cap stays until D4c measures it against real records. If it changes, it caps nits only. Issue 23 stays open until then.

## D4c: First experiments

Goal: run the first experiments on the eval and write the results to `docs/research/`.

- diff-bugs on Opus 5.5 low against Sonnet 5.5 medium, on cost per confirmed finding.
- One Opus reviewer at medium over the whole diff against the specialist set.
- The verifier on Sonnet 5.5 high against Opus 5.5 high.
- The 0 to 100 score against a 5-band scale.
- The non-blocking cap formula against real records. Decides issue 23.
- A prompt injection in a PR body against the sanitizer and the untrusted wrapper, after D7.

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
