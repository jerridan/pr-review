# E5: the cap on non-blocking findings

Result: the cap changes to nits only. The cap dropped 14 suggestions in 8 runs. It dropped no blocking finding.

## Question

Does the posting cap drop findings that matter? This experiment decides issue 23.

## Method

The experiment makes no model call. It reads every recorded run. For each run it lists the findings that the cap dropped, with their severity. Then it computes what a cap on nits only would post.

The record sources, by name:

- The `pr-review-records` branch.
- The D7 run, and the D7 run with the split reviewers.
- The first D5 eval run.
- The CI records that are not on the branch.
- The D8 measurement run.
- The D6 runs: `gate-out-attempt1`, `gate-out` and `baseline-out`.
- The D5 acceptance run.
- The D3 live check.

The dedupe key is the repo, the PR, the head and the start time. One run that appears in two places counts once. The scan skips test fixtures, which have the repo name `fixture`. The scan skips 42 JSON files that are not records.

The nits-only arm works as follows. Every blocking finding and every suggestion finding posts. Nits fill the same cap value that the run used, in ranked order. The count of posted findings in the arm is then comparable to the count that the cap posted.

Paths below are relative to the crew record root, `~/.claude/crew/d4c-e5-posting-cap-3a7e/evidence/`. The scripts are `e5.py` and `tables.py`. The per-run data is `e5-summary.json`. Copies of the eval reports are in `reports/`.

## Spend

$0. The experiment made no model call.

## Figures

The first table gives each source. "Posted now" is the count that the cap posted. "Posted nits only" is the count that the nits-only arm would post.

| Source | records | with drops | dropped suggestion | dropped nit | posted now | posted nits only |
|---|---|---|---|---|---|---|
| pr-review-records branch | 86 | 0 | 0 | 0 | 45 | 45 |
| D7 run, split | 10 | 2 | 5 | 1 | 42 | 48 |
| D7 run | 10 | 2 | 5 | 2 | 33 | 40 |
| D5 eval run 1 | 9 | 0 | 0 | 0 | 11 | 11 |
| CI records not on the branch | 6 | 0 | 0 | 0 | 0 | 0 |
| D8 measurement run | 28 | 0 | 0 | 0 | 71 | 71 |
| D6 gate-out-attempt1 | 10 | 0 | 0 | 0 | 17 | 17 |
| D6 gate-out | 10 | 2 | 0 | 2 | 38 | 40 |
| D6 baseline-out | 10 | 2 | 4 | 3 | 36 | 43 |
| D5 acceptance run | 10 | 0 | 0 | 0 | 0 | 0 |
| D3 live check | 1 | 0 | 0 | 0 | 0 | 0 |
| Total | 190 | 8 | 14 | 8 | 293 | 315 |

The second table gives each run in which the cap dropped a finding. "Posted" and "Dropped" give the counts of blocking, suggestion and nit findings (B/S/N) and of suggestion and nit findings (S/N).

| Source | Case | Tool version | Hunks | Cap | Posted (B/S/N) | Dropped (S/N) | Posted now | Posted nits only |
|---|---|---|---|---|---|---|---|---|
| D7 run, split | martian-sentry-greptile-1 | 0.5.0 | 5 | 5 | 8/5/0 | 4/0 | 13 | 17 |
| D7 run, split | martian-discourse-graphite-1 | 0.5.0 | 5 | 5 | 2/5/0 | 1/1 | 7 | 9 |
| D7 run | martian-sentry-greptile-1 | 0.5.0 | 5 | 5 | 3/5/0 | 2/0 | 8 | 10 |
| D7 run | martian-discourse-graphite-1 | 0.5.0 | 5 | 5 | 1/5/0 | 3/2 | 6 | 11 |
| D6 gate-out | martian-sentry-greptile-1 | 0.4.0 | 5 | 5 | 5/4/1 | 0/1 | 10 | 11 |
| D6 gate-out | martian-discourse-graphite-1 | 0.4.0 | 5 | 5 | 1/5/0 | 0/1 | 6 | 7 |
| D6 baseline-out | martian-sentry-greptile-1 | 0.5.0 | 5 | 5 | 3/5/0 | 2/2 | 8 | 12 |
| D6 baseline-out | martian-discourse-graphite-1 | 0.5.0 | 5 | 5 | 1/5/0 | 2/1 | 6 | 9 |

The dropped findings:

- D7 run, split, martian-sentry-greptile-1: suggestion, score 88, test, src/sentry/api/paginator.py:878. No test covers OptimizedCursorPaginator or its negative-offset branch.
- D7 run, split, martian-sentry-greptile-1: suggestion, score 85, test, src/sentry/api/paginator.py:182. The new offset handling in BasePaginator.get_result has no test, and every paginator uses it.
- D7 run, split, martian-sentry-greptile-1: suggestion, score 80, docs, src/sentry/api/paginator.py:879. The comment says permission checks make the negative-offset branch safe, but the code next to it says the branch exposes data beyond normal pagination bounds.
- D7 run, split, martian-sentry-greptile-1: suggestion, score 80, security, src/sentry/utils/cursors.py:26. Cursor parsing accepts a negative offset from the user without validation.
- D7 run, split, martian-discourse-graphite-1: suggestion, score 78, security, app/controllers/uploads_controller.rb:64. Whether a file goes through ImageMagick depends only on the user-supplied filename's extension, so any content named like an image is parsed by ImageMagick.
- D7 run, split, martian-discourse-graphite-1: nit, score 88, bug, app/controllers/uploads_controller.rb:64. The loop ignores the result of downsize, so if the conversion fails the oversized file is still passed to Upload.create_for and the user sees a size error.
- D7 run, martian-sentry-greptile-1: suggestion, score 85, docs, src/sentry/api/paginator.py:879. The comment says the negative slice is safe because permissions are checked at the queryset level, which is unsupported and hides the problem.
- D7 run, martian-sentry-greptile-1: suggestion, score 85, security, src/sentry/utils/cursors.py:26. Cursor accepts negative offsets from user-supplied cursor strings without validation.
- D7 run, martian-discourse-graphite-1: suggestion, score 88, test, app/controllers/uploads_controller.rb:63. No test covers the new downsize loop: shrinking an oversized image, skipping images already under the limit and non-images, the 5-attempt cap, and an image still too large after 5 passes.
- D7 run, martian-discourse-graphite-1: suggestion, score 72, bug, app/controllers/uploads_controller.rb:67. Animated GIF detection matches `.GIF` against the tempfile path, which usually has no .gif extension, so animated GIFs are flattened to their first frame.
- D7 run, martian-discourse-graphite-1: suggestion, score 45, security, app/controllers/uploads_controller.rb:64. Oversized user images are now run through ImageMagick synchronously up to 5 times per request, which allows CPU and memory exhaustion (for example with decompression-bomb images).
- D7 run, martian-discourse-graphite-1: nit, score 92, convention, app/controllers/uploads_controller.rb:55. The hardcoded `10.megabytes` replaces the SiteSetting-based download limit.
- D7 run, martian-discourse-graphite-1: nit, score 55, docs, config/locales/server.en.yml:1037. The site setting descriptions still say these values are the maximum upload size, but uploads are now capped at a hardcoded 10MB and larger images are downsized.
- D6 gate-out, martian-sentry-greptile-1: nit, score 88, docs, src/sentry/utils/cursors.py:26. The comment says Cursor now allows negative offsets, but the code under it is unchanged, so it describes no new behavior.
- D6 gate-out, martian-discourse-graphite-1: nit, score 55, docs, config/locales/server.en.yml:1037. The site setting descriptions still say these settings set the maximum upload size, but uploads now accept up to a hardcoded 10MB. Images are then downsized, and attachments are no longer checked against max_attachment_size_kb on the client.
- D6 baseline-out, martian-sentry-greptile-1: suggestion, score 88, docs, src/sentry/api/paginator.py:878. The comment says reaching data beyond pagination bounds is safe because of queryset-level permission checks, which this code does not show.
- D6 baseline-out, martian-sentry-greptile-1: suggestion, score 85, bug, src/sentry/api/paginator.py:886. The prev-cursor trimming compares the result length against offset + limit + extra instead of the slice size actually used.
- D6 baseline-out, martian-sentry-greptile-1: nit, score 92, convention, src/sentry/api/endpoints/organization_auditlogs.py:68. The two paginate calls are nearly identical, differing only in paginator class and one extra keyword.
- D6 baseline-out, martian-sentry-greptile-1: nit, score 92, convention, src/sentry/api/paginator.py:821. OptimizedCursorPaginator duplicates almost all of BasePaginator.get_result instead of reusing it or overriding only what it needs.
- D6 baseline-out, martian-discourse-graphite-1: suggestion, score 85, bug, app/controllers/uploads_controller.rb:67. The GIF animation check runs on the tempfile path, which has no .gif extension, so animated GIFs are downsized with the non-animated instructions and lose their animation.
- D6 baseline-out, martian-discourse-graphite-1: suggestion, score 66, bug, app/controllers/uploads_controller.rb:63. The downsize loop reads `tempfile.size` from an open Tempfile after `OptimizedImage.downsize` rewrote the same path, and it never checks whether downsize succeeded.
- D6 baseline-out, martian-discourse-graphite-1: nit, score 92, docs, app/controllers/uploads_controller.rb:55. The description does not say that API URL downloads now use a hard-coded 10MB limit instead of max_image_size_kb.

## Decision rule

From TICKETS.md, E5, word for word:

> Rule: if the cap dropped a blocking or a suggestion finding in a recorded run, the cap changes to nits only, as the design update of issue 23 says. If it dropped none, the cap stays and the note gives the counts.

## Test of the rule on made-up figures

The test uses made-up figures. It shows that the rule can give each of its two results.

Table A is a made-up set of three runs. One run dropped a suggestion.

| Run | Dropped blocking | Dropped suggestion | Dropped nit |
|---|---|---|---|
| A1 | 0 | 0 | 0 |
| A2 | 0 | 1 | 2 |
| A3 | 0 | 0 | 1 |

The rule finds a dropped suggestion in run A2. The result is that the cap changes to nits only.

Table B is a made-up set of three runs. The cap dropped only nits.

| Run | Dropped blocking | Dropped suggestion | Dropped nit |
|---|---|---|---|
| B1 | 0 | 0 | 0 |
| B2 | 0 | 0 | 2 |
| B3 | 0 | 0 | 1 |

The rule finds no dropped blocking finding and no dropped suggestion. The result is that the cap stays. The note then gives the counts: 3 runs, 2 runs with drops, 0 dropped blocking findings, 0 dropped suggestions and 3 dropped nits.

## Result

The real figures give the first result. The cap dropped 14 suggestions and 8 nits in 8 of the 190 runs. It dropped no blocking finding. The cap changes to nits only.

A cap on nits only posts 315 findings where the cap posted 293. The 22 findings that the cap dropped are 14 suggestions and 8 nits. The nits-only arm posts all 14 suggestions. It posts the nits up to the cap value, and no run had more nits than that value, so it posts all 8 nits too. The difference of 22 is the count of dropped findings.

Every run with a drop had a cap of 5. In 7 of the 8 runs, the posted findings held no nit, because the suggestions filled the cap.

The change keeps the formula `3 + ceil(hunks / 4)`, at most 20, and the three config keys. Their meaning is now the cap on nits.

## Limits

- All 8 runs with drops are on two cases, `martian-sentry-greptile-1` and `martian-discourse-graphite-1`. Each has 5 hunks, so the cap is 5. No run on a larger PR dropped a finding.
- The D8 measurement run, at version 0.12.0, dropped none on the same cases.
- The records carry no match of each finding to a golden. The note cannot say how many dropped findings matched a golden. The eval reports give recall and raw recall for each run, and copies are in `reports/`.
- The records of earlier versions differ in their reviewers and their verifier. The runs are not one population.
- The rule fires on one dropped suggestion. It does not weigh how many suggestions the cap dropped.
