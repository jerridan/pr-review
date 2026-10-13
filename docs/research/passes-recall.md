# Passes and recall: diff-bugs with one pass against two

Date: 2026-10-13. Tool version: the D2 branch at commit 49062d0. Script: `scripts/measure-passes.sh 5`.

## Method

The script built the fixture repo from `scripts/make-fixture.sh` twice. Each fixture holds a `.pr-review/config.yaml` on its base commit. The first sets `reviewers.diff-bugs.passes` to 1. The second sets it to 2. Both disable the six other built-in reviewers, so only `diff-bugs` runs and every posted finding is a `diff-bugs` finding. The script ran `pr-review run --format json` five times per arm with the real SDK, on the user's Claude login. A run counts as covered when a posted finding covers the planted line.

## Result

| Arm | Runs | Failed | Covered | Mean cost (USD) | Mean posted findings |
|-----|------|--------|---------|-----------------|----------------------|
| passes 1 | 5 | 0 | 5 | 0.5659 | 1.00 |
| passes 2 | 5 | 0 | 5 | 0.6567 | 1.00 |

## Reading

- Both arms found the planted bug in every run. The fixture has one planted bug, an off-by-one in a loop bound, and Opus 5.5 at low effort finds it in one pass. This fixture cannot show a recall difference between one pass and two.
- The second pass adds about 16 percent to the cost of a run with one reviewer. The fingerprint dedupe before verification kept the verifier cost flat: one verification per run in both arms.
- The design (section 3.9) keeps the default at 2 passes for `diff-bugs` and `security`, on the evidence that five runs of one model on SWR-Bench agreed on only 27 golden hits. This measurement neither supports nor contradicts that evidence. It shows that the question needs a harder case set.

## Next step

Repeat the measurement in the D4 harness on cases with several planted bugs, or with a bug that one pass misses some of the time. Report covered hits per arm over at least 20 runs. Until then the default stays at 2.
