# E3b: where the severity label comes from

Status: done 2026-11-15. Part of D4c in TICKETS.md. The data is the stored candidates of S1, the reference run of D4c, and the verifier results of E3.

## Result

- The severity stays in the verifier. No split arm passes the rule.
- The best arm gives the severity to a separate step on Opus 5.5 at medium effort, with one call for each finding. It agrees with the golden on post against no post in 0.899 of the findings, against 0.835 for the single call, and it misses 1 blocking golden against 3. But the lower end of the 90% interval of the difference is exactly 0.000, and the rule needs it above zero. So the rule does not pass, by the narrowest margin. A larger case set can decide it.
- Every Opus step raises the exact label agreement from 0.392 to between 0.54 and 0.65. Read this figure with the labeler limit below.
- The posted recall and precision barely move in any arm, because the post decision of most findings is the same in all arms.

## Method

The single call is the current verifier, after E3: Sonnet 5.5 at medium effort gives truth and severity in one call. The split arms give the truth to the same verifier and the severity to a separate step. The step has no tools. It gets the text of `docs/design/severity-policy.md`, the finding, the quotes of the verifier and the description block.

- Mode `finding`: one call for each finding that holds.
- Mode `pr`: one call for each case, which sees all the findings of the case that hold, so that it can weigh them against each other.
- The step runs at Sonnet 5.5 high, Opus 5.5 medium and Opus 5.5 high. Six arms.

The truth check. The E3b section asks to check first that the verifier prompt with no severity gives the same truth answers. `pr-review replay --prompt truth` verified 30 candidates, drawn with the seed 20261114, with Sonnet 5.5 medium. All 30 agreed with the E3 results of the same model with the score prompt: the same "holds" answer (in scope, and the claim holds). 28 or more had to agree. So the split arms reuse the E3 truth results of Sonnet 5.5 medium and cost only the severity calls: `replay --resume --severity <mode>:<model>:<effort>` on a copy of the E3 arm.

The frozen build of 03a87ee (0.17.0) ran every arm, with the shared judge cache of E3.

The rule: the severity moves to its own step when a split arm has a higher agreement on post against no post than the single call, with a 90% bootstrap interval of the difference above zero, and the cost for each finding of the two steps is at most two times the cost of the single call. The bootstrap draws the 28 cases with replacement, 10000 times, with the seed 20261114.

### The rule on made-up figures

Before the figures existed, a script ran the rule on made-up figures: 28 cases, each with 4 findings that hold and match a golden, 3 of them with the right post decision, and a cost of $1 for 8 findings.

| Made-up split arm | Result |
|---|---|
| Post agreement up in every case, 1.5 times the cost | moves |
| Post agreement up in every case, 2.5 times the cost | stays (cost) |
| Post agreement up in one case only, 1.5 times the cost | stays (the interval reaches 0) |
| The same post agreement, 1.2 times the cost | stays |
| Post agreement down, 1.2 times the cost | stays |

So the rule can give each result.

## Figures

79 candidates hold, match a golden, and have a label in every arm. All arms are paired by candidate and by case.

| Arm | Label agreement | Post agreement | Blocking goldens not posted | Posted recall | Posted precision | Cost for each finding, both steps | Post agreement difference (90% interval) | Cost ratio | Rule |
|---|---|---|---|---|---|---|---|---|---|
| Single call (Sonnet 5.5 medium) | 0.392 | 0.835 | 3 | 0.464 | 0.403 | $0.103 | - | - | - |
| finding, Sonnet 5.5 high | 0.544 | 0.823 | 3 | 0.440 | 0.396 | $0.143 | -0.013 (-0.094 to +0.063) | 1.39 | stays |
| finding, Opus 5.5 medium | 0.646 | 0.899 | 1 | 0.456 | 0.390 | $0.181 | +0.063 (0.000 to +0.111) | 1.76 | stays |
| finding, Opus 5.5 high | 0.633 | 0.873 | 2 | 0.456 | 0.390 | $0.166 | +0.038 (-0.034 to +0.097) | 1.61 | stays |
| pr, Sonnet 5.5 high | 0.443 | 0.810 | 4 | 0.416 | 0.426 | $0.111 | -0.025 (-0.111 to +0.056) | 1.08 | stays |
| pr, Opus 5.5 medium | 0.557 | 0.848 | 3 | 0.464 | 0.406 | $0.116 | +0.013 (-0.044 to +0.070) | 1.13 | stays |
| pr, Opus 5.5 high | 0.544 | 0.848 | 2 | 0.456 | 0.404 | $0.121 | +0.013 (-0.053 to +0.075) | 1.18 | stays |

The label agreement counts the exact label. The post agreement counts the one question that decides a post: a posting label (blocking, suggestion, nit) against a label that does not post. The cost for each finding is the cost of the verifier and of the severity step together, over the verified candidates.

## What a severity call costs

A severity call has no tools, but a call for one finding costs from $0.03 (Sonnet 5.5 high) to about $0.08 (Opus 5.5 medium). The call holds the full severity policy (12.5 KB, about 3100 tokens), the finding, the quotes and the description, all in the user message. The policy comes after the finding, so prompt caching holds only the short system prompt and not the policy: each call pays for the policy again. At high effort the thinking output is the larger part of the cost. A `pr` call holds the policy one time for all the findings of a case, so it costs about half as much for each finding.

A possible later saving: put the policy before the finding, in the system prompt or at the start of the user message, so that the cache holds it for every call of a run.

## Time

From the stored durations, with no model call. The severity step runs after the verifier of the same finding, so it adds its time to that finding.

| Severity step | Calls | Median | 90th percentile | Maximum |
|---|---|---|---|---|
| finding, Sonnet 5.5 high | 226 | 6.6 s | 13.4 s | 53.7 s |
| finding, Opus 5.5 medium | 226 | 4.7 s | 6.8 s | 10.1 s |
| finding, Opus 5.5 high | 226 | 5.5 s | 8.4 s | 12.1 s |
| pr, Sonnet 5.5 high (one call for each case) | 23 | 17.9 s | 34.8 s | 60.0 s |
| pr, Opus 5.5 medium | 23 | 15.3 s | 25.7 s | 30.4 s |
| pr, Opus 5.5 high | 23 | 19.8 s | 33.9 s | 44.7 s |

A `finding` step adds 5 to 7 s to each finding at the median. A `pr` step waits for every verification of the case, then adds 15 to 20 s to the review at the median. The verifier alone (Sonnet 5.5 medium) takes 8.0 s for each finding at the median.

## Spend

The paid runs of this note cost $55.36: the truth check $2.58, the probes $7.02, the three `pr` arms $7.65, and the three `finding` arms $38.11.

## Limits

- The labels of the goldens came from the labeler, which is Opus 5.5 with a Sol judge. A severity step on Opus can agree with those labels for that reason. The rise of the exact label agreement on Opus is therefore not clean evidence that Opus labels better. The post agreement is less exposed, because it asks only whether a label posts.
- 79 findings in 28 cases. The best arm misses the rule at the lower end of its interval, so a larger case set can change the result.
- One run of each arm. The noise of one severity call is in the figures.
- A replay has no escalation, no merge and no cap. The rule compares the post decision of each finding, not the posted review.
- The policy text in each call is not cached (see above), so the cost of a `finding` arm is higher than it needs to be.
