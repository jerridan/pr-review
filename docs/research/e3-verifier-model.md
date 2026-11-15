# E3: the model and the effort of the first verifier

Status: done 2026-11-15. Part of D4c in TICKETS.md. The data is the 239 stored candidates of S1, the reference run of D4c.

## Result

- Sonnet 5.5 at medium effort becomes the first verifier. It passes the rule for a cheaper arm. Its posted recall is 0.032 lower and its posted precision is 0.011 higher than the current verifier, Sonnet 5.5 at high effort, and it costs 0.62 times as much for each verification.
- Opus 5.5 at low effort fails both rules. It costs 1.09 times as much, its precision is 0.023 lower, and its recall is 0.032 lower. So Opus 5.5 at medium effort did not run.
- Terra at medium effort, through the Codex CLI, fails both rules on its sample. Its recall is 0.152 lower on the same sample.
- The escalation stays as it is. The pipeline with its escalation has a posted recall of 0.536, against 0.496 for the first verifier alone. No arm of the first verifier alone reaches it. Whether the escalation is worth its cost is a design question for the principal. This note gives the figures and does not decide it.

## Method

`pr-review replay` verified the same 239 stored candidates of S1 again with each arm. A replay asks the first verifier only: it makes no escalation call, no merge call and no cap. So its posted figures compare only with other replays. `--arm stored` gives the first results that S1 stored, with no verifier call. It is the current verifier, Sonnet 5.5 at high effort. All arms are paired by candidate and by case.

- The tool was a frozen build of 03a87ee (0.17.0) for every arm.
- All arms used one shared `--judge-cache`, seeded from the stored replay of E7. The judge matched each candidate to the goldens once.
- The Opus 5.5 low arm ran with `--verifier-cap 1`. No call of any arm reached its cap.
- The Terra arm is the work of another session. It ran on a sample of 158 candidates (`--sample golden-plus-equal`, seed 20261114) with its own stored arm on the same sample.

The reference row is the pipeline as it ships. It takes the final decision of each S1 verification, after the escalation, and scores the passed findings by the same rule as a replay: no merge and no cap. It made no model call. The judge cache held every question that it needed.

The rules of E3:

- A cheaper arm becomes the verifier when its posted recall and its posted precision are each not more than 0.05 below those of the current verifier, and its cost for each verification is lower.
- A dearer arm becomes the verifier when its posted precision is not lower than that of the current verifier, its posted recall is higher with a 90% bootstrap interval of the difference above zero, and its cost for each verification is at most two times the current cost.

The bootstrap draws the 28 cases with replacement, 10000 times, with the seed 20261114, and computes the paired recall difference from the sums of each resample.

### The rules on made-up figures

Before the figures of the arms existed, a script ran the two rules on made-up figures. The current arm had 28 cases, each with 4 goldens, 4 posted findings of which 2 were real, and a cost of $1 for 6 to 8 verifications. Each row changes the arm only:

| Made-up arm | Cheaper rule | Dearer rule |
|---|---|---|
| The same figures, half the cost | passes | fails |
| Recall 0.107 lower, half the cost | fails | fails |
| The same figures, the same cost | fails | fails |
| Recall higher in every case, 1.5 times the cost | fails | passes |
| Recall higher in every case, 3 times the cost | fails | fails |
| Recall higher in one case only, 1.5 times the cost | fails | fails (the interval reaches 0) |
| Recall higher, precision lower, 1.5 times the cost | fails | fails |

So each rule can give each result.

## Figures

All 239 candidates, 28 cases:

| Arm | Posted recall | Posted precision | Cost for each verification | Real candidates held | Other candidates rejected | Label agreement | Post agreement | Blocking goldens not posted | In the band | Unsure | Capped |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Pipeline with escalation (S1 final decisions) | 0.536 | 0.372 | $0.367 | - | - | - | - | - | - | 0 | 0 |
| Sonnet 5.5 high, first result (current) | 0.496 | 0.392 | $0.167 | 73 of 75 (0.973) | 15 of 164 (0.091) | 0.338 | 0.857 | 4 | 135 | 0 | 0 |
| Sonnet 5.5 medium | 0.464 | 0.403 | $0.103 | 75 of 75 (1.000) | 13 of 164 (0.079) | 0.392 | 0.835 | 3 | 145 | 0 | 0 |
| Opus 5.5 low, cap $1 | 0.464 | 0.369 | $0.182 | 74 of 75 (0.987) | 12 of 164 (0.073) | 0.449 | 0.821 | 3 | 97 | 0 | 0 |

"Real candidates held" is the share of the candidates that match a golden with a posting or `dont_post` label which the verifier says hold. "Other candidates rejected" is the share of the candidates that match a `not_real` golden or no golden which it rejects. The label agreement and the post agreement count the candidates that it says hold and that match a golden.

The rules:

| Arm | Recall difference (90% interval) | Precision difference | Cost ratio | Cheaper rule | Dearer rule |
|---|---|---|---|---|---|
| Sonnet 5.5 medium | -0.032 (-0.064 to 0.000) | +0.011 | 0.62 | passes | fails |
| Opus 5.5 low | -0.032 (-0.089 to +0.024) | -0.023 | 1.09 | fails | fails |

Terra at medium effort, on the sample of 158 candidates, against the stored arm on the same sample:

| Arm | Posted recall | Posted precision | Real candidates held | Other candidates rejected | Label agreement | In the band | Unsure |
|---|---|---|---|---|---|---|---|
| Sonnet 5.5 high, first result (sample) | 0.488 | 0.555 | 0.973 | 0.060 | 0.338 | 83 | 0 |
| Terra medium (sample) | 0.336 | 0.494 | 0.707 | 0.193 | 0.456 | 23 | 26 |

Terra rejects more of the false candidates, but it also holds fewer of the real ones, and 26 results end unsure. Its recall is 0.152 lower, so it fails the cheaper rule. Its precision is lower, so it fails the dearer rule. A Codex call reports tokens and no dollar cost: the arm used 1.55 million tokens of the Codex quota.

### The escalation in S1

From the S1 records, with no model call:

- The verifier escalated 135 of 239 verifications (56%).
- The escalation changed the decision of 28 of the 135 (21%).
- The escalations cost $47.81, and the first verifier calls cost $39.99.
- The escalation adds 0.040 posted recall and costs 0.020 posted precision. It makes the verifier stage 2.2 times as dear as the first call alone.

The cost of one call in S1: the first verifier had a median of $0.101 and a maximum of $0.424. The escalation had a median of $0.206 and a maximum of $0.999. See `e7-passes-dedupe.md`.

## Spend

The paid runs of this note cost $69.05: Sonnet 5.5 medium $24.84, Opus 5.5 low $43.66, and the judge $0.55. The Terra arm used the Codex quota and is the spend of another session. The reference row and the stored arm made no model call.

## Limits

- One run of each arm on one repeat of S1. Each arm sees each candidate once, so the noise of one verifier call is in the figures. The interval of the recall difference covers this only at the level of the cases.
- A replay has no escalation, no merge and no cap, so its posted figures are not the figures that a review posts. The rule compares first verifiers only.
- With Sonnet 5.5 medium, 145 results fall in the band, against 135. So the pipeline escalates about 10 more findings for each 239. At the median cost of an escalation, that adds about $2 to $4. The cheaper first calls save about $15. Opus 5.5 low puts only 97 results in the band, which would save about $13 of escalations, but the rule does not count the escalation cost, and Opus 5.5 low fails it.
- The verifier rejects only 8 to 9% of the candidates that match no real golden, in every Claude arm. The merge and the cap remove most false findings after it. E3b and E4 look at the severity and the score.
- The goldens and their labels come from the labeler and the pool. A golden can be wrong.
- The Terra figures come from a sample, so their figures and those of the Claude arms do not have the same candidates.
