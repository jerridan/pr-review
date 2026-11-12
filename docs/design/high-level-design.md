# PR review tool: high-level design (first pass)

Status: draft for discussion, revised 2026-10-13 after first review. Builds on `docs/research/`.

## 1. Goals and constraints

- Review pull requests in all of the user's repos, in CI and locally, with one tool.
- Many small specialist reviewers run in parallel. This choice is settled.
- A repo can add its own reviewers and rules without changes to the tool.
- Low noise is the first quality target. A finding that is wrong costs more than a finding that is missed.
- The review covers only what the PR adds, changes or aggravates. Pre-existing issues are out of scope.
- Very small or trivial PRs take a cheaper path.
- Claude models only, for now. The one exception is the judge of the eval's severity labeler: it runs on a GPT model through the Codex CLI, outside the run pipeline (section 8).
- Every run writes a record that the evaluation harness can replay.

Non-goals for v1: auto-fix commits, chat with the reviewer in PR threads, multi-provider support.

## 2. Shape of the system

Two layers:

1. **Orchestrator** (code, deterministic). Collects inputs, routes, selects reviewers, runs the stages below, merges, posts, records. No LLM decides control flow here.
2. **Agents** (markdown definitions, one file per agent). Reviewers, the verifier, the triage agent, the summarizer. Built-in agents ship with the tool. Custom reviewers live in the repo.

Recommended runtime: the Claude Agent SDK (TypeScript). The pipeline runs one SDK `query()` for each reviewer pass. It does not pass reviewers as programmatic subagents. The agent files use the Claude Code subagent frontmatter (`name`, `description`, `tools`, `model`) plus a small set of review-only fields. This gives the same files in three places: the CI run, the local CLI run, and interactive use inside Claude Code.

Alternative considered: a Claude Code slash command that spawns subagents through the Agent tool. Rejected for the main path because the merge, threshold, dedupe and post steps must be deterministic and testable. Kept as a thin `/review` command that calls the CLI.

## 3. Pipeline

```
 gather -> triage -> select -> find -> verify -> merge -> report -> record
   |        |         |         |        |         |        |
  code    Sonnet    code     Sonnet   Sonnet    code+    code    JSON
                             /Opus    /Opus     1 call
```

### 3.1 Gather (code)

- Base and head SHAs, three-dot diff, list of changed files with hunk counts.
- PR title, body, labels, author, draft flag, author permission level.
- Existing review threads posted by this tool, with their fingerprints and state.
- Repo config and custom reviewers, read from the **base branch** only (see section 6).
- Sanitize PR title and body: strip HTML comments and invisible characters, wrap in a data block.
- The description block. It holds the PR title and body when they are known. Otherwise it holds the subject and body of each commit in base..head, oldest first.
- The history block. It holds `git blame` and `git log` output at the merge base of base and head, limited to the old-side line ranges of each hunk and to files that exist on the merge base. It has a cap of 65536 bytes. The record notes a cut.

### 3.2 Triage (facts in code, then one Sonnet call)

Three tiers: `skip`, `fast`, `full`.

Code first computes what it can without judgment: renames and moves via git rename detection, generated and lockfile paths, per-file hunk counts, sensitive-path hits, and PR metadata. Moved files with no content change leave the diff here.

Then a triage agent always runs on the remaining diff and returns a brief:

- the tier with its reason
- which reviewer categories apply
- hotspots to focus on
- per-file notes such as pure refactor or mechanical rename
- a short summary of what the PR does

The brief goes to Select and to every reviewer as context. Size is not a signal on its own: a 3-line auth change is full, a 40-file mechanical rename is fast. Uncertainty routes to `full`, and a triage error routes to `full`. This follows Qodo's router, where diff size scored worse than no router, and Anthropic's plugin, which runs cheap gates and a summary before the finders.

Order of precedence:

1. Overrides: labels `review:full`, `review:fast`, `review:skip`, a maintainer comment `@pr-review full`, or `--tier` on the CLI.
2. Skip rules on metadata only: draft, title keyword, label, bot author, zero hunks after moves and generated paths are removed.
3. Sensitive globs (auth, crypto, payments, migrations, CI config, the tool's own config) set a floor of `full`. Triage can raise a tier, never lower it past this floor.
4. Triage decides everything else.

A sensitive path with no text hunks does not raise the tier. The record and the coverage line name it.

Tier effects:

| Tier | Reviewers | Verifier | Budget target |
|------|-----------|----------|---------------|
| skip | none, post a one-line note | no | ~0 |
| fast | diff-only bug scan, convention check, custom reviewers that opt in | yes | small |
| full | all matched built-in reviewers plus all matched custom reviewers | yes | normal |

The fast tier runs one pass of diff-bugs, conventions and custom reviewers with `min_tier: fast`, then the same verifier, merge and single review. The review body states the tier and the triage reason, for example "Fast review: mechanical rename across 40 files, no logic change", so a wrong call is visible. Each push re-triages on the cumulative PR diff. The triage result only moves up, never down, and an override above triage in the order of precedence still wins.

### 3.3 Select (code)

Each reviewer declares triggers in frontmatter: path globs, languages, categories from the triage brief, minimum tier. The orchestrator builds the run list from triggers. A reviewer with no triggers always runs in `full`.

### 3.4 Find (parallel reviewer agents)

Each reviewer gets: the triage brief, the description block, the list of changed files, the diff, the repo rules, read-only tools over the checkout, and a per-reviewer token budget. The history reviewer also gets the history block. A deleted file has its own line in the list, because the head checkout has no file to read. The diff shows which lines changed. It is not the only context. Each returns structured findings:

```
file, start_line, end_line, category, severity, claim,
evidence (code the reviewer read, quoted), suggested_fix, confidence
```

Reviewer prompts follow the 5.5 prompting guidance (see `docs/research/claude-5-5-models.md`): one evidence source per reviewer, and an instruction to report every issue in scope with a confidence and an estimated severity, because 5.x models over-filter when told to be conservative. All filtering happens in verify and merge. Scope is the only exclusion: not lint or formatting, and nothing on code the PR did not add, change or aggravate. No finding without quoted evidence, which the orchestrator checks is a substring of the diff or file. A one-line explanation per finding, never visible reasoning. Diff first, instructions last. PR text and diff in tagged untrusted blocks. A line that forbids launching subagents.

diff-bugs, history, tests and security each have a reading plan in numbered steps. Each plan starts with the changed files in full. These four reviewers find the serious defects of issue 20, so only they pay to read whole files. conventions, docs-and-comments and description-drift work from the diff and read files only when they need context. diff-bugs then reads the callers and callees of the changed code, then the tests that cover it. history matches the blame lines of prior fixes against the diff. tests lists each changed behaviour and finds the tests that cover it, also through the callers. security follows each outside input to its uses and reads the checks that guard each changed handler. The steps are concrete actions, not exhortations: the 5.5 guidance says a line such as "be thorough" adds nothing.

Each reviewer is one SDK `query()` with its own model, effort and output schema. Default is Opus 5.5 at low effort; see section 5. Findings come back as structured output validated against a schema. The orchestrator is code, so no LLM retypes a finding on the way to the record.

Built-in reviewers for v1, split by evidence source:

| Reviewer | Evidence | Tier |
|----------|----------|------|
| diff-bugs | the diff alone, logic and edge cases | fast |
| conventions | CLAUDE.md, rules file, nearby code style | fast |
| tests | changed behavior vs changed tests, silent failures | full |
| security | input handling, secrets, authz on changed paths | full |
| history | git blame and log on the changed lines, read by gather at the merge base and passed as a data block, prior fixes | full |
| description-drift | the description block, compared with what the code does | full |
| docs-and-comments | stale comments and docs touched by the change | full |

The history reviewer has no Bash. Gather reads the blame and log, not the reviewer. The history reviewer quotes its evidence from the head file or the diff, never from the blame block. So a history finding states a claim that the head file shows.

Gather also builds the git facts of each changed file: the blame and log of its changed lines at the merge base, cut at a line end to fit 16384 bytes. Gather builds them for every run that verifies findings, also when the history reviewer is off. The verifier gets the description block and the git facts of its finding's file. It does not get the joined history block, and it does not get the facts of another file. The verifier has no Bash either.

### 3.5 Verify (one Sonnet call per finding)

Each finding goes to a verifier with the finding, the head file, the description block, the git facts of the finding's file, and the diff of that file against the merge base. A head file of 600 lines or fewer goes in whole. A longer file shows only the window of 150 lines on each side of the finding's span, under a line that names the lines shown. The verifier uses Read for the rest. The quote check still runs against the whole head file.

The rubric asks one question for the score: is the claim true of the code as written? The score is the confidence, from 0 to 100, that the claim holds. Scope, worth and severity do not change the score. The verifier also answers whether the change introduced the problem, and whether the finding is in scope. Scope is the only exclusion. Suppressions apply at merge, not here.

The verifier gives one of the six labels of the severity policy (`severity-policy.md`). A finding posts only when its final result has a claim that holds, is in scope, has a score at or above the threshold, has a quote in the head file, and has the label blocking, suggestion or nit. One rule decides the outcome of the final result, in this order:

1. The label unsure gives the unsure result, whatever the claim says.
2. A claim that does not hold is rejected.
3. A claim that holds with the label not real contradicts itself. It is rejected, and the record names the contradiction. It does not make the review incomplete.
4. A claim that holds with the label don't post does not post. The record shows the label.
5. Then the scope, threshold and quote checks apply.

When the first and the escalated result both say that the claim holds, the finding posts although the escalated score is below the threshold. The scope and quote checks still apply.

The unsure result is for a claim that the repository cannot settle. A verifier call that stops on its budget or turn limit also gives unsure, with the cause "limit". A limit stop on the first call does not escalate. A limit stop is not a failed verifier call, so it alone does not make the review incomplete. An unsure finding never posts. The record marks the entry unsure with its cause. Explain, the eval drop counts and the coverage block count unsure findings apart from rejected findings and from failed verifier calls.

Scope is a gate before the score: a finding on code the PR did not add, change or aggravate fails verification whatever its score, and is tagged pre-existing in the record. Findings under the threshold are dropped but kept in the record. Default threshold 80, configurable per repo and per reviewer. The effective threshold of a reviewer is `reviewers.<name>.threshold` from the repo config when set. Otherwise it is the higher of the frontmatter value and `thresholds.default`. The verifier gets the description block for every finding, so it can check a description-drift claim. It never sees which reviewer produced the finding. It gets the git facts of its finding's file only, as section 3.4 says.

Verification starts per finding as soon as its reviewer returns. Merge is the only barrier, so the slowest reviewer delays only its own findings. The verifier runs on Sonnet 5.5 at high effort with thinking on, a different model from the finders, as Anthropic's evaluation guidance recommends. It has the head file, or the window of a long head file, in context and read-only tools to find its own supporting quotes, and must retract a finding it cannot quote. It escalates to Opus 5.5 at high when the reviewer marks a finding `needs_context: true` or when the score lands in a middle band, following Anthropic's two-pass pattern. The band is `thresholds.middle_band` from the repo config, with the default 60 to 85. It is a fixed score range. It does not move when a reviewer threshold changes. The band's upper bound must be at least `thresholds.default`, and no reviewer threshold may be above it, or a score above the band and below the threshold could never escalate and never pass; the config loader rejects such a config. The verifier also assigns severity, because reviewers rate their own findings too high. Merge may downgrade a severity when it sees the full set, never upgrade.

| Severity | Test | Posts on later runs |
|----------|------|---------------------|
| blocking | would cause an incident or a real bug if merged | yes |
| suggestion | makes the change safer or clearer, no bug today | first run only |
| nit | style, naming, wording not caught by a linter | first run only, if at all |

### 3.6 Merge (code, then one call for semantic dedupe)

1. Fingerprint each finding: file, normalized code span, category.
2. Drop findings that match an open or dismissed thread from a previous run.
3. Apply repo suppressions by category, path and reviewer. This happens before the groups form. The run checks each finding with the name of its own reviewer, and the record keeps each removed finding with its rule.
4. Group by file and overlapping lines. One Sonnet call merges groups that say the same thing and picks the best wording.
5. Rank by severity then verifier score. No cap on blocking findings. Non-blocking findings are capped per run at `3 + ceil(hunks / 4)`, at most 20, suggestions filled before nits. A 4-hunk PR gets 4, a 20-hunk PR gets 8. Overflow goes in the summary as a list. This is a starting formula for the harness to tune.

### 3.7 Report

GitHub: one review per run, posted the way a human posts one.

- A short body and inline comments on the diff lines they refer to. The review event is always `COMMENT`, never approve or request changes.
- The body states the verdict the tool would give, "would approve" or "would request changes", with the counts behind it.
- A finding on a line outside the diff goes in the body with a full-SHA permalink.
- A neutral check run carries the same counts and a severity line in its text.
- A later run posts a new review scoped to what changed, as a human would, and resolves threads that no longer hold.
- Hidden markers carry the run state. The review body holds `run`, `head`, `base` and `tier`. Each finding, inline or in the body, holds its fingerprint. A later run reads markers only from reviews by the login of the tool.
- At the skip tier on a first run, the review is one line with the marker and the tier reason. The run posts it once for each reason.
- The run records a failed check run, cleanup comment, thread resolve or reply. The exit code stays 0. When the review itself cannot post, the run exits with code 1.
- Fork PRs: see section 6.
- Failures are visible. The review always posts, and its body carries a coverage line: reviewers that ran, reviewers that failed, findings dropped because a verifier call failed. A `refusal` stop from the safety classifiers, which a security reviewer can trigger, counts as a reviewer failure. A run that dies before posting still posts a short review that says so. Unverified findings are never posted.
- Pre-existing issues never appear in the review and never affect the verdict. A repo can set `pre_existing: comment` to have verified pre-existing issues posted as one separate issue comment titled cleanup opportunities. The default is off.

Local:

- Terminal table by default, `--format json` and `--format markdown` for other uses.
- Same pipeline and same record, so a local run is a valid eval sample.

### 3.8 Record

One JSON file per run, in four parts:

- **Identity and inputs**: repo, PR, base and head SHAs, timestamp, tool version, config hash, changed files with hunk counts, the triage brief, reviewers selected with the trigger that picked each, model per role.
- **Raw stage outputs**: every finding each reviewer returned per pass, every verifier call with score, severity and scope gate result, every merge decision (dedupe groups, downgrades, suppressions, cap overflow, prior-thread matches).
- **What was posted**: review body, verdict, inline comments with fingerprints.
- **Cost and health**: `modelUsage` from every query (tokens, cache reads, estimated cost per model), wall time per stage and per agent, every error with its stage, every `refusal` or `max_tokens` stop.

The workflow uploads the record as an artifact and pushes it to a `pr-review-records` branch, so it outlives artifact retention. The push needs `contents: write` on the job token. With `--pr`, the record goes in a `pr-<n>` directory.

Uses:

- The harness replays recorded inputs against a new version, so every real PR is a regression case.
- Per-reviewer precision over time drives suppression suggestions and shows which reviewer to cut.
- `explain` reads a record to show why a finding was kept or dropped.
- Later runs read two sources. GitHub gives the thread state and the posted fingerprints. The previous record gives the last reviewed head and the full finding of each open thread. When no record exists, the run takes the head from the newest review marker of the tool and resolves no thread.

### 3.9 First run and later runs

The first run casts a wide net. Wide means more passes over the PR's own changes, not a wider scope. Every run reviews only what the PR adds, changes or aggravates. Later runs look only at what changed since the last review and only for blocking problems, so the cycle converges.

**First run.** A reviewer with `passes: N` in its frontmatter runs N times with the same inputs. The union of findings goes to the verifier, then fingerprint and semantic dedupe collapse the repeats. Defaults: 2 passes for diff-bugs and security, 1 elsewhere. The fast tier runs one pass of every selected reviewer. Five runs of one model on SWR-Bench agreed on only 27 golden hits, so repeats raise recall more than any prompt change.

**Later runs** (a new push on a PR this tool has reviewed):

- Scope is the new hunks. The run diffs from the merge base to the new head, and from the merge base of the last reviewed head to that head. A hunk is new when no hunk of the old diff has the same path and the same added and removed text. Only files with a new hunk reach the reviewers, and only new hunks are in the diff text. A rebase does not re-review the whole PR.
- Triage runs on the whole PR diff. The triage result is the higher of this run's triage tier and the triage tier of the prior record. Overrides, skip rules, the zero-hunk rule and the sensitive floor win over it.
- Severity floor is blocking. No new suggestions or nits. The record keeps them under `posted.below_floor`.
- A new finding whose fingerprint is open or dismissed never posts.
- Open threads are re-verified against the new head. The run compares the span text of the finding with the file at the new head. The run resolves a thread whose text is gone, with a reply that names the head.
- A finding in a review body has no thread. It stays open while its span text is present. It counts for the verdict. The run never resolves it.
- The run recomputes the verdict from all open blocking findings, not only new ones. Threads and body findings count.
- The last reviewed head must be in the local object store. When it is not, the run fetches it with git. When the fetch fails, the run becomes a fresh run and coverage says so.
- A push with no new hunk still re-verifies the open findings and resolves the stale threads. When a thread resolved or a body finding closed, the run posts one short review with the recomputed verdict, so a deletion-only fix is acknowledged. When nothing closed, it posts nothing and exits with code 0.

**Verdict rule.** Incomplete when any reviewer or stage failed. Would request changes when at least one blocking finding is open. Would approve otherwise. The rule is fixed so the verdict is explainable.

**Override.** A maintainer comment `@pr-review full` forces a fresh full run. The label `review:full` sets the tier floor to full. Only the `labeled` event that adds the label also forces a fresh run. A fresh run has full scope and posts every severity. It still never reposts an open or dismissed fingerprint. A `labeled` event for `review:fast` or `review:skip` on a head that has a review is a later run with no new hunk. It posts nothing.

## 4. Repo-side configuration

```
.pr-review/
  config.yaml        thresholds, per-reviewer and per-role overrides, suppressions, sensitive globs, skip rules, caps
  rules.md           short shared rules, injected into every reviewer
  reviewers/*.md     custom reviewer agents, same frontmatter as built-ins
```

Two mechanisms on purpose:

- `rules.md` is for cheap team knowledge that every reviewer should know. Keep it short. Research says a long rules file dilutes the rules.
- `reviewers/*.md` is for a focused reviewer with its own evidence source, tools and do-not-flag list. One file, one agent.

Custom reviewer frontmatter example:

```yaml
---
name: migration-safety
description: Checks Alembic migrations for locks and irreversible steps
model: sonnet
tools: [Read, Grep, Glob]
triggers:
  paths: ["alembic/versions/**"]
  min_tier: fast
threshold: 85
---
```

A custom reviewer can also override `threshold` to be stricter, never looser than the repo floor.

`config.yaml` has a strict schema. An unknown key is an error. A file that does not parse or validate stops the run before any model call, and the run writes no record. The keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `thresholds.default` | 80 | The floor for every reviewer threshold. |
| `thresholds.middle_band` | `[60, 85]` | The score range that sends a finding to verifier escalation. |
| `reviewers.<name>.enabled` | `true` | Whether the reviewer may run. |
| `reviewers.<name>.passes` | the frontmatter value | The number of passes of the reviewer. |
| `reviewers.<name>.threshold` | the frontmatter value, raised to `thresholds.default` | The threshold of the reviewer. A value below `thresholds.default` is an error. |
| `reviewers.<name>.model` | `models.reviewer.model`, else the frontmatter value, else the role default | The model of one reviewer. This key pins that reviewer. |
| `reviewers.<name>.effort` | `models.reviewer.effort`, else the frontmatter value, else the role default | The effort of one reviewer. This key pins that reviewer. |
| `models.<role>` | the table in section 5 | The model and effort of one role: triage, reviewer, verifier, verifier-escalation or merge. |
| `suppressions` | empty | Rules that remove a verified finding. See below. |
| `sensitive_globs` | empty | Globs added to the default sensitive globs. |
| `generated_globs` | empty | Globs added to the default generated globs. |
| `skip.draft`, `skip.title_keywords`, `skip.labels`, `skip.bot_authors` | off, empty | The skip rules of section 3.2. |
| `caps.non_blocking_base`, `caps.non_blocking_per_hunks`, `caps.non_blocking_max` | 3, 4, 20 | The cap formula of section 3.6. |
| `pre_existing` | `off` | `off` or `comment`, as in section 3.7. |
| `concurrency` | 5 | The number of model queries that run at the same time. |
| `token_ceiling` | none | The most tokens the run may use. |

`<name>` is a built-in or a custom reviewer. Any other name is an error.

- **Model and effort.** The order is `reviewers.<name>`, then `models.<role>`, then the frontmatter value when it is set, then the role default of section 5. For a reviewer, the role is `models.reviewer`. The frontmatter fields `model` and `effort` are optional. No built-in reviewer sets them, so each built-in reviewer takes the role default. A custom reviewer can set either field as the default for that one reviewer. Model and effort resolve apart. A `models.<role>` object can give either one or both. The result is fixed for the run.
- **Suppressions.** Each item has `reviewer`, `category`, `path` and `reason`. It needs `reason` and at least one other key. A finding matches an item when it matches every key the item gives. The run applies suppressions to verified findings before the merge groups form. It checks each finding with the name of its own reviewer.
- **Config hash.** The record field `config_hash` is the SHA-256 of the loaded `.pr-review/` files. Each entry is the path, one newline, and the file bytes. The run sorts the entries by the UTF-8 bytes of the path and joins them with one NUL byte. CLAUDE.md is not an entry. The hash is `null` when the base commit has no `.pr-review/` file.
- **Bash for a custom reviewer.** The run grants Bash only when the reviewer sets `trusted: true` and the run knows that the PR author has write access. The CLI option `--author-write-access` carries that fact. A built-in reviewer never gets Bash, whatever `trusted` says. When a custom reviewer asks for Bash and does not get it, it runs with read-only tools, and the coverage line names it with the reason.

## 5. Models and budget

| Role | Default model | Effort | Reason |
|------|---------------|--------|--------|
| triage | Sonnet 5.5 | medium, thinking on | judgment on risk from one read of the diff; failure falls back to full |
| reviewers | Opus 5.5 | low | half the old price gap; best published bug-catch rates at low effort; Sonnet 5.5 medium is the first harness comparison |
| verifier | Sonnet 5.5, Opus 5.5 on escalation | high, thinking on | a different model from the finders; escalation on `needs_context` or a middle-band score |
| semantic merge | Sonnet 5.5 | medium | needs judgment on wording |
| summarizer | Haiku 5.5 | medium, thinking on | formatting only; low effort leaks reasoning text |

Effort and output schema stay fixed per role within a run, because changing either invalidates the prompt cache. Haiku 5.5 is not used as a verifier or reviewer: its system card reports the highest over-refusal rate of any tested model and work reported done without checking at low and medium effort.

A repo can override the model and effort of any role with `models.<role>`, and of one reviewer with `reviewers.<name>`. Section 4 gives the order. A run-level token ceiling stops new reviewer launches when reached and notes it in the summary. Each SDK query is its own Claude Code process of about 1 GiB, and a standard GitHub runner has 7 GiB, so the orchestrator runs at most 5 queries at once by default. Unattended runs set `CLAUDE_CODE_RETRY_WATCHDOG=1` so rate-limit responses retry without a cap.

### 5.1 Model versions

Config pins exact model IDs, defaulting to the 5.5 family: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. A model change is a config diff the harness can measure, never a silent upgrade.

The role assignments above come from `docs/research/claude-5-5-models.md` and are hypotheses until the harness confirms them. Anthropic's advice is that effort is a better lever than model choice, so the first harness experiments are:

- Reviewers: Opus 5.5 at low against Sonnet 5.5 at medium, on cost per confirmed finding.
- One Opus 5.5 reviewer at medium effort over the whole diff, as a baseline against the specialist set. Anthropic found a single model in one context beat a lead-with-workers setup when the work fit.
- Verifier: Sonnet 5.5 at high against Opus 5.5 at high, and the 0 to 100 score against a 5-band scale.

Prompts follow Anthropic's current prompting guidance for the 5.5 family, summarized in the research doc, not patterns learned on older models.

## 6. Trust model

- All configuration and all agent files load from the base branch. PR versions are ignored and the diff of `.pr-review/` is itself reviewed by the security reviewer.
- The PR head checks out into a separate directory. Reviewers read it as data. Every SDK query runs with `settingSources: []`, so no hooks, MCP servers, agents or CLAUDE.md load from the checkout. The orchestrator injects CLAUDE.md and the rules file from the base branch itself.
- Built-in and custom reviewers get read-only tools by default: Read, Grep and Glob. Bash, Write and Edit go in `disallowedTools`, which removes them from the request, and `permissionMode` is set explicitly to `dontAsk`. The auto-approve list alone does not restrict, and an omitted mode can start in auto.
- A custom reviewer may request `Bash`. The orchestrator grants it only when the PR author has write access to the repo and the reviewer sets `trusted: true`. Otherwise the reviewer runs without Bash and the summary says so.
- Fork PRs: no automatic run. A `pull_request` event from a fork has a read-only token and no secrets, so the reusable workflow skips it. A maintainer adds the label `review:full` or `review:fast`. GitHub lets only a user with triage permission or more add a label, so the label permission is the gate; the event carries no association for the labeler. The `pull_request_target` event for that label runs the fork PR. The comment `@pr-review full` from the same class of user is the second path; it runs fresh at the full tier. The run checks out the fork head and executes no code from it. The CLI reads git objects. It runs no script, hook or build of the repo under review. The consumer must not add a step that builds or tests the fork head in the same job. A fork run grants Bash to no custom reviewer, whatever the permission level of the author. The checkout keeps no token: `persist-credentials: false`, and the fetch and push steps get the job token through the `gh` credential helper from their own env. The other tool rules above hold as for any other run.
- The PR title and body are untrusted data in every prompt.
- Secrets: the Claude token is the only secret in the job. The GitHub token has `pull-requests: write`, `checks: write` and `contents: write`. The job needs `contents: write` to push the `pr-review-records` branch.

## 7. Idempotency and feedback

- A finding fingerprint is stable across pushes when the code span is unchanged.
- A thread resolved by a human, or a 👎 reaction on the bot comment, marks the fingerprint dismissed for that PR. Dismissed fingerprints never repost.
- Repeated dismissals of the same category and reviewer across a repo feed a per-repo suppression suggestion, written to the record and shown in the summary. The tool does not change config on its own.

## 8. Evaluation harness

- Golden set: start with 20 to 50 cases from the user's own repos, taken from real misses and real false positives, plus a ReviewBench subset for breadth. Each case is a frozen checkout, a diff and a list of golden findings with severity and category. A golden carries one of the six labels of `severity-policy.md`. A golden with blocking, suggestion or nit is a posted golden. A golden with don't post, not real or unsure is a not-real golden.
- Contract: the harness runs the same CLI with `--format json` against the frozen checkout, no network.
- Scoring: match each finding to a golden item by file and span. One judge call, with thinking on and on a different model from the reviewers under test, only for pairs that overlap but do not match exactly. No holistic score.
- Metrics: grounded recall on posted goldens only, and two precisions on posted findings. Strict precision counts the matches only. Adjudicated precision also counts the posted findings with no golden that the extras judge accepts as real defects under the severity policy. The accepted extras go to `candidates.json` for a person to review, and `golden.json` does not change. A posted finding that matches a not-real golden is a false positive. Raw recall scores the reviewer findings before the verifier, the merge and the cap, so the gap to recall shows what the pipeline dropped. Without `--raw-judge`, raw recall sends no judge query: it takes exact matches and the judge answers that the posted pass already got. The drop counts give the dropped findings by stage, from the rows of `pr-review explain`. Also findings per PR, and the cost per PR of the review run and of the judge. Report the spread over the repeats of a run. The Gate bullet below gives the number of repeats. The eval pools the precision of a repeat over the cases: the matched posted findings divided by all posted findings.
- Gate: a change that touches behaviour runs the eval locally at one repeat against `eval/baseline.json`, and the PR description carries the table. A new baseline runs at two repeats, so the margins rest on a measured spread. To cut noise, the set grows before the repeat count does: with ten cases, one case moved precision by 0.1 between two runs of nearly the same code. The eval job in CI runs on manual dispatch only. The gate fails when recall or precision drops past the margin of the baseline. One contributor works on the repo, so the eval does not run on every PR; a run over ten cases costs about $40 at one repeat.
- Online: track addressed rate by re-running the verifier on the next push, and reaction counts. Compare to offline before trusting offline alone.
- With few cases: record every run from day one, local runs included, so the set grows on its own. Seed the first set three ways: ReviewBench and Martian cases for breadth, bug injection into merged PRs of the user's own repos for known-answer recall, and findings dismissed or acted on in real runs for precision. Synthetic cases overstate absolute scores, so use the harness for regression between two versions, not for an absolute number, until the real set reaches about 30 cases.

A pooled golden set gives the goldens of a case from the user's own repos. `pr-review pool` builds it in six steps. First, blind reviews: two reviews by `claude-opus-5-5` and two by `gpt-6.1-sol` through the Codex CLI. Each sees the diff, the changed files, the PR title and body, and the checkout. No review sees a PR comment, a record, a golden or another review. Second, every reviewer finding of the PR's records joins the pool. Third, the grouping: identical findings join in code, then one `claude-sonnet-5-5` call groups the findings that state the same defect at the same place. Fourth, the anonymised pool: `pool.json` holds the six fields of each item, in hash order, with no source, model, severity or score. `pool-key.json` keeps the sources apart. Fifth, one Claude adjudication and one GPT adjudication score each item from 0 to 100: is the claim true at the case head, and does the defect belong to this PR? An item is kept only when both families score it 75 or more. A failed call keeps the item out. Sixth, each kept item writes one golden with the severity `unsure`, and kept items with overlapping spans go through the grouping once more, so one defect gives one golden. A case with no kept item is a clean case with an empty golden list. `pr-review label` then sets the severity of each golden. `pr-review adjudicate` runs the fifth step on one finding. The pool code lives in `src/eval/pool/`, and nothing in the run pipeline imports it.

Dismissed findings are a second source of goldens beside the pool. The verifier dismisses a finding with `passed: false` and a final severity of `dont_post` or `not_real`, and the record keeps it in `stages.verifications[]`. `pr-review pool --dismissed` uses these records. A dismissed finding counts only when `identity.head` of its record equals the head of the case. The pool marks the pool members that match a counted dismissed finding on the six fields, in `pool-key.json` only. So no adjudication request holds the verifier's label or reason, and the two families judge the claim as for any other item. An item with a marked member then has one of three outcomes. Both scores are 75 or more: the item is kept and writes a pool golden. Its note names the record and the label, and the labeler decides between `dont_post` and a posted label. Both scores are below 50 with no failed call, where 50 is the limit that the adjudication prompt gives for a false claim or for a defect outside the PR: the item is a `dismissed_golden`. It writes a golden with the placeholder severity `unsure`, and the labeler is expected to set `not_real`. Any other result writes no golden, because the families do not agree. A `dismissed_golden` item stays out of the join of kept items, because its claim is false. A posted finding that matches such a golden is a false positive in the eval. No new model call and no new prompt serve this path.

The labeler sets the severity of the golden findings with its own models. The scorer is `claude-opus-5-5` in the `labeler` role, and the judge is `gpt-6.1-sol` through the Codex CLI. These pins are apart from the pins of the pipeline roles. A change to a pipeline model does not change them, so the gold does not change when the pipeline's models change. The judge runs only in `src/eval/label/`, and nothing in the run pipeline imports it.

## 9. Interfaces

```
pr-review run   [--base <sha>] [--head <sha>] [--pr <n>] [--github-repo <owner/repo>] [--fresh] [--tier full|fast|skip] [--format github|json|table|md]
pr-review eval  --cases <dir> [--repeat <n>] [--baseline <file>] [--write-baseline] [--out <dir>] [--format table|json] [--tier full|fast|skip] [--judge-model <id>] [--allow-api-key] [--allow-same-judge] [--no-extras] [--raw-judge]
pr-review label --cases <dir> [--runs <n>] [--concurrency <n>] [--write-golden] [--only <case>] [--out <dir>] [--format table|json] [--allow-api-key]
pr-review pool  <case-dir>... --out <dir> [--record <path>]... [--reviews <n>] [--write-golden] [--dismissed] [--resume]
pr-review adjudicate <case-dir> (--record <path> --fingerprint <fp> | --finding <path>) [--out <path>]
pr-review list  (reviewers that would run, with the trigger that selected them)
pr-review explain <record.json> [--format table|json]   (why each finding was kept or dropped)
```

The `eval` and `explain` lines show the flags as built in D4a. `eval` defaults to `--repeat 3`, `--out pr-review-eval`, `--format table`, `--tier full` and the judge role model. `explain` defaults to `--format table`. Both exit 2 on a usage error. `eval` exits 1 for a failed repeat and 3 for a failed gate.

A GitHub Action wraps `run`. A Claude Code `/review` command wraps `run` for local use. Without `--pr`, `--base` and `--head` are required. `--format github` needs `--pr`.

### 9.1 Auth

Local and CI runs both use the user's Claude subscription.

- Run `claude setup-token` once to mint a one-year token. Store it as the `CLAUDE_CODE_OAUTH_TOKEN` secret in GitHub and pass it to the job as an environment variable. Locally the CLI uses the saved login or the same variable.
- The Agent SDK runs the Claude Code binary, which reads this variable. The docs state this for `-p` mode and list the SDK beside it. Not yet tested.
- Keep `ANTHROPIC_API_KEY` unset in the job. It wins over the token when both are present.
- The token is tied to one person's subscription, so it fits the user's own repos and not a shared org secret. Use an API key for that case.
- Anthropic's terms allow ordinary individual use of the SDK on a subscription and forbid routing other users through those credentials.
- Rotation: mint a new token before the year ends and replace the secret. The docs do not say whether re-running the command revokes the old one.

### 9.2 Distribution

This repo ships three things and no npm package.

- **A composite action, run from source.** The file is `action.yml` at the repo root. It sets up Node 20 from the lockfile and runs `npm ci` and `npm run build`. Then it runs `node dist/cli.js run --format github --pr <pr>` against the consumer checkout. The repo holds no built bundle. The Agent SDK package bundles the Claude Code binary, so the lockfile pins every version. The inputs are `pr`, `tier`, `fresh`, `out` and `allow-api-key`. The outputs are `record` and `verdict`. The action reads no secret. The caller sets `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` in `env`. The action sets `CLAUDE_CODE_RETRY_WATCHDOG=1` for the CLI step.
- **A reusable workflow that wraps the action.** The file is `.github/workflows/review.yml`, with the trigger `workflow_call`. It has one job. The job has the permissions `pull-requests: write`, `checks: write` and `contents: write`, one concurrency group for each PR with cancel-in-progress, and a checkout with `fetch-depth: 0` that fetches `refs/pull/<n>/head` and the base branch. It holds the comment filter, the label filter, the fork gate and the records steps once. A consumer repo carries only its trigger list and a one-line call with `secrets: inherit`. A repo that needs extra steps in the job uses the action directly.
- **The CLI for local runs.** Clone once and link it.
- **The `/review` command, as a plugin of this repo.** This repo is its own Claude Code marketplace. The files are `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `commands/review.md`. A user installs it with `claude plugin marketplace add jerridan/pr-review` and `claude plugin install pr-review@pr-review`. The command runs `pr-review run` in the current repo and adds `--pr <n>` when `gh pr view` finds an open PR. It posts only when the user says `--format github`.

The workflow filters its events. An `issue_comment` event runs only for a PR, a comment that holds `@pr-review full` and an author association of owner, member or collaborator. That run passes `tier: full` and `fresh: true`. A label event runs only for a label that starts with `review:`.

The records steps run with `if: always()`. Before the action, the workflow checks the `pr-review-records` branch out at the `out` directory. After the action, it uploads the `pr-<n>/` directory of the pull request as the artifact `pr-review-record-<pr>-<run id>`, commits the new file at `pr-<n>/<file name>` and pushes it. It creates the branch as an orphan when the branch is absent. On a non-fast-forward refusal, it fetches and rebases up to three times.

Other repos reference this one by a release tag `v<version>`, such as `v0.2.0`. The version is `version` in `package.json`. After a merge to `main`, the release workflow creates the tag and the release when the tag is absent. No tag moves. A consumer that requires SHA pins uses the commit SHA of the tag. The reusable workflow checks out this repo at its own commit, `job.workflow_sha`, and runs the action from that checkout. So the workflow and the action always come from one commit. This repo is public, so any repo can call its workflow and its action. A public repo can call a workflow only from a public repo, so a private copy of this repo would block a public consumer. Publishing to npm stays an option.

Consumer workflow:

```yaml
name: PR review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_target:
    types: [labeled]
  issue_comment:
    types: [created]
jobs:
  review:
    permissions:
      pull-requests: write
      checks: write
      contents: write
    uses: jerridan/pr-review/.github/workflows/review.yml@v0.2.0
    secrets: inherit
```

The trigger list must live in the consumer, because GitHub reads `on:` only from the repo where the event happens. Fork PRs reach the tool only through a maintainer's action, the label path or the comment `@pr-review full`, because a `pull_request` event from a fork has no secrets. The `pull_request_target` trigger carries that label event. The reusable workflow runs a fork PR only on a `pull_request_target` event with the label `review:full` or `review:fast`. The label permission is the gate: only a user with triage permission or more can add a label, and the event carries no association for the labeler. One `if` expression names `head.repo.fork` and `pull_request_target`. The same expression skips a `pull_request` event from a fork. A fork run passes `tier` from the label, and `fresh: true` for `review:full`.

Options considered and set aside: a JavaScript action with a committed bundle (faster start, noisy bundle diffs), an npm package (needs a registry token in every consumer while private), a Docker image (strongest pinning, but the lockfile already pins the SDK and its bundled binary).

Sources for 9.1: code.claude.com/docs/en/authentication, code.claude.com/docs/en/github-actions, code.claude.com/docs/en/legal-and-compliance, support.claude.com article 15036540.

## 10. Decisions

Settled on 2026-10-13:

1. **Runtime**: Claude Agent SDK in TypeScript.
2. **Agent file location**: `.pr-review/reviewers/`.
3. **Fork policy**: label-gated run through `pull_request_target`. A maintainer adds `review:full` or `review:fast`. The run executes no code from the fork head.
4. **Review format**: one GitHub review per run, short body with verdict, inline comments on diff lines. Comment event only.
5. **Verifier threshold**: 80 as the default, tuned by the harness.
6. **Reviewer models**: Opus 5.5 at low effort by default, as decision 15 states. A repo can override the model and effort per role or per reviewer. See section 4.
7. **Severity**: blocking, suggestion, nit, with the tests in section 3.5.

8. **Auth**: the user's Claude subscription, in CI and locally. See section 9.

9. **Verifier model**: Sonnet, with Opus escalation. Severity assigned by the verifier, downgradable at merge.
10. **Non-blocking cap**: `3 + ceil(hunks / 4)`, at most 20. A starting value for the harness to tune.
11. **Failures**: always visible in the review, verdict `incomplete`. Never post unverified findings.
12. **Records**: workflow artifact plus a `pr-review-records` branch.
13. **Distribution**: composite action run from source, wrapped in a reusable workflow, plus the CLI. No npm package. The concurrency limit is the `concurrency` key of the repo config, default 5, as decision 17 says.
14. **Orchestrator**: plain code, no model. Every judgment call is a bounded agent call with a schema.
15. **Model versions**: exact IDs pinned in config, 5.5 family by default. Reviewers on Opus 5.5 at low effort, verifier on Sonnet 5.5 at high with Opus escalation, triage and merge on Sonnet 5.5, summarizer on Haiku 5.5. Harness hypotheses, see section 5.1.
16. **Reviewer prompts**: report everything in scope with confidence and severity; filtering is the verifier's job. Follows the 5.x guidance that conservative review prompts over-filter.
17. **Parallelism**: a semaphore sized to runner memory, default 5, because each SDK query is a process of about 1 GiB. This is a resource bound, not a rate-limit policy.

## 11. Open risks

- A Sonnet verifier may be too weak for findings that need cross-file reasoning. Mitigation: route a finding to Opus when the reviewer marks it `needs_context: true`.
- Semantic merge is one more LLM step that can hide a real finding. Mitigation: the record keeps every input and output of the merge, and `explain` shows them.
- The eval judge is a Claude model and the reviewer is a Claude model. Nobody has measured this bias. Mitigation: match by span first, use the judge only for ambiguous pairs, and use a different Claude model for the judge than for the reviewers, as Anthropic's evaluation guidance recommends.
