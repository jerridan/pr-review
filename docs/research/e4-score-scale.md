# E4: the score scale of the verifier

Status: done 2026-11-16. Part of D4c in TICKETS.md. The data is the 239 stored candidates of S1, the reference run of D4c.

## Result

- The score from 0 to 100 stays. The five named bands fail the rule. Their posted recall is 0.208 lower (the rule permits 0.05), and more results fall in the escalation band (154 against 145; the rule needs fewer).
- With a map chosen after the figures (`likely` and `certain` post, with no band), the bands would pass the rule. That is a hypothesis for a later run, not a result (see "The map and the scale").
- The cause of the failure is the map from a band to a score, which this experiment chose before the figures: contradicted 5, unlikely 25, possible 50, likely 75, certain 95. Most results are `likely`, which maps to 75. That score is below the threshold of 80 and in the escalation band of 60 to 85. A replay does not escalate, so those findings do not post, and the recall falls. In the pipeline they would escalate, so the escalation count would rise.
- The bands separate the false candidates: `contradicted`, `unlikely` and `possible` hold almost no real ones. But `likely` and `certain` hold real candidates at almost the same share (0.32 and 0.35). So the top two bands carry no signal for the threshold, and no other map of the same bands can fix that.

## Method

E3 and E3b selected the verifier: Sonnet 5.5 at medium effort, with one call that gives truth and severity. The first arm is the E3 result of that verifier with the score prompt (`prompts/verifier.md`). The second arm is the same verifier with the five bands prompt (`prompts/verifier-bands.md`), on the same 239 candidates, through `pr-review replay --prompt bands`. Each band maps to a score in the frontmatter of the prompt, and the decision uses that score. The frozen build of 03a87ee (0.17.0) ran the arm, with the shared judge cache of E3.

The run of the second arm was stopped after its last call, before its report was written. The figures below come from its stored results: the posted set of a case is the entries whose decision passed, scored by `scoreFindings` from the judge cache with no judge client and no model call. The same script gives exactly the replay figures of the first arm (posted recall 0.464, precision 0.403), so the two scorings agree.

The rule: the five bands become the default when the posted recall and the posted precision are each not more than 0.05 lower, and the count of escalations is lower.

### The rule on made-up figures

Before the figures existed, a script ran the rule on made-up figures. The score arm had a posted recall of 0.46, a precision of 0.40 and 145 results in the band.

| Made-up bands arm | Result |
|---|---|
| The same recall and precision, 100 in the band | becomes the default |
| Recall 0.04 lower, 100 in the band | becomes the default |
| Recall 0.08 lower, 100 in the band | stays |
| Precision 0.08 lower, 100 in the band | stays |
| The same recall and precision, 145 in the band | stays |
| Recall higher, 160 in the band | stays |

So the rule can give each result.

## Figures

| Arm | Posted recall | Posted precision | Posted | In the band | Real candidates held | Other candidates rejected | Cost for each verification | Unsure | Capped |
|---|---|---|---|---|---|---|---|---|---|
| Score 0 to 100 | 0.464 | 0.403 | 144 | 145 | 75 of 75 | 13 of 164 | $0.103 | 0 | 0 |
| Five bands | 0.256 | 0.438 | 73 | 154 | 73 of 75 | 11 of 164 | $0.083 | 0 | 0 |

The share of candidates that match a golden with a real label (a posting label or `dont_post`), for each band:

| Band (score) | Candidates | Real | Share |
|---|---|---|---|
| contradicted (5) | 7 | 0 | 0.00 |
| unlikely (25) | 3 | 0 | 0.00 |
| possible (50) | 6 | 1 | 0.17 |
| likely (75) | 141 | 45 | 0.32 |
| certain (95) | 82 | 29 | 0.35 |

### The map and the scale

The map is a choice; the scale is what the verifier gives. To show which of the two the result depends on, the stored results of the bands arm were decided again under other maps, with no model call. Each decision is made by `decideFirst`, the rule of the tool, with the mapped score, the threshold 80 and the band of 60 to 85. The measured map gives exactly the stored decisions, so the method is sound.

| Map from a band to a score | Posted recall | Posted precision | Posted | In the band |
|---|---|---|---|---|
| Score 0 to 100 (first arm) | 0.464 | 0.403 | 144 | 145 |
| Measured: 5, 25, 50, 75, 95 | 0.256 | 0.438 | 73 | 154 |
| B: `certain` posts, `likely` escalates (the same as measured) | 0.256 | 0.438 | 73 | 154 |
| C: `likely` posts and escalates (`likely` is 80) | 0.528 | 0.365 | 181 | 154 |
| A: `likely` and `certain` post, with no band (`likely` is 90) | 0.528 | 0.365 | 181 | 47 |

Under map B, the replay posts the same set as the measured map. In the pipeline, the 141 `likely` results would go to the escalation. Map A would pass the rule: recall 0.064 higher, precision 0.038 lower, and 47 results in the band against 145. Most of that gain comes from less escalation: a `likely` result posts at once, and only a finding with `needs_context` escalates. Map A was chosen after the figures were seen, so it is a hypothesis for a later run with a map fixed before the figures, and not a result of this rule. Such a run must also settle the escalation question of E3, because map A removes most of the escalation.

For each score range of the score arm:

| Score | Candidates | Real | Share |
|---|---|---|---|
| 0 to 49 | 13 | 0 | 0.00 |
| 50 to 59 | 5 | 2 | 0.40 |
| 60 to 69 | 19 | 2 | 0.11 |
| 70 to 79 | 39 | 12 | 0.31 |
| 80 to 89 | 96 | 34 | 0.35 |
| 90 to 100 | 67 | 25 | 0.37 |

The score has the same weakness at its top: from 70 up, the share of real candidates is about one third in every range. The score separates the clear false candidates (below 50) and little else. This agrees with E3: the verifier holds almost every real candidate, but it rejects only 7 to 9% of the others.

## Time

From the stored durations, with no model call. The five bands prompt took 7.2 s for each verification at the median (90th percentile 13.0 s, maximum 34.9 s), against 8.0 s (20.9 s, 41.9 s) for the score prompt on the same verifier. The bands prompt is a little faster and has a shorter tail.

## Spend

The bands arm cost $19.84: $2.41 for the probe of two cases, and $17.43 for the rest. The last start passed the limit of the principal ($10) by $7.43, because the arm had nearly finished when the lower limit arrived.

## Limits

- The map from a band to a score is a choice of this experiment, not a measured value. A map that puts `likely` above the threshold posts more (map A above), but `likely` and `certain` hold the same share of real candidates, so no map makes the top bands a better filter.
- The other maps use the threshold 80 and the band of 60 to 85 for every candidate. Every built-in reviewer has the threshold 80, and no case config changes the band.
- A replay has no escalation, no merge and no cap. In the pipeline, the `likely` results would escalate to Opus 5.5 at high effort, and the escalation would decide them.
- One run of each arm, on one repeat of S1.
- The figures of the bands arm come from its stored results, not from its report, because the run was stopped before the report.
