# Tickets

This file lists the work that remains after D1 to D4a. D1 is the local walking skeleton. D2 is the full reviewer set and repo configuration. D3 is the GitHub review posting and CI packaging. D4a is the evaluation harness. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

The order of the deliverables is D5, then D4b, then D6, D7 and D8 in any order, then D4c. D5 gives the eval the labels and the metrics that D6 to D8 need to show their effect. The issues 18 to 28 of this repo hold the evidence behind D5 to D8. Each issue states its numbers from a run of this tool on six keyed pull requests.

Two facts shape the eval. First, one person maintains this repo and fixes almost every finding a reviewer posts, so a finding that a person acted on is no sign of its importance, and the findings posted on the PRs of this repo are not the full list of their real issues. The eval takes no golden from a record. Second, the eval is a tool for that one person, not a gate for a team. It runs on demand, and a small curated set that grows is worth more than a large set built up front.

## D5: Eval foundation

Goal: give the eval a severity policy, a labeler that applies it, a first curated case set, and the metrics that show where a change helps and where it hurts. Closes issues 26 and 27.

Done so far: `docs/design/severity-policy.md`, merged in PR #32.

- Add a severity labeler as the `pr-review label` subcommand, with its prompts under `prompts/`. For each golden finding, a scorer on Claude labels the severity and the category under the policy. A judge on a GPT model accepts the label or rejects it with a reason. A rejected label goes back to the scorer with the reason, at most twice. This loop runs three times per finding, and no run sees the calls of another. Two runs that agree set the label. Three different labels, or two or more runs that do not converge, send the finding to a human queue file. A disagreement log records each run's label, the policy section that each call cited, and whether the run converged, so the log shows which rule reads two ways. The judge runs through the Codex CLI as a subprocess that finds its own login. The tool reads no credential. The codex runner lives under `src/eval/label/`, and nothing in the run pipeline imports it. With `--write-golden` the labeler writes the three posted labels; the six-label schema of the case-set bullet is a later package of D5. Note the judge in section 1.
- Build the first curated set from the open-source benchmarks, with the sources `martian` and `reviewbench`. Their golden findings are already pooled and adjudicated. The labeler maps their severity onto the policy; do not copy the source label. The set holds the languages of the user's own repos: TypeScript, JavaScript and Python, with one Ruby case. Remove the four starter cases of D4a: the fixture is synthetic and the three PR cases took their goldens from fixes. The ten cases:

  | Source | Repo | PR | Language | Lines | Goldens |
  |--------|------|----|----------|-------|---------|
  | martian | calcom/cal.com | 8330 | TypeScript | 121 | 2 |
  | martian | ai-code-review-evaluation/sentry-greptile | 1 | Python | 138 | 3 |
  | martian | getsentry/sentry | 93824 | Python | 249 | 4 |
  | martian | ai-code-review-evaluation/discourse-graphite | 1 | Ruby | 32 | 4 |
  | reviewbench | axios/axios | 10836 | JavaScript | 12 | 2 true |
  | reviewbench | konturio/disaster-ninja-fe | 1166 | TypeScript | 15 | 3 true, 6 false |
  | reviewbench | namehash/ensnode | 1938 | TypeScript | 35 | 4 true, 2 false |
  | reviewbench | Marvell-Consulting/statswales-frontend | 626 | TypeScript | 57 | 6 true, 1 false |
  | reviewbench | jannekbuengener/Claire_de_Binare | 1550 | Python | 29 | 2 true, 9 false |
  | reviewbench | alexbol99/flatten-js | 244 | JavaScript | 85 | 5 true, 4 false |

  Built in jerridan/pr-review-cases PR #3. cal.com PR 14943 was in the plan: its head tree holds 116 MB of app-store media, and the bundle is over the GitHub file limit, so namehash/ensnode 1938 takes its place. A large project needs `scripts/fetch-pr.sh` first, so the bundle holds two snapshots and the case holds a `shallow` file. Two source goldens are left out, see the README of the cases repo. Martian goldens have no span in the source; a model located each span, and the note of the golden gives the confidence.

  ReviewBench marks each golden true or false. A false golden becomes a not-real golden, so the golden schema allows the six labels of the policy from this deliverable. Recall counts the three posted labels. A posted finding that matches a not-real golden is a false positive. Amend the line in the policy that limits a golden to the three posted labels.
- Done 2026-11-08: two labeling rounds ran (first-pass acceptance 0.69 in both; judge rejections fell from 35 to 31; round 1 and round 2 gave the same majority label for 32 of 35 findings). The policy gained three paragraphs: rare inputs and documented setups are normal paths, a normal-path defect with only a visible recoverable loss is a suggestion, and the switch rule holds when the PR exists to add the gated feature. The set has 29 posted goldens; six findings landed on don't post, not real or unsure and sit in `not-real.json`. Open stances for the user: the scorer still opens with suggestion for numeric corner cases and for defects behind new default-off switches, and the judge holds the policy line each time.
- Done 2026-11-08: the pin moved to the ten cases and `eval/baseline.json` holds the first run: recall 0.287, precision 0.636, one repeat, nine of ten cases (the discourse case failed, see D6). The eval job runs on manual dispatch only; section 8 records the local practice. Five ReviewBench cases posted no finding at all, and cost per case was $4.25 against $0.6 to $1.4 in D1: issue #18 in numbers.
- Score `stages.reviewers[].findings` against the goldens beside `posted.findings`. Print raw recall, posted recall and the per-stage drop counts from `explain` in the eval table.
- Report precision against adjudicated extras: a posted finding that matches no golden goes to a judge before it counts as false. An extra the judge accepts queues as a candidate golden for the next case revision. The set never changes during a run.
- Report cost per PR beside every metric. Each later deliverable adds reading, passes or posts, so the cost must stay visible.

## D4b: More eval cases

Goal: grow the case set in small revisions, about five cases each. Depends on D5: every new case takes its severity labels from the labeler.

- Add more cases from Martian and ReviewBench while the set stays under about 30. Keep the spread of language, category and size.
- Add cases from jerridan/websites, jerridan/walle and jerridan/pr-review, picked for variety of size and change type, not for their record. Build their goldens from a pool: two blind reviews each by a Claude model and a GPT model with no sight of any comment, plus the findings of every recorded run. Anonymise the pool. Both families adjudicate each item. Keep an item both rate at 75 or above. A PR whose pool adjudicates to nothing is a clean case and measures precision only.
- A dismissed finding from a record becomes a golden with the label not real or don't post, after the pool adjudicates it. These are the only goldens a record gives. A posted finding that matches a don't-post golden is noise.
- Add a few cases by bug injection into jerridan/websites and jerridan/walle, with the source `injection`. Each injected bug is one golden finding. Keep them few: synthetic cases overstate quality.
- Make each case with `scripts/make-case.sh` and add it to the cases repo as its README says. Each revision moves the pin in `eval/cases.json`, writes a new baseline with `--write-baseline` and re-derives the margins by the rule in the README, in one PR.

## D6: Verifier inputs and rubric

Goal: make the verifier score whether a claim is true, and give it the inputs it needs to check one. Closes issues 18, 19 and 24. Depends on D5 for the measurement and for the policy.

- The score answers one question: is the claim true of the code. Remove the question on whether a careful reviewer posts the finding. The severity step applies the policy and decides what posts, including don't post. Post when `claim_holds` is true and the score is at or above the threshold. Keep the escalation band. Let agreement on `claim_holds` from the escalation override a score below the threshold.
- Add an `unsure` result for a claim the repository cannot settle. It never posts. The record and the eval count it apart from a rejection.
- An escalation that reaches its budget must not fail the review. On 2026-11-08 the first eval run of the discourse case failed whole because the Opus escalation of one finding in a 1000-line locale file reached its $1 budget. Give that finding the `unsure` result, record the budget stop, and let the review complete. The eval then counts the case.
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
