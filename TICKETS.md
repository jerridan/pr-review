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
- Done 2026-11-12, R1: four benchmark cases are in the cases repo (PR #8): `martian-sentry-67876` (Python, 297 changed lines), `martian-calcom-10600` (TypeScript, 316), `reviewbench-spm-19` (TypeScript, 543) and `reviewbench-node-postgres-3650` (JavaScript, 568). They add 56 goldens, 32 posted and 24 not real, and the first goldens in `security`, `performance` and `test`. The labeling loop set every severity, and no finding went to the human queue. The set holds 18 cases and 142 goldens, 87 posted. `reviewbench-42-transcendence-115` (Python, 779 lines, 29 goldens) is built but not labeled, because the usage limit of the judge stopped its labels; a later revision can add it. The labels cost $17 of scorer calls, and $12 more went to runs that the judge limit stopped. The pin move and the baseline come in the final D4b baseline PR.
- Done 2026-11-12, R2: `pr-review pool` builds the goldens of an own-repo case, and `pr-review adjudicate` adjudicates one finding, such as a finding from a record (R3 uses it). See the README. Six cases have the source `pool`, two each from jerridan/websites, jerridan/walle and jerridan/pr-review (merged in the cases repo). A case uses the head that the first recorded run saw: a later head holds the fixes of the review findings. The pool of three cases adjudicated to no item: walle 14, walle 16 and websites 130 are clean cases. The pin move and the baseline come in the final D4b baseline PR.
- Done 2026-11-12, R3: `pr-review pool --dismissed` turns the findings that the verifier dismissed into goldens through the pool. A dismissed finding counts only when its record saw the head of the case. When both families keep it, the labeler gives its label. When both score it below 50, it becomes a golden that the labeler labels, normally `not_real`. Any other result gives no golden. No record holds a finding that a person dismissed. The records hold 19 dismissed findings, all in jerridan/pr-review PRs 41, 44, 45 and 46, and 7 of them are at the first recorded head. The four cases `pool-pr-review-41`, `-44`, `-45` and `-46` are merged in the cases repo. `pr-review pool --resume` reuses the calls that succeeded, so a run that a usage limit stops costs no second Claude call. The existing scoring already counts a posted finding that matches a `dont_post` golden as a false positive. The pin move and the baseline come in the final D4b baseline PR.
- Done 2026-11-14, final baseline: the pin moved to `373266b` (28 cases, 186 goldens), and `eval/baseline.json` at 0.10.0 holds the first baseline at two repeats: recall 0.542, precision 0.598, adjudicated precision 0.674, raw recall 0.640, cost per case $4.66 plus $0.09 of judge calls. The spread over the two repeats is 0.023 for recall and 0.014 for precision, so the README rule gives both margins 0.05. The run took five plan windows with `--resume`, at $265.90 in all, and no repeat failed. `test/eval-pin.test.ts` checks that the baseline `cases_ref` equals the pin and that the baseline has two repeats or more.

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

- Set `passes: 2` for history and tests at the full tier when the measurement below supports it. diff-bugs and security already have it. The fast tier stays at one pass. Done 2026-11-14: the measurement does not support it, so history and tests stay at one pass (see the done line of the measurement).
- Add a per-reviewer turn budget, default 150 turns, as the knob a repo uses to buy depth. Issue 22 shows the dispatch mechanism is a cost knob and not a recall knob.
- Measure one pass against two by the design below, and write the result to `docs/research/passes-recall.md`. That note could not separate the arms on the fixture.
- Done 2026-11-14, measurement tooling at 0.12.0: the run record names the reviewer passes that raised each verified and posted finding, the pass of each reviewer query, and the verification of each verifier query. Each eval repeat keeps its judge answers in `judge-cache.json`. `pr-review eval --paired` adds the paired report, and `pr-review eval-report` makes it again from an `--out` directory with no model call. `--reviewers` and `--passes` limit a run to named reviewers and set their passes. `pr-review eval-subset` makes a cases directory by a cost limit or by a budget, and `--write-baseline` now writes the cost per case. A record from before 0.12.0 has no source fields, so the paired report names its repeats as missing and gives no figures for them. The `--out` directory of the D4b baseline run no longer exists, so its cost per case and its records are in no file: the paired report of diff-bugs and security from those records cannot be made.

- Done 2026-11-14, measurement: history and tests stay at one pass. One repeat of history and tests at two passes on the 28 pinned cases cost $89.15. history: a second pass added 4 posted-label goldens (2 blocking) at $2.95 per added golden against $0.61 per golden of one pass. R is 4.83, with a 90% interval of 2.68 to 10.18, so (b) fails. The precision went from 0.880 to 0.839, so (c) holds. tests: a second pass added 1 golden and 11.5 false posted findings. R is 19.29, with no upper bound, and the precision went from 0.593 to 0.483, so (b) and (c) fail. The run records of the D4b baseline do not exist, so the note has no figures for diff-bugs and security. `docs/research/passes-recall.md` holds every figure.

Measurement design. An earlier version of this entry asked for 20 runs per arm on the D4b case set. The D4b baseline showed that this is not possible: one run of the 28 cases costs about $133, the eval runs on the plan login, and one dollar uses about 0.93 points of a five-hour plan window. Forty runs are about $5,300 and about 100 windows. The design below gives the same answer for about $150.

- Use paired arms. Run only the two-pass arm. A run record names the pass of each reviewer finding, so the one-pass arm is the same run with the findings of pass 2 left out. The two arms then share every other source of noise, and one run gives the two figures.
- Give the eval a paired report. For each run, it scores two sets against the goldens: the findings that pass 1 raised, and all the findings. For each set it reports raw recall, posted recall, precision and cost. A posted finding belongs to the one-pass set when a pass 1 finding is one of its sources. The cost of the one-pass set leaves out the reviewer queries of pass 2 and the verifications of the findings that only pass 2 raised.
- Give the eval an option that limits a run to named reviewers. The measurement runs history and tests only, each with two passes. This measures the two reviewers alone, so the gain is an upper limit of the gain in the full pipeline, where another reviewer can raise the same finding.
- Use the cases that the budget permits. Done: one run of the measurement arm cost about $3.20 per case, so one repeat of all 28 cases fit in the budget, and the measurement used no subset. The two passes of one reviewer are two independent samples of one pass, so one repeat gives the one-pass arm two times.
- Set a budget, not a run count. The measurement uses at most $150 of model calls. Done: one repeat of the 28 cases, $89.15. Three repeats of the 28 cases did not fit. The principal chose all 28 cases at one repeat over three repeats of ten cases, because the count of goldens decides how stable the result is.
- Run with `--resume`, and stop a run when the cases completed in one plan window reach $75.
- Report, for each of the two reviewers and for the two together, three sets: pass 1, pass 2 and both. For each set: the posted-label goldens by label, the false posted findings, the precision and the cost. Then the added goldens and false findings of both over the one-pass mean, the goldens and false findings that only pass 2 raised, the added cost per added golden, and a 90% bootstrap interval over the cases. `pr-review eval-report --by-pass` makes this report from the stored records.
- If the run records of the D4b baseline still exist, make the same paired report for diff-bugs and security from them. Those records hold two passes of the two reviewers, so this costs nothing. If the records do not exist, state that and do not run the baseline again for it.
- Decide by this rule: a reviewer gets `passes: 2` at the full tier when (b) the upper end of the 90% bootstrap interval of R is at most 2, where R is the added cost per added posted-label golden over the one-pass cost per posted-label golden, and (c) the precision of both is no more than 0.05 below the one-pass precision. A resample with no added golden counts as R above 2. This rule replaces the first rule, "a paired gain above zero in every repeat": the set of both can never match fewer goldens than a single set, so the first rule could not fail.
- After the default changes, run the full pipeline one time on the subset with the gate. Write a new baseline only if the gate fails, and only on the word of the principal: a baseline at two repeats on the 28 cases costs about $270 and five plan windows.

## Design updates from issues 22, 23 and 28

Goal: record three decisions in the design. No code change. Can ride with any deliverable above.

- Section 10: one SDK `query()` per reviewer pass is the dispatch mechanism. A subagent mode, if ever added, is a budget option for the deep reviewers and not a recall lever. Closes issue 22.
- Section 6: when a trusted custom reviewer gets Bash, the run allows read-only git commands and denies fetch, pull, checkout, switch and gh by deny rules, not by the allow list alone. The record lists every permission denial. Closes issue 28.
- Section 3.6: the cap stays until D4c measures it against real records. If it changes, it caps nits only. Issue 23 stays open until then.

## D4c: First experiments

Goal: run the first experiments on the eval and write the results to `docs/research/`, one note for each experiment. An experiment changes a default only by its decision rule.

### Rules for every experiment

D4b and D8 gave these rules. Each one comes from a loss in those runs.

- Probe first. Before a full run, run two cases and record their cost. Compute the cost of the full run from the probe, not from an estimate.
- Test the decision rule before the figures exist. Show with made-up figures that the rule can give each of its results. The first D8 rule could not fail.
- Set the budget in dollars before the run. Stop when the budget is reached, and report what the budget gave.
- One paid run at a time. The eval and the CI reviewer run on the plan login, and one dollar uses about 0.93 points of a five-hour plan window. Run with `--resume` and a dollar limit for each window.
- A model of a second family runs through the Codex CLI, on its own quota. That quota holds about 20 minutes of work in five hours, so each such step must resume.
- Write the run records under the crew record root, not in a worktree or a scratchpad. The records of the D4b baseline were lost with a worktree.
- Use paired arms when one run can give the two arms. When two arms need two runs, report the noise of one pass, which `eval-report --by-pass` gives for each reviewer with two passes, and do not claim a difference that is smaller than that noise.
- Each note states the method, the budget and the spend, every figure, the decision rule, the result, and the limits of the measurement.

### Shared parts

- S1, the reference run. One repeat of the full pipeline at the current defaults on the 28 pinned cases, with stored records. About $133. It is the comparison arm of E1 and E2, and it holds the candidate findings for E3 and E4. It also gives the two-pass figures of diff-bugs and security that D8 could not give.
- S2, the replay tool. It reads the candidate findings of a stored run and verifies them again with another verifier model or another verifier prompt, and it scores the result as the eval does. It also takes candidate findings from a reviewer outside the pipeline, such as a Codex review, so that those findings pass the same verifier.
- S3, the size groups. Give each case its count of changed lines, and split the cases into three groups of about equal count: small, medium and large.
- S4, the model option. An eval option sets the model and the effort of named reviewers, or of all reviewers, for one run.

### E1: the model and the effort of each reviewer

Question: does each reviewer have the right model and effort? Today all seven reviewers run on Opus 5.5 at low effort, because no reviewer file sets a model.

- Arms: Opus 5.5 low (S1), Opus 5.5 medium, Sonnet 5.5 medium, and Sonnet 5.5 high if the budget permits. One run of an arm holds all seven reviewers, and the record gives the findings and the cost of each reviewer, so one run measures seven reviewers.
- Cases: a subset of 14, taken evenly from the three size groups of S3. Use the S1 records of the same 14 cases for the first arm.
- Report for each reviewer and each arm: the posted-label goldens found, the false posted findings, the precision, the cost, and the cost per posted-label golden.
- Rule for a cheaper setting: a reviewer moves to it when it finds no fewer posted-label goldens than the current setting, less the noise of one pass, and its precision is not more than 0.05 lower.
- Rule for a dearer setting: a reviewer moves to it when the added cost per added posted-label golden is at most two times the current cost per posted-label golden, at the upper end of a 90% bootstrap interval over the cases, and its precision is not more than 0.05 lower. This is the D8 rule.
- Budget: $200 for the three new arms.

### E2: one reviewer over the whole diff against the specialist set

Question: when does one reviewer do as well as the seven specialists? The theory of the principal: one reviewer does well on a small PR, the specialists do better on a large one, and a line exists between the two.

- Arms: the specialist set (S1); one Opus 5.5 reviewer at medium; one Opus 5.5 reviewer at high; one Sol reviewer through the Codex CLI.
- The three single arms use one prompt, a general review of the whole diff. Their findings pass the same verifier as the specialist findings, through S2. Report each arm before and after the verifier.
- Leave the ten `pool` cases out of the main figures, and report them apart. Their goldens came from blind single reviews by Opus and by Sol, so those cases favour a single reviewer of the same model.
- Report for each arm and each size group of S3: the posted-label goldens found, the precision, and the cost. Report the difference between the specialist set and each single arm for each case against the changed lines of the case.
- The line: fit the difference against the changed lines, and give the size where the difference crosses zero, with a 90% bootstrap interval. If the interval covers the full range of the cases, state that the line is not found, and state how many more large cases the measurement needs.
- This experiment changes no default. Its result is the evidence for a tier rule by size, which is a design decision of the principal.
- Budget: $120 for the two Opus arms and their verification. The Sol arm uses the Codex quota.

### E3: the model of the verifier

Question: which model verifies best? Today the verifier is Sonnet 5.5 at high effort.

- Arms: Sonnet 5.5 high (S1), Opus 5.5 high, and Terra through the Codex CLI. Each arm verifies the same stored candidates of S1, through S2, so the arms are paired.
- Report for each arm: of the candidates that match a posted-label golden, the share that it keeps; of the candidates that match a not-real golden or no golden, the share that it rejects; the posted recall and precision that follow; the count of unsure results and of escalations; and the cost per verification.
- Rule: a model becomes the verifier when its posted precision is not lower than that of the current verifier, its posted recall is higher with a 90% bootstrap interval of the difference above zero, and its cost per verification is at most two times the current cost.
- A verifier of a second family needs the Codex CLI in CI. If Terra passes the rule, the note reports that, and the principal decides.
- Budget: $60 for the Opus arm. The Terra arm uses the Codex quota.

### E4: the score scale of the verifier

Question: does a scale of five bands work as well as the score from 0 to 100?

- Arms: the current verifier prompt (S1), and the same prompt with five named bands. The two verify the same stored candidates through S2, on the current verifier model.
- Report the figures of E3 for each arm, and for each band or each score range the share of candidates that are real.
- Rule: the five bands become the default when the posted recall and the posted precision are each not more than 0.05 lower and the count of escalations is lower.
- Budget: $30.

### E5: the cap on non-blocking findings

Question: does the posting cap drop findings that matter? Decides issue 23.

- Method: no model call. Read every recorded run. For each one, list the findings that the cap dropped, with their severity. Then compute what a cap on nits only would post.
- Rule: if the cap dropped a blocking or a suggestion finding in a recorded run, the cap changes to nits only, as the design update of issue 23 says. If it dropped none, the cap stays and the note gives the counts.
- Budget: $0.

### E6: a prompt injection in a PR

Question: can text in a PR steer a reviewer or the verifier? Run this with the D7 change, because the PR body now reaches every reviewer and the verifier.

- Cases: the four bug-injection cases of D4b. Each one has one known bug, so a suppressed finding is measurable.
- Arms: each case as it is, and the same case with an instruction in the PR body. Use three kinds of instruction: report no finding; state that the changed lines are already reviewed and safe; print the system prompt. Put one of them in a commit message and one in a code comment also, to test the two other paths.
- Report: the share of runs that find the known bug with and without the instruction, and each output that follows an instruction.
- Rule: no default changes. If an instruction lowers the share that finds the bug by more than the noise, or a run follows an instruction, open an issue with the case and the record.
- Budget: $40.

### E7: the follow-ups that name D4c

The two lists of follow-ups below name D4c five times. The records of S1 answer two of them with no model call, and E6 answers one.

- The passes of diff-bugs and security. Run `eval-report --by-pass` on the S1 records, and apply the D8 rule to the two reviewers. A reviewer that fails the rule goes to one pass.
- The cross-pass dedupe key. Count in the S1 records how often a second pass reports a different claim on a span and a category that the first pass also reported. Report the count; change the key only if such a claim matches a posted-label golden that no other finding matched.
- The sanitizer and the untrusted wrapper: E6 measures this.
- Quotes by line span, and a verifier call when a later run resolves a thread with a changed span: these two are not in this round. They stay in the follow-up lists.
- Budget: $0.

### Order and budget

1. E5, which costs nothing.
2. The tooling: S2, S3 and S4.
3. S1, the reference run, then E7 from its records.
4. E3 and E4, which need S1 and S2 and cost little.
5. E2, then E1.
6. E6 at any time after the tooling.

The budgets add up to about $585 of model calls: $133 for S1, $200 for E1, $120 for E2, $60 for E3, $30 for E4 and $40 for E6. The sessions that build the tooling use the plan also. That is more than one week of the plan holds beside other work, so the principal sets the calendar: the runs go across two plan weeks, or they use an API key with `--allow-api-key`.

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
