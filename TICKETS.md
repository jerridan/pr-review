# Tickets

This file lists the work that remains after D1 to D4a. D1 is the local walking skeleton. D2 is the full reviewer set and repo configuration. D3 is the GitHub review posting and CI packaging. D4a is the evaluation harness. Each ticket is one deliverable: one branch, one PR. The design is `docs/design/high-level-design.md`; section numbers below refer to it.

The order of the deliverables is D5, then D4b, then D6, D7 and D8 in any order, then D4c. D5 gives the eval the labels and the metrics that D6 to D8 need to show their effect. The issues 18 to 28 of this repo hold the evidence behind D5 to D8. Each issue states its numbers from a run of this tool on six keyed pull requests.

Two facts shape the eval. First, one person maintains this repo and fixes almost every finding a reviewer posts, so a finding that a person acted on is no sign of its importance, and the findings posted on the PRs of this repo are not the full list of their real issues. The eval takes no golden from a record. Second, the eval is a tool for that one person, not a gate for a team. It runs on demand, and a small curated set that grows is worth more than a large set built up front.

## D5: Eval foundation

Goal: give the eval a severity policy, a labeler that applies it, a first curated case set, and the metrics that show where a change helps and where it hurts. Closes issues 26 and 27.

Done so far: `docs/design/severity-policy.md`, merged in PR #32.

- Add a severity labeler as the `pr-review label` subcommand, with its prompts under `prompts/`. For each golden finding, a scorer on Claude labels the severity and the category under the policy. A judge on a GPT model accepts the label or rejects it with a reason. A rejected label goes back to the scorer with the reason, at most twice. This loop runs three times per finding, and no run sees the calls of another. Two runs that agree set the label. Three different labels, or two or more runs that do not converge, send the finding to a human queue file. A disagreement log records each run's label, the policy section that each call cited, and whether the run converged, so the log shows which rule reads two ways. The judge runs through the Codex CLI as a subprocess that finds its own login. The tool reads no credential. The codex runner lives under `src/eval/label/`, and nothing in the run pipeline imports it. With `--write-golden` the labeler writes every chosen label, since the six-label schema of 2026-11-08. Note the judge in section 1.
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

  ReviewBench marks each golden true or false. A false golden becomes a not-real golden, so the golden schema allows the six labels of the policy from this deliverable. Recall counts the three posted labels. A posted finding that matches a not-real golden is a false positive. Amend the line in the policy that limits a golden to the three posted labels. Done 2026-11-08: the schema takes the six labels, the 28 not-real findings are goldens in the cases repo (branch `six-label-goldens`, 57 goldens in all), and the policy line is amended.
- Done 2026-11-08: two labeling rounds ran (first-pass acceptance 0.69 in both; judge rejections fell from 35 to 31; round 1 and round 2 gave the same majority label for 32 of 35 findings). The policy gained three paragraphs: rare inputs and documented setups are normal paths, a normal-path defect with only a visible recoverable loss is a suggestion, and the switch rule holds when the PR exists to add the gated feature. The set has 29 posted goldens; six findings landed on don't post, not real or unsure and sit in `not-real.json`. Open stances for the user: the scorer still opens with suggestion for numeric corner cases and for defects behind new default-off switches, and the judge holds the policy line each time.
- Done 2026-11-08: the pin moved to the ten cases and `eval/baseline.json` holds the first run: recall 0.287, precision 0.636, one repeat, nine of ten cases (the discourse case failed, see D6). The eval job runs on manual dispatch only; section 8 records the local practice. Five ReviewBench cases posted no finding at all, and cost per case was $4.25 against $0.6 to $1.4 in D1: issue #18 in numbers.
- Done 2026-11-08: the eval scores `stages.reviewers[].findings` against the goldens beside `posted.findings`, and prints raw recall, posted recall and the per-stage drop counts from `explain` in the eval table.
- Done 2026-11-08: a posted finding that matches no golden goes to the extras judge (`prompts/extras-judge.md`) before it counts as false; the table shows strict and adjudicated precision; an accepted extra goes to `<out>/<case>/candidates.json` for the next case revision; the set never changes during a run; `--no-extras` turns it off.
- Done 2026-11-08: the table shows cost and judge cost on every repeat row and `cost per PR` and `judge cost per PR` in the summary. Each later deliverable adds reading, passes or posts, so the cost must stay visible.

## D4b: More eval cases

Goal: grow the case set in small revisions, about five cases each. Depends on D5: every new case takes its severity labels from the labeler.

- Add more cases from Martian and ReviewBench while the set stays under about 30. Keep the spread of language, category and size.
- Add cases from jerridan/websites, jerridan/walle and jerridan/pr-review, picked for variety of size and change type, not for their record. Build their goldens from a pool: two blind reviews each by a Claude model and a GPT model with no sight of any comment, plus the findings of every recorded run. Anonymise the pool. Both families adjudicate each item. Keep an item both rate at 75 or above. A PR whose pool adjudicates to nothing is a clean case and measures precision only.
- A dismissed finding from a record becomes a golden with the label not real or don't post, after the pool adjudicates it. These are the only goldens a record gives. A posted finding that matches a don't-post golden is noise.
- Add a few cases by bug injection into jerridan/websites and jerridan/walle, with the source `injection`. Each injected bug is one golden finding. Keep them few: synthetic cases overstate quality.
- Make each case with `scripts/make-case.sh` and add it to the cases repo as its README says. A revision adds its cases to the cases repo and does not move the pin or write a baseline. After the last revision, one final baseline PR moves the pin in `eval/cases.json` one time, writes the baseline with `--write-baseline` at two repeats and re-derives the margins by the rule in the README. Why: a baseline at two repeats does not fit in one five-hour plan window, and the eval and the CI reviewer use the same plan login. The final baseline run uses `--resume`, so a run that stops continues from the complete cases.
- Done 2026-11-11: the 25 posted findings of the D6 gate run that matched no golden went through the labeling loop and joined the set as goldens (22 posted, 3 not real; cases repo PR #5). The set holds 82 goldens, 51 posted. The pin moved to e6ddf81 and the baseline at 0.5.0 reads recall 0.396, precision 0.722, cost per PR $4.65 at one repeat. The margins stay at 0.1 and 0.35: one repeat gives no spread.
- Done 2026-11-12, R4: `scripts/inject-case.sh` makes an injection case. It squashes a merged host PR and one bug patch into one commit, so the history, the blame and the PR text do not show the bug. Four cases are in the cases repo (PR #6, merge commit `a2ad8d5`): `injection-websites-130`, `injection-websites-120`, `injection-walle-21` and `injection-walle-6`. Each holds one golden, the injected bug. The labeling loop gave 2 blocking and 2 suggestion, and the three runs agree for each finding. The pin move and the baseline come in the final D4b baseline PR.
- R2 in progress 2026-11-12: `pr-review pool` builds the goldens of an own-repo case, and `pr-review adjudicate` adjudicates one finding, such as a finding from a record (R3 uses it). See the README. Six cases have the source `pool`, two each from jerridan/websites, jerridan/walle and jerridan/pr-review (cases repo branch `r2-own-repo-cases`). A case uses the head that the first recorded run saw: a later head holds the fixes of the review findings. The pool of three cases adjudicated to no item: walle 14, walle 16 and websites 130 are clean cases. The pin move and the baseline come in the final D4b baseline PR.
- R3 in progress 2026-11-12: `pr-review pool --dismissed` turns the findings that the verifier dismissed into goldens through the pool. A dismissed finding counts only when its record saw the head of the case. When both families keep it, the labeler gives its label. When both score it below 50, it becomes a golden that the labeler labels, normally `not_real`. Any other result gives no golden. No record holds a finding that a person dismissed. The records hold 19 dismissed findings, all in jerridan/pr-review PRs 41, 44, 45 and 46, and 7 of them are at the first recorded head. The four cases `pool-pr-review-41`, `-44`, `-45` and `-46` go to cases repo branch `r3-dismissed-findings`. `pr-review pool --resume` reuses the calls that succeeded, so a run that a usage limit stops costs no second Claude call. The existing scoring already counts a posted finding that matches a `dont_post` golden as a false positive. The pin move and the baseline come in the final D4b baseline PR.

Proposed split (a recommendation; the agent that runs D4b can choose a different one): four revisions. Each revision can be one PR in this repo and one PR in the cases repo. No revision moves the pin or writes a baseline: the final baseline PR does both, one time, for all four. A baseline costs about $6 per case per repeat.

- R1, benchmark cases: about five cases from Martian and ReviewBench. The labeler and `scripts/make-case.sh` are sufficient, so R1 needs no new tooling.
- R2, own-repo cases: cases from jerridan/websites, jerridan/walle and jerridan/pr-review with pooled goldens. R2 needs the pool tooling: two blind reviews per family, the anonymised pool, and the adjudication by both families.
- R3, dismissed findings: the dismissed findings of the records become not-real or don't-post goldens. R3 depends on R2, because the R2 pool adjudicates each finding.
- R4, injection cases: a few cases by bug injection into jerridan/websites and jerridan/walle, with the source `injection`. R4 does not depend on R2 or R3. D4c and D7 need the injection measurement.

## D6: Verifier inputs and rubric

Goal: make the verifier score whether a claim is true, and give it the inputs it needs to check one. Closes issues 18, 19 and 24. Depends on D5 for the measurement and for the policy.

- The score answers one question: is the claim true of the code. Remove the question on whether a careful reviewer posts the finding. The severity step applies the policy and decides what posts, including don't post. Post when `claim_holds` is true and the score is at or above the threshold. Keep the escalation band. Let agreement on `claim_holds` from the escalation override a score below the threshold.
- Add an `unsure` result for a claim the repository cannot settle. It never posts. The record and the eval count it apart from a rejection.
- An escalation that reaches its budget must not fail the review. On 2026-11-08 the first eval run of the discourse case failed whole because the Opus escalation of one finding in a 1000-line locale file reached its $1 budget. Give that finding the `unsure` result, record the budget stop, and let the review complete. The eval then counts the case.
- Give the verifier the same description block the reviewers get: the PR title, labels and body when the run has them, else the commit messages.
- Give the verifier the git facts it needs as data blocks from gather: the log and blame of the changed lines and the diff against the merge base. Gather reads git, not the verifier. The verifier gets no Bash. Section 3.4 and section 6 keep that rule.
- Inline a window of `WINDOW_LINES` around the span when the head file exceeds `INLINE_FILE_MAX_LINES`. Keep Read available for the rest.
- Ship only when the eval shows precision at or above the baseline. Low noise is the first goal of section 1.
- Done 2026-11-09: the first six items shipped on their own criteria. Item 7 was not met on its own metric, and the principal waived it on the adjudicated reading below. The eval at one repeat with `--no-extras` on the ten pinned cases gave recall 0.433 (baseline 0.287), strict precision 0.342 (baseline 0.636), cost per PR $4.41 (baseline $4.25), and all ten cases completed (the discourse case included). The 25 posted findings that matched no golden went through the D5 labeling round (Opus scorer, sol judge, three runs): 22 got a posting label (7 blocking, 13 suggestion, 2 nit) and 3 did not (2 don't post, 1 unsure), so 35 of 38 posted findings are real under the policy: adjudicated precision 0.921. The strict drop comes from the golden sets, not the verifier. The 22 labeled findings are candidates for the cases repo. The verifier gave don't post 15 times and not real 4 times over 92 verifications, and no limit stop occurred.

## D7: Reviewer briefing and reading plans

Goal: give the finders the briefing and the reading procedure that find the serious items. Closes issues 20 and 25. Depends on D5 for the measurement.

- Done 2026-11-09 in D6: the description block holds the PR title, labels and body when the run has a PR, else the commit messages, and every reviewer and the verifier get it.
- Done 2026-11-11: the reviewer user message holds a `changed_files` block before the diff and tells the reviewer to read each changed file in full before it reports. A deleted file has its own line. The triage brief and the diff stay.
- Done 2026-11-11: diff-bugs, history and tests each have a reading plan in numbered steps: the changed files in full, then the callers and callees, then the tests that cover the changed behaviour. The history plan matches the blame lines of prior fixes against the diff.
- Each finding names the file and the line it rests on. This rule exists; keep it.
- Done 2026-11-11: the read-in-full step lives in the reading plans of diff-bugs, history, tests and security, not in the shared user message. In the eval above, conventions, docs-and-comments and description-drift cost $7.37 against $3.28 before D7, for findings that are rarely serious. Security gained a reading plan. The eval of this change at one repeat gave recall 0.438, precision 0.714, adjudicated precision 0.786, raw recall 0.568 and cost per PR $5.00 (baseline 0.5.0: $4.65). The three reviewers cost $3.32. The precision drop comes mostly from sentry-greptile, where four posted findings state one defect on the same line and the merge did not join them; six extras judge queries also gave no answer. That merge miss is a follow-up, not part of D7.
- Done 2026-11-11: the eval at one repeat on the pinned cases (`e6ddf81`) gave recall 0.431 (baseline 0.396), precision 0.818 (baseline 0.722), adjudicated precision 0.939, raw recall 0.616 and cost per PR $6.03 (baseline $4.65, 30% more). All ten cases completed. Four ReviewBench cases still posted at most one finding, and ensnode 1938 posted none: every reviewer pass returned an empty list.
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

- The merge step let four findings of one defect post apart on sentry-greptile (paginator.py line 838, the D7 eval of 2026-11-11). Find why the semantic merge did not join them.

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
