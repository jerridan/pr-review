# E2: one reviewer over the whole diff against the specialist set

Result: up to about 700 changed lines, the data permits a comparison. Above 1,000 lines it does not: the set holds only two such cases. In this report, a PR is large only at 1,000 lines or more. No line between one reviewer and the specialists is found: for each of the three single arms, the 90% bootstrap interval of the line covers the full range of the cases, 12 to 3164 changed lines. Under 100 lines, Opus 5.5 at medium posts as many goldens as the specialists (recall 0.444 each) with a higher precision (0.800 against 0.500). From 100 to 300 lines, the specialists lead (0.700 against at most 0.575). From 300 to 1,000 lines, Opus 5.5 at high leads (0.476 against 0.381), on five cases. The reviewer stage of a single Opus arm costs about a third of that of the specialists, and it takes about three times as long, because the specialists run Opus at low effort.

## Question

When does one reviewer do as well as the seven specialists? The theory: one reviewer does well on a small PR, the specialists do better on a large one, and a line exists between the two. This experiment changes no default. Its result is evidence for a tier rule by size, which is a design decision of the principal.

## Arms

| Arm | Reviewer stage | Tool |
|---|---|---|
| specialists | the seven built-in reviewers of S1, at the defaults of S1 (diff-bugs and security with two passes) | S1 records, build f8f5b38 |
| opus-medium | `general-review` alone, Opus 5.5 at medium | build 03a87ee |
| opus-high | `general-review` alone, Opus 5.5 at high | build 03a87ee |
| terra-high | the same prompt through the Codex CLI, `gpt-6.1-terra` at high | build cec32f7 |

The three single arms use one prompt, `prompts/reviewers/general-review.md`, a general review of the whole diff. The Opus arms ran with `pr-review eval --reviewers general-review --models general-review=opus:<effort> --stage1`, which gives the candidates with no verifier. The Terra arm ran with `pr-review eval-codex-review`, which writes outside candidates. The Terra arm gets no triage brief, and the Opus arms get one.

## Method

- Cases: the 28 pinned cases (cases repo at 373266b), one repeat each.
- One verifier for every arm, so the arms are paired: `pr-review replay` with `--verifier claude:sonnet:high`, the first verifier only. A replay has no escalation, no merge and no cap. For the specialists, the base is `replay --arm stored` of all 239 S1 candidates, which reads the stored first results of the same verifier and makes no verifier call.
- Before the verifier: the candidates of the arm that match a posted-label golden. After the verifier: the findings that the first verifier posts and that match a posted-label golden. Recall counts the 125 posted-label goldens of the 28 cases. Precision is matches over posted findings.
- Size groups: the groups of S3 (`sizes.json`), by changed lines: 10 small, 9 medium, 9 large.
- The difference for each case: the recall after the verifier of the specialists minus that of the single arm. Cases with no posted-label golden are left out of the fit.
- The fit: the difference against the changed lines, `d = a + b * log10(lines)`, by least squares. The line is the size where the fit crosses zero. A 90% bootstrap interval comes from 2000 resamples of the cases with the seed 20261114. A resample whose fit does not cross zero inside the range of the cases counts at the edge that it passes.
- The decision rule (TICKETS.md, E2): "If the interval covers the full range of the cases, state that the line is not found, and state how many more large cases the measurement needs."

## Test of the rule on made-up figures

The fit script ran on two made-up sets of 28 cases with the sizes of the real cases, before the real figures existed.

- Set A: the specialists gain 0.4 of recall for each tenfold of size, the gain is zero at 100 lines, and the noise is small. The fit gives the line at 95 lines, with the interval 82 to 110 lines. The interval does not cover the range of 12 to 3164 lines, so the line is found.
- Set B: no trend, only noise around +0.05. The interval is 12 to 3164 lines, the full range, so the line is not found. The estimate of the cases needed: 7 more large cases would make the interval narrower than 90% of the range, if a trend exists. With no trend, more cases do not give a line.

So the rule can give each of its two results.

## Figures

The figures come from `e2analysis.py` and `e2fit.py` in the crew record folder of this run. They read the replay reports and make no model call. "Review cost" is the cost of the reviewer stage of the arm. For the specialists it is the cost of the whole S1 run of the case (triage, seven reviewers, verifier, escalation and merge), because the S1 record does not split it. "Verifier cost" is the cost of the first verifier in the replay.

### By size group

| group | arm | cases | goldens | candidates | recall before | posted | recall after | precision after | review cost | verifier cost |
|---|---|---|---|---|---|---|---|---|---|---|
| small | specialists | 10 | 28 | 51 | 0.571 | 30 | 0.464 | 0.433 | 31.99 | 8.39 |
| small | opus-medium | 10 | 28 | 30 | 0.643 | 16 | 0.464 | 0.812 | 4.99 | 4.11 |
| small | opus-high | 10 | 28 | 39 | 0.679 | 17 | 0.429 | 0.706 | 6.65 | 5.06 |
| small | terra-high | 10 | 28 | 22 | 0.464 | 14 | 0.429 | 0.857 | 0.0 | 3.16 |
| medium | specialists | 9 | 37 | 84 | 0.784 | 58 | 0.703 | 0.448 | 53.83 | 15.1 |
| medium | opus-medium | 9 | 37 | 41 | 0.568 | 32 | 0.486 | 0.562 | 6.08 | 6.79 |
| medium | opus-high | 9 | 37 | 47 | 0.541 | 39 | 0.541 | 0.513 | 6.96 | 5.72 |
| medium | terra-high | 9 | 37 | 39 | 0.432 | 24 | 0.378 | 0.583 | 0.0 | 7.06 |
| large | specialists | 9 | 60 | 104 | 0.4 | 70 | 0.383 | 0.329 | 69.93 | 16.5 |
| large | opus-medium | 9 | 60 | 50 | 0.333 | 38 | 0.267 | 0.421 | 8.42 | 6.14 |
| large | opus-high | 9 | 60 | 56 | 0.433 | 45 | 0.417 | 0.556 | 10.56 | 6.9 |
| large | terra-high | 9 | 60 | 43 | 0.367 | 31 | 0.3 | 0.581 | 0.0 | 6.55 |
| total | specialists | 28 | 125 | 239 | 0.552 | 158 | 0.496 | 0.392 | 155.76 | 39.99 |
| total | opus-medium | 28 | 125 | 121 | 0.472 | 86 | 0.376 | 0.547 | 19.49 | 17.04 |
| total | opus-high | 28 | 125 | 142 | 0.52 | 101 | 0.456 | 0.564 | 24.17 | 17.69 |
| total | terra-high | 28 | 125 | 104 | 0.408 | 69 | 0.352 | 0.638 | 0.0 | 16.77 |

### By case source

| group | arm | cases | goldens | candidates | recall before | posted | recall after | precision after | review cost | verifier cost |
|---|---|---|---|---|---|---|---|---|---|---|
| injection | specialists | 4 | 4 | 30 | 1.0 | 19 | 1.0 | 0.211 | 28.66 | 6.52 |
| injection | opus-medium | 4 | 4 | 10 | 1.0 | 9 | 1.0 | 0.444 | 3.12 | 2.25 |
| injection | opus-high | 4 | 4 | 13 | 1.0 | 9 | 1.0 | 0.444 | 4.75 | 1.33 |
| injection | terra-high | 4 | 4 | 9 | 1.0 | 7 | 1.0 | 0.571 | 0.0 | 2.15 |
| martian | specialists | 6 | 40 | 112 | 0.825 | 73 | 0.725 | 0.397 | 57.16 | 18.72 |
| martian | opus-medium | 6 | 40 | 54 | 0.65 | 37 | 0.525 | 0.568 | 4.3 | 7.48 |
| martian | opus-high | 6 | 40 | 60 | 0.7 | 48 | 0.65 | 0.542 | 4.56 | 6.83 |
| martian | terra-high | 6 | 40 | 41 | 0.55 | 33 | 0.475 | 0.576 | 0.0 | 5.7 |
| pool | specialists | 10 | 38 | 51 | 0.5 | 40 | 0.474 | 0.45 | 41.11 | 8.61 |
| pool | opus-medium | 10 | 38 | 23 | 0.237 | 18 | 0.211 | 0.444 | 7.36 | 3.71 |
| pool | opus-high | 10 | 38 | 33 | 0.237 | 19 | 0.211 | 0.421 | 9.61 | 4.79 |
| pool | terra-high | 10 | 38 | 30 | 0.263 | 14 | 0.211 | 0.571 | 0.0 | 5.73 |
| reviewbench | specialists | 8 | 43 | 46 | 0.302 | 26 | 0.256 | 0.423 | 28.83 | 6.14 |
| reviewbench | opus-medium | 8 | 43 | 34 | 0.465 | 22 | 0.326 | 0.636 | 4.7 | 3.59 |
| reviewbench | opus-high | 8 | 43 | 36 | 0.558 | 25 | 0.442 | 0.76 | 5.25 | 4.74 |
| reviewbench | terra-high | 8 | 43 | 24 | 0.349 | 15 | 0.302 | 0.867 | 0.0 | 3.2 |
| total | specialists | 28 | 125 | 239 | 0.552 | 158 | 0.496 | 0.392 | 155.76 | 39.99 |
| total | opus-medium | 28 | 125 | 121 | 0.472 | 86 | 0.376 | 0.547 | 19.49 | 17.04 |
| total | opus-high | 28 | 125 | 142 | 0.52 | 101 | 0.456 | 0.564 | 24.17 | 17.69 |
| total | terra-high | 28 | 125 | 104 | 0.408 | 69 | 0.352 | 0.638 | 0.0 | 16.77 |

### Per-case difference (specialists minus arm, recall after the verifier)

| case | changed lines | group | goldens | specialists | opus-medium | opus-high | terra-high |
|---|---|---|---|---|---|---|---|
| reviewbench-axios-10836 | 12 | small | 2 | 1.000 | +0.500 | +0.000 | +1.000 |
| reviewbench-disaster-ninja-fe-1166 | 15 | small | 3 | 0.000 | -0.333 | -0.333 | -0.667 |
| reviewbench-claire-de-binare-1550 | 24 | small | 1 | 0.000 | -1.000 | -1.000 | +0.000 |
| martian-discourse-graphite-1 | 32 | small | 8 | 0.875 | +0.125 | +0.250 | +0.125 |
| reviewbench-ensnode-1938 | 35 | small | 3 | 0.333 | -0.333 | +0.333 | -0.333 |
| reviewbench-statswales-frontend-626 | 51 | small | 3 | 0.000 | -0.333 | -0.333 | +0.000 |
| reviewbench-flatten-js-244 | 70 | small | 6 | 0.167 | +0.167 | +0.000 | +0.000 |
| pool-pr-review-15 | 81 | small | 1 | 1.000 | +1.000 | +1.000 | +1.000 |
| injection-websites-130 | 111 | small | 1 | 1.000 | +0.000 | +0.000 | +0.000 |
| martian-calcom-8330 | 121 | medium | 7 | 0.714 | +0.143 | +0.143 | +0.143 |
| martian-sentry-greptile-1 | 138 | medium | 9 | 0.889 | +0.333 | +0.222 | +0.333 |
| injection-walle-21 | 162 | medium | 1 | 1.000 | +0.000 | +0.000 | +0.000 |
| pool-pr-review-41 | 172 | medium | 2 | 0.500 | +0.000 | +0.500 | +0.500 |
| pool-websites-114 | 175 | medium | 2 | 1.000 | +1.000 | +1.000 | +0.500 |
| martian-sentry-93824 | 249 | medium | 9 | 0.556 | +0.111 | -0.111 | +0.444 |
| pool-pr-review-44 | 280 | medium | 7 | 0.571 | +0.143 | +0.143 | +0.286 |
| martian-sentry-67876 | 297 | large | 2 | 0.500 | +0.500 | -0.500 | -0.500 |
| pool-pr-review-46 | 306 | large | 11 | 0.455 | +0.182 | +0.182 | +0.182 |
| martian-calcom-10600 | 316 | large | 5 | 0.600 | +0.200 | +0.000 | +0.400 |
| reviewbench-spm-19 | 543 | large | 12 | 0.417 | +0.000 | -0.250 | -0.083 |
| reviewbench-node-postgres-3650 | 568 | large | 13 | 0.154 | -0.077 | -0.231 | +0.000 |
| injection-websites-120 | 674 | large | 1 | 1.000 | +0.000 | +0.000 | +0.000 |
| injection-walle-6 | 1205 | large | 1 | 1.000 | +0.000 | +0.000 | +0.000 |
| pool-pr-review-45 | 3164 | large | 15 | 0.333 | +0.267 | +0.200 | +0.200 |

### The fit: difference = a + b * log10(changed lines), line where it crosses zero, 90% bootstrap interval (2000 resamples, seed 20261114)

- opus-medium: {"cases": 24, "slope_per_decade": 0.1486, "line_lines": 28, "interval_lines": [12, 3164], "range_lines": [12, 3164], "found": false, "more_large_cases_needed": 6, "large_group": 8}
- opus-high: {"cases": 24, "slope_per_decade": 0.0764, "line_lines": 33, "interval_lines": [12, 3164], "range_lines": [12, 3164], "found": false, "more_large_cases_needed": 6, "large_group": 8}
- terra-high: {"cases": 24, "slope_per_decade": -0.0139, "line_lines": 3164, "interval_lines": [12, 3164], "range_lines": [12, 3164], "found": false, "more_large_cases_needed": 6, "large_group": 8}

Reading of the figures:

- Over all cases, the specialists have the highest recall after the verifier: 0.496. Opus high has 0.456, Opus medium 0.376 and Terra high 0.352.
- The single arms post fewer false findings. Their precision is 0.547 to 0.638, and that of the specialists is 0.392.
- Small group: Opus medium equals the specialists (0.464). Opus high and Terra have 0.429, with a precision of 0.706 and 0.857 against 0.433.
- Medium group: the specialists lead clearly (0.703). The best single arm, Opus high, has 0.541.
- Large group: Opus high (0.417) is ahead of the specialists (0.383), and Opus medium (0.267) and Terra (0.300) are behind them.
- By source: the single arms trail on `martian` and `pool`, and Opus high leads on `reviewbench` (0.442 against 0.256). Every arm finds the known bug of the four `injection` cases.
- The fit: the slope of Opus medium is +0.149 of recall for each tenfold of size, that of Opus high +0.076, and that of Terra -0.014. The per-case differences are large next to these slopes (from -1.0 to +1.0), so the bootstrap interval covers the full range for every arm.
- Cases needed: the heuristic of the fit script estimates 6 more large cases for each arm. It holds only if the trend is real. With slopes this small against this spread, more large cases alone may not give a line. More repeats of each case would cut the noise of each difference.

### Fixed size limits

The groups of S3 hold equal counts of cases. This table uses fixed limits instead. Only two cases have 1,000 changed lines or more, so the last row permits no conclusion.

| group | cases | goldens | arm | recall before | recall after | precision after |
|---|---|---|---|---|---|---|
| under 100 | 9 | 27 | specialists | 0.556 | 0.444 | 0.500 |
| under 100 | 9 | 27 | opus-medium | 0.630 | 0.444 | 0.800 |
| under 100 | 9 | 27 | opus-high | 0.667 | 0.407 | 0.688 |
| under 100 | 9 | 27 | terra-high | 0.444 | 0.407 | 0.846 |
| 100 to 300 | 12 | 40 | specialists | 0.775 | 0.700 | 0.378 |
| 100 to 300 | 12 | 40 | opus-medium | 0.575 | 0.475 | 0.528 |
| 100 to 300 | 12 | 40 | opus-high | 0.575 | 0.575 | 0.489 |
| 100 to 300 | 12 | 40 | terra-high | 0.475 | 0.425 | 0.586 |
| 300 to 1,000 | 5 | 42 | specialists | 0.381 | 0.381 | 0.348 |
| 300 to 1,000 | 5 | 42 | opus-medium | 0.405 | 0.333 | 0.483 |
| 300 to 1,000 | 5 | 42 | opus-high | 0.500 | 0.476 | 0.714 |
| 300 to 1,000 | 5 | 42 | terra-high | 0.381 | 0.310 | 0.591 |
| 1,000 or more | 2 | 16 | specialists | 0.438 | 0.375 | 0.429 |
| 1,000 or more | 2 | 16 | opus-medium | 0.125 | 0.125 | 0.333 |
| 1,000 or more | 2 | 16 | opus-high | 0.188 | 0.188 | 0.300 |
| 1,000 or more | 2 | 16 | terra-high | 0.250 | 0.188 | 0.600 |
| total | 28 | 125 | specialists | 0.552 | 0.496 | 0.392 |
| total | 28 | 125 | opus-medium | 0.472 | 0.376 | 0.547 |
| total | 28 | 125 | opus-high | 0.520 | 0.456 | 0.564 |
| total | 28 | 125 | terra-high | 0.408 | 0.352 | 0.638 |


### The walle and websites cases

These cases come from the repos that the next cases come from. Only six of their goldens are posted-label goldens, so the table shows a direction at most.

| group | cases | goldens | arm | recall before | recall after | precision after |
|---|---|---|---|---|---|---|
| injection-walle | 2 | 2 | specialists | 1.000 | 1.000 | 0.182 |
| injection-walle | 2 | 2 | opus-medium | 1.000 | 1.000 | 0.333 |
| injection-walle | 2 | 2 | opus-high | 1.000 | 1.000 | 0.286 |
| injection-walle | 2 | 2 | terra-high | 1.000 | 1.000 | 0.400 |
| injection-websites | 2 | 2 | specialists | 1.000 | 1.000 | 0.250 |
| injection-websites | 2 | 2 | opus-medium | 1.000 | 1.000 | 0.667 |
| injection-websites | 2 | 2 | opus-high | 1.000 | 1.000 | 1.000 |
| injection-websites | 2 | 2 | terra-high | 1.000 | 1.000 | 1.000 |
| pool-walle | 2 | 0 | specialists | - | - | - |
| pool-walle | 2 | 0 | opus-medium | - | - | 0.000 |
| pool-walle | 2 | 0 | opus-high | - | - | - |
| pool-walle | 2 | 0 | terra-high | - | - | - |
| pool-websites | 2 | 2 | specialists | 1.000 | 1.000 | 1.000 |
| pool-websites | 2 | 2 | opus-medium | 0.000 | 0.000 | 0.000 |
| pool-websites | 2 | 2 | opus-high | 0.000 | 0.000 | - |
| pool-websites | 2 | 2 | terra-high | 0.500 | 0.500 | 1.000 |
| total | 8 | 6 | specialists | 1.000 | 1.000 | 0.286 |
| total | 8 | 6 | opus-medium | 0.667 | 0.667 | 0.364 |
| total | 8 | 6 | opus-high | 0.667 | 0.667 | 0.444 |
| total | 8 | 6 | terra-high | 0.833 | 0.833 | 0.625 |


## Costs

| Arm | Reviewer stage | Verifier step (replay) |
|---|---|---|
| specialists | $155.76 (the whole S1 run) | $39.99 (stored, no new call) |
| opus-medium | $19.49 | $17.04 |
| opus-high | $24.17 | $17.69 |
| terra-high | 1.19M Codex tokens, 29% of one 5-hour Codex window, no dollar cost | $16.77 |

The reviewer stage alone, from the queries of the records (role `reviewer`), compares the arms at the same stage. The whole-pipeline cost of S1 stays apart.

Reviewer-stage cost: the sum of the reviewer queries of the record. The time of a case: the longest reviewer query, because the reviewers run at the same time. Terra: the time of each case of the sequential Codex run; the two probe cases have no time of their own.

| arm | cases | reviewer-stage cost | whole-pipeline cost | median time (s) | maximum time (s) |
|---|---|---|---|---|---|
| specialists | 28 | $64.06 | $155.76 | 14 | 37 |
| opus-medium | 28 | $17.83 | - | 37 | 85 |
| opus-high | 28 | $22.29 | - | 53 | 138 |
| terra-high | 26 (of 28) | Codex tokens only | - | 34 | 59 |


### Time of the reviewer stage by fixed size limits (median / maximum, seconds)

| group | specialists | opus-medium | opus-high | terra-high |
|---|---|---|---|---|
| under 100 | 13 / 22 | 25 / 60 | 37 / 83 | 26 / 43 |
| 100 to 300 | 13 / 23 | 38 / 85 | 54 / 97 | 36 / 59 |
| 300 to 1,000 | 15 / 28 | 45 / 60 | 95 / 138 | 46 / 56 |
| 1,000 or more | 29 / 37 | 38 / 51 | 70 / 91 | 18 / 18 |

The specialists run Opus 5.5 at low effort, and the single Opus arms at medium and at high. That is why one specialist query is faster than one single-arm query. The time of the specialist stage is the longest reviewer query of the case. The run starts at most five queries at once, and S1 had nine reviewer passes. So for a case with more passes than that, the stage takes longer than this figure, and the figure is a lower bound.

Spend of this experiment on the plan: $43.66 for the two Opus stage 1 runs and $52.29 for the verifier steps of the three single arms with their judge calls ($17.36 Opus medium, $17.83 Opus high, $17.10 Terra), $95.95 in all. The probes are inside these figures. The Terra review used the Codex quota only. The specialist base used no new call.

## Follow-ups

- Run more repeats of the small cases (under 100 changed lines) of the specialists and of Opus 5.5 at medium, to confirm that one reviewer posts as many goldens there.
- Before a tier rule by size, add cases from the walle and websites repos with PRs of 1,000 changed lines or more. The set holds two such cases now.

## Limits

- One repeat of each arm. The per-case difference holds the noise of one run of each arm, and the bootstrap interval holds only the spread between cases.
- The arms ran on three builds: the specialists on f8f5b38 (S1), the Opus arms on 03a87ee, and the Terra arm on cec32f7. The text of the specialist prompts is the same in f8f5b38 and 03a87ee, but S1 ran diff-bugs and security with two passes, and the default is now one pass (E7). So the specialist arm is the set of S1, with two passes of those two reviewers. The general-review prompt is the same in cec32f7 and 03a87ee.
- The verifier of every arm is Sonnet 5.5 at high, the first verifier only. Since 0.18.0, the default first verifier is Sonnet 5.5 at medium (E3). The figures after the verifier are replay figures. They compare with each other, not with posted figures of a full run, which pass escalation, merge and the cap.
- The Terra arm gets no triage brief. The Opus arms and the specialists get one.
- The goldens of the ten `pool` cases came from strong models at high effort. A single arm that finds what those models found scores well on them. The table by case source shows whether one source moves the result.
- The Codex quota and the plan are separate. The Terra arm has a token count and no dollar cost.
