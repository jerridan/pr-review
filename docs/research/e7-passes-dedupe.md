# E7: the passes of diff-bugs and security, and the cross-pass dedupe key

Status: done 2026-11-15. Part of D4c in TICKETS.md. The data is S1, the reference run of D4c. This note needed no model call.

## Result

- diff-bugs goes to one pass. The second pass added 2 posted-label goldens on 28 cases at $7.15 for each added golden, against $0.58 for each golden of one pass. R is 12.37, and the upper end of its 90% interval is 63.48, so test (b) fails.
- security goes to one pass. The second pass added 3 goldens at $2.89 for each added golden, against $0.61 for each golden of one pass. R is 4.77, and its interval has no upper bound, so test (b) fails.
- The cross-pass dedupe key stays. A second pass gave 38 claims on a span and a category that the first pass also gave. None of them matched a posted-label golden that no other finding matched.
- After this change, every built-in reviewer runs one pass at both tiers. A repo still sets `reviewers.<name>.passes` to buy a second pass.

## Method

S1 is one repeat of the full pipeline at the defaults of tool version 0.15.0 (f8f5b38) on the 28 pinned cases, with `--paired`. Its records are in the crew record root, not in the repo. diff-bugs and security ran two passes in every case, because that was the default.

The passes. `pr-review eval-report --by-pass` on the S1 records, with no `--ask-missing`, so with no model call. The section treats the two passes of one reviewer as two independent samples of one pass. It applies the D8 rule:

- (b) R is the added cost for each added posted-label golden, over the one-pass cost for each posted-label golden. The upper end of the 90% bootstrap interval of R over the cases must be at most 2.
- (c) The precision of both passes must be no more than 0.05 below the one-pass precision.
- A reviewer gets `passes: 2` when (b) and (c) pass. Otherwise it goes to one pass.

The rule can give both results. The tests in `test/eval-by-pass.test.ts` (lines 513 to 570) give it made-up figures. With R equal to 1 in every resample, the result is `passes 2`. With R above 2, with no added golden, or with a precision drop above 0.05, the result is `stays at 1`. These tests existed before S1. This note did not write new made-up figures before it read the S1 figures. That is a step of the D4c rules that this note did late.

The dedupe key. A script read the reviewer findings of each S1 record. For diff-bugs and security, it counted each pass 2 finding with a pass 1 finding of the same reviewer on an overlapping span and with the same category, but with another claim. The fingerprint holds the claim, so such a pair goes to the verifier two times. For each such finding, the script looked for a posted-label golden that it matches by the exact rule (same file, overlapping span, same category) and that no other finding of the record matches. The rule of E7: change the key only if such a golden exists. With one or more, the key changes. With none, it stays. The exact rule finds fewer matches than the judge does, so the count of such goldens is a lower bound.

## Figures

The passes, from `eval-report --by-pass` (28 cases, 1 repeat, no case left out):

| Scope | One-pass goldens | One-pass cost per golden | Added goldens | Added false | Cost per added golden | R | Interval of R | Precision, one pass and both | Result |
|---|---|---|---|---|---|---|---|---|---|
| diff-bugs | 33 | $0.578 | 2 | 4 | $7.147 | 12.37 | 5.48 to 63.48 | 0.717 and 0.673 | one pass |
| security | 18 | $0.606 | 3 | 2.5 | $2.892 | 4.77 | 1.99 to no bound | 0.706 and 0.677 | one pass |
| both reviewers | 37.5 | $0.800 | 1.5 | 4.5 | $15.312 | 19.15 | 8.01 to no bound | 0.708 and 0.661 | information only |

Test (c) passed for both reviewers. Test (b) failed for both. The noise of one pass, pass 1 less pass 2: diff-bugs 0 goldens and 4 false posted findings; security 2 goldens and -1 false posted findings.

The S1 run as a whole: posted recall 0.570, raw recall 0.639, strict precision 0.534, adjudicated precision 0.610, $5.56 per case for the review and $0.12 per case for the judge.

The dedupe key:

| Count | Value |
|---|---|
| Pass 2 findings with another claim on a span and a category of pass 1 | 38 |
| Of those, findings that match a posted-label golden (exact rule) | 24 |
| Of those, findings whose golden no other finding matched | 0 |

## Spend

S1 cost $165.00 on the plan login: $159.02 in the result files of the 28 cases, and $5.98 for one failed attempt of injection-walle-6. That attempt failed because a verifier call threw at its $0.50 budget, and the tool counted the throw as a failed call, not as a limit stop. The case passed on the second attempt. The same PR as this note fixes the fault. The analysis of this note made no model call.

## Limits

- One repeat of 28 cases. The added goldens are few (2 and 3), so the intervals are wide. The interval of R for security has no upper bound, because 1231 of the 10000 resamples had no added golden.
- The two passes of one reviewer are two samples of one pass, so the one-pass arm is the mean of two sets. The full pipeline has other reviewers that can raise the same finding, so the added goldens of a second pass are an upper bound of its gain.
- The extras judge gave 22 unknown answers. They touch adjudicated precision only. No figure of the rule uses it.
- The dedupe count uses the exact match rule, not the judge.

## The E3 figures from S1

E3 asks for three figures from the S1 records with no model call. `pr-review replay --arm stored` gives them. The stored arm makes no verifier call. It asked the judge 118 times ($1.41) to match the candidates to the goldens, because the eval cache holds only the questions of the posted findings and of the raw pass.

- The verifier escalated 135 of 239 verifications (56%). A score in the band of 60 to 85 escalates, and most first scores fall in the bucket from 80 to 89.
- The escalation changed the decision of 28 of the 135 (21%).
- The escalations cost $47.81. The first verifier calls cost $39.99. So the escalations cost more than the first verifier.

The cost of one call:

| Call | Count | Median | 99th percentile | Maximum | At the cap |
|---|---|---|---|---|---|
| First verifier (Sonnet 5.5, high, cap $0.50) | 239 | $0.101 | $0.401 | $0.424 | 0 |
| Escalation (Opus 5.5, high, cap $1) | 135 | $0.206 | $0.829 | $0.999 | 0 in the records, 1 at $0.999 |

No verification ended unsure. One first verifier call reached its cap in the failed attempt of injection-walle-6. That record is not in S1.

## The verifier caps

The cap of the first verifier goes from $0.50 to $1, and the cap of the escalation goes from $1 to $2. The 99th percentile of the first verifier is $0.40, near its old cap, and one call reached that cap. The most expensive escalation in S1 cost $0.999, at its old cap. A cap costs nothing until a call reaches it, and a call that reaches it ends unsure. So a higher cap changes the cost only of the calls that the old cap stopped. The Opus arms of E3 cost more for each call than Sonnet, and they need room above $0.50. `replay --verifier-cap` sets the cap of one arm. The principal decided this change. The caps can change again when E3 gives figures for other models.
