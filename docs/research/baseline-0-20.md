# The baseline of 0.20.0

Status: done 2026-11-22. The last step of D4c in TICKETS.md.

## Result

- `eval/baseline.json` now measures the defaults of 0.20.0: posted recall 0.619 and posted precision 0.517, at two repeats of the 28 pinned cases, for $4.34 for each case and $0.14 of judge calls. The margins stay 0.05 and 0.05 by the rule of the README.
- Against the old baseline file (0.10.0), recall is 0.077 higher and precision is 0.081 lower. The precision gap is mostly older than D4c. S1 ran the old defaults on the same 28 cases at 0.15.0 and gave a precision of 0.534. Against S1, the new defaults gain 0.049 recall and lose 0.017 precision.
- A review takes 1.1 min at the median, against 1.7 min in S1.

## Method

One run of `pr-review eval --cases eval/cases --repeat 2 --baseline eval/baseline.json --write-baseline --resume`, on a frozen build of d342898 (0.20.0), in five steps of a plan window with `--max-cost`. No repeat failed. The defaults of 0.20.0 are the result of D4c:

- one pass for every reviewer (E7);
- the posting cap on nits only;
- the first verifier on Sonnet 5.5 at medium effort, with the verifier caps of $1 and $2 (E3);
- tests on Sonnet 5.5 at medium effort (the E1 rule);
- diff-bugs on Opus 5.5 at medium effort and history on Sonnet 5.5 at medium effort, by the user's decisions against the E1 rule;
- no description-drift reviewer, by the user's decision.

The figures of the walle and websites cases, the review time, the findings by severity and the escalations come from the records of the run, with no model call. The sources of the false posted findings come from the judge cache of each repeat, scored with no judge client.

## Figures

| | New baseline (0.20.0, 2 repeats) | S1 (0.15.0, 1 repeat) | Old baseline (0.10.0, 2 repeats) |
|---|---|---|---|
| Posted recall | 0.619 (0.606 and 0.631) | 0.570 | 0.542 |
| Posted precision | 0.517 (0.507 and 0.527) | 0.534 | 0.598 |
| Adjudicated precision | 0.663 | 0.610 | 0.674 |
| Raw recall | 0.706 | 0.639 | 0.640 |
| Cost for each case | $4.34 and $0.14 of judge | $5.56 and $0.12 | $4.66 and $0.09 |

The spread of the two repeats is 0.013 for recall and 0.010 for precision. Two times the spread rounds up to 0.05 for each, so the margins stay 0.05 and 0.05.

The walle and websites cases (8 cases; 5 of them have a posted-label golden). These figures are means over the cases, not the pooled figures of the eval:

| | New baseline (2 repeats) | S1 (1 repeat) |
|---|---|---|
| Posted recall | 0.850 | 1.000 |
| Posted precision | 0.412 | 0.507 |
| Cost for each case | $2.88 | $4.77 |
| Posted findings in each repeat, false posted | 13, 8.5 | 14, 8 |
| Review time, median | 0.8 min | 1.3 min |

The time of a review is the sum of `cost.stage_ms` (config, gather, triage, the reviewers with the verifier, and merge):

| | Median | 90th percentile | Maximum |
|---|---|---|---|
| New baseline | 1.1 min | 1.8 min | 2.3 min |
| S1 | 1.7 min | 2.9 min | 3.9 min |

Posted findings, for each repeat:

| | Posted | Blocking | Suggestion | Nit | False posted |
|---|---|---|---|---|---|
| New baseline | 137.5 | 21.5 | 75.5 | 40.5 | 66.5 |
| S1 | 118 | 13 | 67 | 38 | 55 |

The cap removed no finding in either run.

The escalation: 279 of 453 verifications escalated (62%), for $51 in each repeat. In S1, 135 of 239 escalated (56%), for $48.

## The sources of the precision cost

A posted finding has the reviewer passes that raised it. Posted findings and false posted findings for each repeat, by source:

| Source | New: posted, false | S1: posted, false |
|---|---|---|
| diff-bugs alone | 20.5, 9.5 | 11, 5 |
| history alone | 4.5, 3.5 | 0, 0 |
| tests alone | 28.5, 19 | 32, 20 |
| docs-and-comments alone | 9.5, 6 | 11, 6 |
| conventions alone | 4, 3 | 5, 3 |
| security alone | 1, 0.5 | 2, 2 |
| description-drift alone | removed | 9, 6 |
| two or more reviewers | 69.5, 25 | 48, 13 |

diff-bugs on Opus 5.5 medium gives the largest part of the precision cost: it posts 9.5 more findings alone, and it is among the sources of most findings with two or more reviewers, whose false findings rose from 13 to 25. history on Sonnet 5.5 medium gives the next part: 4.5 findings alone, of which 3.5 are false. Both are decisions of the user against the E1 rule, which the E1 note states. The removal of description-drift took 9 posted and 6 false findings out, which helps precision.

## What the stage experiments did not predict

1. E1 predicted a precision of 0.695 against 0.750, with the first verifier only and no merge. The full pipeline lost only 0.017 against S1: the merge and the escalation remove much of the added noise.
2. E1 predicted 23 more posted-label goldens (27% more) before the merge. The full pipeline gained 0.049 recall. Many added goldens are also found by another reviewer, and the merge joins them.
3. Blocking findings rose from 13 to 21.5 in each repeat (65%). No stage experiment measured the severity mix of the posted findings.
4. The review is faster than the stage figures suggested: 1.1 min against 1.7 min at the median, from one pass, one reviewer less, and the faster verifier.
5. The cost of $4.34 for each case is near the estimate of $4.40 from S1 and E1.

## Spend

The run cost $250.80 on the plan login, the judge included, in five windows.

## Limits

- One run at two repeats. The spread of the two repeats is small, but the noise between two runs can be larger. S1 (0.15.0) and the old baseline (0.10.0) differ by 0.064 in precision. That gap holds the changes between the two versions and the noise between runs, and this note does not separate them.
- The walle and websites cases hold few goldens (5 cases with a posted-label golden), so their figures are not stable.
- The judge is Sonnet 5.5, the model of tests and history, so it scores findings of its own model.
