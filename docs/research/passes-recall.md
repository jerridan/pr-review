# Passes and recall: one pass against two for history and tests

Date: 2026-11-14. Tool version: 0.12.0 (main at 6a9bfd7). Cases: the pin `373266b`, 28 cases, 125 posted-label goldens (56 blocking, 38 suggestion, 31 nit).

## Decision

history and tests stay at one pass at both tiers. Neither reviewer meets the rule below. diff-bugs and security keep two passes: this measurement did not test them (see "diff-bugs and security").

## Method

The eval ran history and tests only, each with two passes, at the full tier, one time on each of the 28 cases:

```bash
pr-review eval --cases eval/cases --repeat 1 --reviewers history,tests --passes history=2,tests=2 --paired --tier full --no-extras --resume --out <out>
```

The two passes of one reviewer have the same inputs and run in parallel, so they are two independent samples of one pass. The run record names the passes that raised each finding (its sources). So one run gives three sets for each reviewer:

- **pass 1**: the findings that pass 1 raised;
- **pass 2**: the findings that pass 2 raised;
- **both**: the findings of either pass. This is the two-pass arm.

The one-pass arm is the mean of the pass 1 set and the pass 2 set. The difference between pass 1 and pass 2 is the noise of one pass.

`pr-review eval-report --by-pass` made the figures from the stored records and the judge answers of the run, with no model call. Two judge questions of the single-pass sets had no stored answer, because the live scoring of all findings never needed them. `--ask-missing` asked the two, for $0.02. The figures below have no unanswered question.

Definitions:

- A posted finding is in a set when one of its sources is in the set. A reviewer's sets hold only that reviewer's sources.
- **Goldens**: the posted-label goldens that the posted findings of the set match. **Recall** is goldens over the 125 posted-label goldens.
- **False posted**: the posted findings of the set that match no posted-label golden.
- **Precision**: goldens over posted findings. The one-pass precision is pooled over the two single sets.
- **Cost of a set**: the reviewer queries of its passes, and the verifier and escalation queries of each verification with a source in the set. Triage, merge and the other run-wide queries are in no set. A verification with sources in both passes counts in each single set, and one time in both.
- **One-pass cost per golden**: the mean single-set cost over the mean single-set goldens.
- **Added**: both less the one-pass mean.
- **Bootstrap**: the percentile method over the 28 cases, 10000 resamples, seed 20261114, at the 90% level. Each resample draws 28 cases with replacement.

## The rule

The principal set this rule on 2026-11-14, before the figures existed. It replaces the rule of the ticket ("gain above zero in every repeat"). In the paired design the set of both can never match fewer goldens than a single set, so that rule could not fail.

A reviewer gets two passes at the full tier when both tests hold:

- **(b) cost.** R is the added cost per added posted-label golden over the one-pass cost per posted-label golden. R comes from the sums over the cases. The upper end of the 90% bootstrap interval of R must be at most 2. A resample with no added golden counts as a ratio above 2.
- **(c) precision.** The precision of both must be no more than 0.05 below the one-pass precision.

The added goldens per case is information only. It is almost never below zero, so its interval shows the size of the gain and not a test.

## Result

### history

| Set | Goldens (blocking / suggestion / nit) | Recall | Posted | False posted | Precision | Cost (USD) |
|-----|---------------------------------------|--------|--------|--------------|-----------|------------|
| pass 1 | 22 (12 / 8 / 2) | 0.176 | 26 | 4 | 0.846 | 11.32 |
| pass 2 | 22 (12 / 9 / 1) | 0.176 | 24 | 2 | 0.917 | 15.57 |
| one pass (mean) | 22 | 0.176 | 25 | 3 | 0.880 | 13.45 |
| both | 26 (14 / 10 / 2) | 0.208 | 31 | 5 | 0.839 | 25.24 |

- Added by the second pass: 4 goldens (2 blocking), recall +0.032, 2 false posted findings, $11.80.
- Goldens that only pass 2 found: 4. Goldens that only pass 1 found: 4. False posted findings that only pass 2 raised: 1. Only pass 1: 3.
- Noise of one pass (pass 1 less pass 2): 0 goldens, precision -0.071.
- Added goldens per case: mean 0.143, 90% interval 0.071 to 0.232.
- One-pass cost per golden: $0.61. Added cost per added golden: $2.95.
- (b) R = 4.83, 90% interval 2.68 to 10.18. The upper end is above 2: **fail**.
- (c) precision 0.839 against 0.880, limit 0.830: **pass**.
- Result: **stays at one pass**.

### tests

| Set | Goldens (blocking / suggestion / nit) | Recall | Posted | False posted | Precision | Cost (USD) |
|-----|---------------------------------------|--------|--------|--------------|-----------|------------|
| pass 1 | 27 (7 / 13 / 7) | 0.216 | 45 | 18 | 0.600 | 35.47 |
| pass 2 | 27 (7 / 14 / 6) | 0.216 | 46 | 19 | 0.587 | 34.95 |
| one pass (mean) | 27 | 0.216 | 45.5 | 18.5 | 0.593 | 35.21 |
| both | 28 (7 / 14 / 7) | 0.224 | 58 | 30 | 0.483 | 60.36 |

- Added by the second pass: 1 golden, recall +0.008, 11.5 false posted findings, $25.15.
- Goldens that only pass 2 found: 1. Only pass 1: 1. False posted findings that only pass 2 raised: 11. Only pass 1: 10.
- Noise of one pass: 0 goldens, precision +0.013.
- Added goldens per case: mean 0.036, 90% interval 0 to 0.107.
- One-pass cost per golden: $1.30. Added cost per added golden: $25.15.
- (b) R = 19.29, 90% interval 7.70 to unbounded (3666 of 10000 resamples have no added golden): **fail**.
- (c) precision 0.483 against 0.593, limit 0.543: **fail**.
- Result: **stays at one pass**.

### history and tests together

| Set | Goldens (blocking / suggestion / nit) | Recall | Posted | False posted | Precision | Cost (USD) |
|-----|---------------------------------------|--------|--------|--------------|-----------|------------|
| pass 1 | 35 (13 / 14 / 8) | 0.280 | 55 | 20 | 0.636 | 46.79 |
| pass 2 | 36 (14 / 16 / 6) | 0.288 | 56 | 20 | 0.643 | 50.51 |
| one pass (mean) | 35.5 | 0.284 | 55.5 | 20 | 0.640 | 48.65 |
| both | 39 (15 / 16 / 8) | 0.312 | 71 | 32 | 0.549 | 85.60 |

- Added: 3.5 goldens, recall +0.028, 12 false posted findings, $36.95.
- Goldens that only pass 2 found: 4. Only pass 1: 3. False posted findings that only pass 2 raised: 11. Only pass 1: 11.
- Added goldens per case: mean 0.125, 90% interval 0.054 to 0.196.
- One-pass cost per golden: $1.37. Added cost per added golden: $10.56.
- R = 7.70, 90% interval 4.78 to 14.78. Precision 0.549 against 0.640.
- This scope is information only. The rule decides per reviewer.

Seven cases gained a golden from the second pass of history: `injection-walle-6`, `injection-websites-120`, `martian-sentry-93824`, `pool-pr-review-46`, `reviewbench-axios-10836`, `reviewbench-node-postgres-3650` and `reviewbench-spm-19`. One case gained a golden from the second pass of tests: `pool-pr-review-46`.

## Reading

- A second pass of history finds real goldens: 4 more, 2 of them blocking, with a small precision loss. The two single passes found the same count but not the same goldens: each found 4 that the other missed. But each added golden costs about five times the one-pass cost of a golden, and the whole interval of R is above 2. At the current cost, a second pass of history is a poor buy. A repo that values history findings more can set `reviewers.history.passes: 2`.
- A second pass of tests adds almost no golden and about 11 false posted findings. It lowers precision by 0.11. It fails both tests.
- The run measured history and tests alone. In the full pipeline another reviewer can raise the same finding, so the real gain of a second pass is at most the gain here.
- The two single sets give the noise of one pass: 0 goldens for each reviewer. So the 4 added goldens of history are a real gain, and the cost decides against it.

## diff-bugs and security

The ticket asked for the same report for diff-bugs and security from the run records of the D4b baseline. Those records do not exist: the baseline wrote its `--out` directory to a session scratchpad that is gone. A record from before 0.12.0 also has no source fields. So this note has no figures for diff-bugs and security, and their default of two passes stays as the design states it.

## Cost

The measurement cost $89.15 of model calls (review and judge), in two plan windows: $50.67 for 13 cases, then $38.48 for 15 cases. The run stopped one time at the window limit, and the case in flight at that stop is not in the figure. `--ask-missing` cost $0.02. The budget was $150.

## Earlier note

The note of 2026-10-13 measured diff-bugs alone on the synthetic fixture, five runs per arm. Both arms found the one planted bug in every run, so that fixture could not separate the arms.
