# D15: a staff-engineer reviewer on Sol 6.2

Result: one more reviewer beside the six specialists, a skeptical staff engineer on Sol 6.2 (`gpt-6.2-sol`) at medium effort, raises the recall of the review from 0.448 / 0.544 to 0.544 / 0.608 (the two repeats of the specialists) and raises precision too, from 0.412 / 0.430 to 0.469 / 0.478. It finds 8 known items that no specialist found in either repeat, and 7 of them are blocking. Alone it has a low recall (0.224) and a high precision (0.651). It is the slowest reviewer in 27 of 28 cases. The pipeline as it is cannot carry its refactor recommendations: 1 of 4 posts, as a nit. No default changes: this is an experiment in the eval only, and the user decides.

## Question

What does one more reviewer, a skeptical staff engineer, add beside the specialists? Does it find new known items or the same ones, and how do the combined figures look?

## Method

- The reviewer: `prompts/staff-reviewer.md`, from the user's draft. It judges contracts, open for extension and closed for change, responsibilities and coupling, module boundaries, patterns, YAGNI, cases not handled, performance and security trade-offs, and a simpler change. It may give at most two refactor recommendations, written as tickets, and at most six findings in all. Each claim starts with a tag ([design], [boundary], [edge-case], [scope], [performance], [security-tradeoff], [refactor]), and the tag maps to a category of the finding schema (other, bug, performance, security), so the verifier and the matcher work as they are. One review of the prompt by a prompt engineer, one round, before the runs.
- The run: `pr-review eval-codex-review --prompt staff-reviewer.md --model gpt-6.2-sol --effort medium` on the 28 pinned cases (cases repo at 373266b), one repeat, frozen build of the branch before its rebase (302b9ac, the code of this PR). A probe of 4 cases across the fixed size limits ran first, one case at a time. A first probe on an earlier draft of the prompt (3 cases) is kept in the record folder and is not in any figure.
- The verifier: `pr-review replay --candidates` with the default verifier, Sonnet 5.5 medium, first verifier only: no escalation, no merge, no cap.
- The base: the baseline records of 0.20.0 (two repeats of the six specialists), seen through `replay --arm stored`, which reads their stored first results of the same verifier. So both sides have the same first-verifier base. The judge answers came from the judge caches of the baseline and of D4c, and 168 new judge calls.
- Known items: the posted-label goldens of the cases (125). "New" is a known item that the staff reviewer posts and that no specialist posts in either repeat. "Existing" is one that a specialist also posts.
- Combined: the union of the known items that the specialists of one repeat post and that the staff reviewer posts. Combined precision counts every posted finding of both. A real run merges duplicates, so it can post fewer.

## Figures

| group | cases | goldens | staff cand. | staff posted | staff recall before | staff recall after | staff precision | new | existing | spec recall r1 / r2 | spec+staff recall r1 / r2 | spec precision r1 / r2 | spec+staff precision r1 / r2 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| under 100 | 9 | 27 | 16 | 7 | 0.296 | 0.185 | 0.714 | 1 | 4 | 0.333 / 0.519 | 0.444 / 0.556 | 0.600 / 0.609 | 0.636 / 0.633 |
| 100 to 300 | 12 | 40 | 35 | 17 | 0.300 | 0.250 | 0.588 | 3 | 7 | 0.600 / 0.675 | 0.700 / 0.750 | 0.393 / 0.380 | 0.436 / 0.420 |
| 300 to 1,000 | 5 | 42 | 24 | 17 | 0.286 | 0.262 | 0.647 | 4 | 7 | 0.452 / 0.476 | 0.548 / 0.571 | 0.422 / 0.400 | 0.484 / 0.463 |
| 1,000 or more | 2 | 16 | 9 | 2 | 0.125 | 0.125 | 1.000 | 0 | 2 | 0.250 / 0.438 | 0.312 / 0.438 | 0.267 / 0.500 | 0.353 / 0.562 |
| walle/websites | 8 | 6 | 18 | 6 | 0.500 | 0.500 | 0.500 | 0 | 3 | 0.833 / 0.833 | 0.833 / 0.833 | 0.278 / 0.227 | 0.333 / 0.286 |
| total | 28 | 125 | 84 | 43 | 0.272 | 0.224 | 0.651 | 8 | 20 | 0.448 / 0.544 | 0.544 / 0.608 | 0.412 / 0.430 | 0.469 / 0.478 |

New known items (8):
- martian-sentry-67876 golden 0 (blocking): The OAuth `state` value is `pipeline.signature`. The signature is the same for the whole pipeline and is not a random value for each request, so it does not protect the flow against forged requests.
- martian-sentry-67876 golden 1 (blocking): The check reads `integration.metadata["sender"]["login"]` with no test for the `sender` key. An integration made without `sender` metadata raises a `KeyError`.
- martian-sentry-greptile-1 golden 1 (blocking): The code reads has_global_access on the organization member without a None check. A request with an API key or org token has no member, so the endpoint crashes.
- pool-pr-review-46 golden 0 (blocking): Cache lookup happens after checkCases has already cloned and checked out every case. Even a fully cached resume therefore clones every bundle, contrary to the promised clone-free reuse and adding unnecessary disk space and startup work for large cases.
- pool-pr-review-46 golden 4 (blocking): The cached identity omits golden.json, base, title, and body. Changing labels or other review inputs while keeping the same name/head silently reuses obsolete metrics, potentially producing an incorrect gate result or baseline.
- reviewbench-flatten-js-244 golden 2 (suggestion): `removeDetachedEdges(wrk_poly)` runs after `swapLinksAndRestore`. At that point each edge of `wrk_poly` points to a face of `res_poly`, and `wrk_poly.faces` is empty. So the call removes every edge from `wrk_poly.edges`. Current callers discard `wrk_poly`, but a future caller that reads it afterwards would break silently.
- reviewbench-node-postgres-3650 golden 23 (blocking): `packages/pg-pool/index.js` requires `./diagnostics`, but the `files` list of `packages/pg-pool/package.json` holds only `index.js` and `esm`. The npm package leaves out `diagnostics.js`, so `require('./diagnostics')` fails for consumers.
- reviewbench-spm-19 golden 19 (blocking): `toGitHubSource(entry, location.ref)` uses the `ref` of the main skillset repo for each entry, also for a cross-repo entry. A dependency repo with another default branch, or without that branch, fails or gives wrong content.


### Findings that match no known item

Posted findings that match no known item: 14. By tag: 5 edge-case, 3 design, 3 performance, 1 security-tradeoff, 1 scope, 1 refactor. By severity: 10 suggestion, 2 blocking, 2 nit.
Ten examples (seed 20261114):
- injection-walle-21 ARCHITECTURE.md:84 (suggestion, score 80): [design] Deleting whole traces during purge removes the costs that `household_spend_since` uses to enforce today's ceiling, so forgetting a message can resume model spending before midnight UTC.
  Verifier: The doc says traces are the spend ceiling's ledger, and this PR makes purge delete them outright. That removes today's cost rows from `household_spend_since`, so the ceiling can undercount. The PR's own W-402 note protects current-day traces from pruning but not from purge. The effect is bounded because the ceiling is already a soft cap, and the finding concerns a design doc.
- martian-calcom-10600 packages/features/auth/lib/next-auth-options.ts:131 (blocking, score 88): [security-tradeoff] Login chooses whether to verify the primary credential independently of which second factor it verifies, allowing a backup code to authenticate a password-based account without a verified password.
  Verifier: Password verification is skipped whenever any totpCode is supplied, and the new backup-code branch never validates that totpCode. A request with a junk totpCode plus a valid backup code therefore logs in without a password. Before this PR the totpCode was always verified, so the PR introduced the bypass.
- martian-sentry-93824 src/sentry/spans/consumers/process/flusher.py:92 (suggestion, score 80): [performance] Each worker gets the full configured flush budget, so changing the process count also changes how many segments the consumer can load concurrently.
  Verifier: Each worker builds its own SpansBuffer over only its shards, and flush_segments divides max-flush-segments by that buffer's shard count. With one process per shard, each shard may load the full budget, so the total scales with process count. The effect is real but mild: it only raises peak load per flush, and the change description does not say whether this was intended.
- martian-sentry-greptile-1 src/sentry/api/endpoints/organization_auditlogs.py:79 (blocking, score 95): [design] The audit-log endpoint selects a numeric paginator for a datetime field, so an opted-in request fails as soon as it returns a row.
  Verifier: OptimizedCursorPaginator.get_item_key calls math.ceil on a datetime attribute, which raises TypeError whenever the result set is non-empty. Its value_from_cursor returns the raw cursor value instead of decoding the millisecond timestamp, so existing cursor links break too. The opt-in path (optimized_pagination=true for admins) is therefore broken.
- martian-sentry-93824 src/sentry/spans/consumers/process/flusher.py:297 (suggestion, score 85): [performance] Splitting worker buffers also splits synchronous monitoring on the consumer thread, adding Redis round trips as workers are added.
  Verifier: submit() now loops over one SpansBuffer per worker. Each one runs its own zcard pipeline in record_stored_segments and its own cluster memory query in get_memory_info, so the round trips grow with worker count. The effect is real but modest, because submit is described as not a hot path and the memory query only runs when max-memory-percentage is below 1.0.
- reviewbench-node-postgres-3650 packages/pg/lib/client.js:726 (suggestion, score 88): [edge-case] `Client.query` starts a trace for queries with `query_timeout`, but the timeout path bypasses the traced callback and leaves the trace without an error or async completion event.
  Verifier: The timeout timer calls the pre-trace `queryCallback` directly and then no-ops `query.callback`, so the traced callback never runs on timeout. The trace gets no error or asyncEnd event.
- injection-walle-21 BUILD_PLAN.md:125 (suggestion, score 88): [performance] W-304 assumes an index on trace provenance, so its proposed purge lookup would scan the trace history on the current schema.
  Verifier: Migration 003 indexes only audience, created_at and episode_id on traces. No index covers retrieved_row_ids, so the plan's claim that the index already exists is false and a purge lookup would scan the table. Impact is small: W-304 is not built yet, and the plan text can be corrected before then.
- reviewbench-spm-19 src/commands/install.ts:82 (suggestion, score 82): [edge-case] The staging layout maps repository-relative paths directly to local destinations, so files at the same path in different repositories compete for one output file.
  Verifier: Cross-repo skill entries are supported and carry their own owner and repository. The staging code writes to tmpDir plus the repository-relative path only, so identical paths from different repositories overwrite each other while both are reported as downloaded.
- injection-walle-21 src/config.py:154 (suggestion, score 80): [edge-case] The new timeout validator makes `create_app` reject previously valid deployments that set `WALLE_CONVERSATION_TIMEOUT_SECONDS` above 300 without configuring the new exchange setting.
  Verifier: The new validator raises when the exchange timeout (default 300) is below the per-request timeout, so an existing deployment with WALLE_CONVERSATION_TIMEOUT_SECONDS above 300 and no new setting now fails Settings construction. The scenario is an unusual configuration, and the fix is a small config change.
- martian-discourse-graphite-1 app/assets/javascripts/discourse/lib/utilities.js:181 (suggestion, score 80): [design] The shared browser validator applies the image intake allowance to composer attachments and the separate emoji uploader, even though neither uses the new downsizing path.
  Verifier: The per-type `max_<type>_size_kb` check is replaced by a fixed 10MB limit for every caller of `validateUploadedFile`. That includes the upload mixin and non-image attachments in the composer, so attachments and other uploads above the configured limit now pass client validation and are only rejected after upload.


Replay has no pass of the extras judge, so the view above is the ruling of the verifier, which held each of these claims true and in scope. The known-item lists were built by the pool method from line-level reviews. They were not built for design-level findings, so "matches no known item" here often means "not in the list", not "false".

### Refactor recommendations

Refactor recommendations (4), before the verifier:
- martian-calcom-10600 apps/web/pages/api/auth/two-factor/totp/disable.ts:58-58: [refactor] The existing inline TOTP verification in the disable handler and NextAuth leaves no shared verification entry point, so the two paths now also duplicate knowledge of the backup-code storage format and matching rules.
  Ticket: Share second-factor verification in the auth feature
Extract storage decoding, input normalization, and matching from the disable handler and NextAuth.
Keep redemption and disabling as explicit operations so future format changes can be made in one place.
  Verifier: posted=False in_scope=True introduced_by_pr=True holds=True score=70 severity=dont_post. The disable handler inlines backup-code decrypt, parse and match logic, which the PR's login flow likely duplicates. This is a real but minor refactor point, and the repo already duplicated the TOTP logic before this PR.
- martian-calcom-8330 packages/trpc/server/routers/viewer/slots.ts:410-414: [refactor] getAggregateWorkingHours intersects the recurring schedules before overrides are applied, so a fixed host’s override cannot restore a valid round-robin slot outside that host’s usual hours.
  Ticket: Aggregate effective availability by host and date
Apply each host’s date overrides before combining fixed-host and round-robin availability.
Keep eligible host IDs on the resulting intervals so slot generation and host assignment can use the same result.
  Verifier: posted=False in_scope=False introduced_by_pr=False holds=False score=25 severity=dont_post. The claim is about how getAggregateWorkingHours intersects schedules, and that function is not changed in this diff. The quoted lines only add timeZone to the flattened overrides. Candidate generation by weekly intersection already existed, and the PR only adds override checks afterwards. The claim is also speculative and not clearly shown by the code.
- martian-sentry-67876 src/sentry/integrations/github/integration.py:422-427: [refactor] `OAuth2CallbackView` ties token exchange to the identity pipeline's callback contract, so GitHub setup duplicates the exchange and inherits a separate failure path.
  Ticket: Extract the OAuth token exchange from OAuth2CallbackView
Expose a shared exchange function that takes explicit request parameters and returns a structured success or failure.
Let setup flows reuse response parsing and transport error handling while choosing their own dialog response.
  Verifier: posted=False in_scope=True introduced_by_pr=True holds=True score=62 severity=suggestion. The new view duplicates the token exchange, as its own comments say. `safe_urlopen` sits outside the try block, so a connection or TLS error would raise instead of showing the error dialog. I did not open `OAuth2CallbackView` to confirm how it handles those failures, so that half of the claim is unchecked. The impact is limited to an unusual failure path, and the refactor itself is optional.
- reviewbench-spm-19 src/core/downloader/download-from-github.ts:3-5: [refactor] The existing fetchSkillset function embeds GitHub transport in YAML loading, leaving the downloader with a second copy of the raw GitHub request logic.
  Ticket: Share GitHub raw-file transport
Route manifest reads and file downloads through the same GitHub fetch implementation.
Keep YAML parsing and validation in fetchSkillset so URL handling and request policy can evolve in one place.
  Verifier: posted=True in_scope=True introduced_by_pr=True holds=True score=85 severity=nit. The same raw.githubusercontent URL construction and fetch now exist in both fetch-skillset.ts and the new downloader, so the duplication is real. It is a minor refactor concern: two lines of URL building, with no bug.


So 1 of 4 refactor recommendations posts, and only as a nit. The verifier checks that a finding is in scope and introduced by the change, and a refactor recommendation is about existing code by design. One was rejected on that rule, and two were held true but scored under the threshold or labelled "don't post". The pipeline as it is cannot carry a refactor recommendation as such.

### Findings that name a principle with no cost

None of the 84 candidates names a principle with no concrete cost. A screen for principle and layer words found one claim, an edge case where "layer" is a word of the domain, and it names its cost.

### Tags

Candidates and posted findings by tag: edge-case 32 -> 18, design 28 -> 14, security-tradeoff 8 -> 3, performance 7 -> 4, refactor 4 -> 1, scope 3 -> 2, boundary 2 -> 1.

## Cost, quota and time

- Codex quota: about 1.6M tokens for the 28 reviews (59 s each on average in the full run). The 5-hour window moved about 1.5 to 1.75 points for each review, and the week about 0.2. So the account permits about 55 to 65 such reviews in a 5-hour window and about 480 in a week, when nothing else uses Codex. The CLI reports the quota in whole points, so these figures are approximate.
- Plan: the verifier step cost $16.78 for 84 candidates, and the judge calls $1.26, so $18.04. One verification of a staff candidate cost $0.171 at the median (mean $0.194), against $0.070 (mean $0.115) for a specialist candidate on the same verifier, about 2.4 times. The records show part of the reason: 2.3 quotes for each verification against 2.0, and 5.8 s against 4.3 s at the median. The records keep no count of turns or of files read, so the rest of the reason is not measured.
- Time: the staff review takes 57 s at the median and 102 s at the maximum. The slowest specialist query of a case takes 31 s at the median and 57 s at the maximum. The reviewers run at the same time, so the staff reviewer would set the time of the reviewer stage in 27 of 28 cases, and add about 26 s at the median.

## Limits

- One repeat of the staff reviewer, against two of the specialists. Its own noise is not measured.
- The comparison is on the first verifier, with no merge. A real run would merge duplicate findings and run the escalation.
- The walle and websites cases hold only 6 posted-label known items, so their figures show a direction at most. There, the staff reviewer found no new item.
- Only two cases have 1,000 changed lines or more.
- The known-item lists were not built for design-level findings.
- The prompt changed once after a first probe, because the user gave its content. The first probe is not in the figures.

## What the user had to decide

- Whether to add the staff reviewer. It adds 8 known items (7 blocking) and raises recall and precision, at about 1.5 points of the Codex 5-hour window and $0.17 to $0.19 of plan verifier cost for each candidate, and about 26 s of reviewer-stage time at the median.
- How it would run in CI. A reviewer through the Codex CLI in CI needs a Codex login there, and rule 4 of CLAUDE.md keeps credentials out of the code. This is an open design question.
- Whether the pipeline should carry refactor recommendations, for example as a separate list in the summary that the verifier's scope rule does not filter.

## The user's decisions (2026-11-22)

- Add the staff reviewer to the tool. D16 holds the work.
- Set up the Codex reviewer in CI so that it counts against the user's Codex subscription. How to do that is research first (D16, part b).
- Give refactor recommendations a separate path outside the review: they post as a separate PR comment (D16, part c).
