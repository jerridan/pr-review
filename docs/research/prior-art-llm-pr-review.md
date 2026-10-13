# Prior art: LLM pull-request review tools

Research date: 2026-10-12. Method: two passes of a deep-research workflow (5 and 6 search angles, 47 sources fetched, 225 claims extracted, 50 claims checked by 3 independent verifier agents each). I also read Anthropic's two open-source review plugins directly from the local plugin cache. Claims below come from primary sources unless marked. Numbers that only one vendor reported about itself are marked "self-reported".

## 1. Summary

The field converged on one shape between 2024 and 2026:

1. **Fan out.** Several narrow finders look for candidate issues in parallel. Cloudflare, Anthropic (plugin and product), Ellipsis, cubic, Uber and Baz all do this.
2. **Verify.** A separate stage checks each candidate against the real code, gives it a confidence score, and drops low scores. Every team that published says the generator prompt alone could not reach acceptable precision.
3. **Deduplicate, rank, post once.** A coordinator merges overlapping findings and posts a small number of comments.
4. **Learn from the team.** The tools that report the largest gains in "addressed rate" did it with per-team feedback loops, not better prompts: Greptile (embedding filter on past votes), Cursor (learned rules), Ellipsis (embedding search over reactions), Atlassian (retrieved past PR comments).

Two things are **not** settled:

- Nobody published an ablation that shows specialist reviewers beat one strong reviewer at the same token budget. Anthropic's own guidance says token spend explains most multi-agent gains.
- Precision versus recall. The 2024 to 2025 consensus was "fewer comments, higher precision". In 2026 three sources pushed back: GitHub's ensemble raised comment volume 61% and raised the addressed rate, Cursor reversed its conservative prompting, and the c-CRAB benchmark found that four tools together catch only 41.5% of issues human reviewers raised.

## 2. Architectures in production

| Tool | Date | Shape | Notes |
|---|---|---|---|
| Cloudflare (internal, GitLab) | Apr 2026 | Coordinator + up to 7 specialist sub-reviewers (security, performance, code quality, docs, release, RFC compliance, AGENTS.md) | Effort tiers by diff size: trivial 2 agents, lite 4, full 7+. Security paths force full. Top model only for the coordinator. Avg cost $1.19, median 3m39s, 85.7% prompt-cache hit, about 1.2 findings per review. 131k runs in 30 days. |
| Anthropic Code Review (product) | Mar 2026 | Parallel finder agents, then a verification agent, then an aggregator that dedupes and ranks | Depth scales with PR size. Avg $15 to $25 and about 20 min per review. Self-reported: under 1% of findings marked incorrect, PRs with substantive comments rose 16% to 54%. Config via CLAUDE.md plus a review-only REVIEW.md. |
| Anthropic `code-review` plugin (open source) | 2025 to 2026 | 3 Haiku gate agents, then 5 parallel Sonnet reviewers, then one Haiku scorer per finding, drop below 80/100 | Reviewers split by **evidence source**, not by concern: CLAUDE.md compliance, diff-only bug scan, git blame history, previous PRs on the same files, code comments in modified files. Explicit false-positive list. Prints locally, posts one comment with `--comment`. Read directly from the local plugin cache. |
| Anthropic `pr-review-toolkit` plugin | 2025 to 2026 | 6 named agents (code-reviewer, pr-test-analyzer, silent-failure-hunter, type-design-analyzer, comment-analyzer, code-simplifier) | Agents chosen by what changed (tests, error handling, types). Sequential by default, parallel on request. Output grouped critical / important / suggestion. |
| Uber uReview | Aug 2025 | Prompt chain: generate, filter, validate, deduplicate | Single-shot prompting gave too many false positives even with o4-mini-high and Claude 4 Sonnet. Grader gives a confidence score. Thresholds tuned per language and per comment category. Category classifier suppresses low-value categories. Best config by F1 on a golden set: Sonnet 4 generator, o4-mini-high grader. Median 4 min in CI. |
| Ellipsis | Jan 2025 | Many small Comment Generators in parallel, mixed models, then multistage filter | Prefers "dozens of smaller agents that can be independently benchmarked". Filters: dedupe, logical-correctness check for hallucinations, confidence. Keeps filtered comments and reasons in output for debugging. Shared code-search subagent: tree-sitter AST chunks, SHA-keyed chunk IDs, LLM relevance classifier after vector search, LSP sidecar. |
| cubic | Jun 2025 | Planner + Security + Duplication + Editorial micro-agents | First design was one large prompt and was too noisy. Prompt tweaks did not fix it. Each finding is JSON with reasoning, finding, confidence. Cut toolset to a simple LSP plus terminal after logs showed most tools unused. Self-reported 51% fewer false positives. |
| Baz | 2025 | 5 phases: context map, intent inference, Socratic questions, one sub-agent per risk hypothesis, reflection | Decomposes by hypothesis, not by reviewer role. Each sub-agent returns evidence plus a verdict. Reflection step filters false positives. Evaluates each step against fixtures. |
| Cursor Bugbot | 2025 to 2026 | Moved from a fixed pipeline (parallel passes over shuffled diffs, majority vote) to an agentic loop with tools | Cursor calls the agentic loop its biggest quality gain. It **reversed** conservative prompting: now "investigate anything suspicious" and rely on tools and validation. Learned rules from downvotes, replies and missed-bug human comments. Self-reported resolution rate 52% to 78%. |
| Greptile | Dec 2024 | Single reviewer plus per-team embedding filter | First version: 19% good, 2% wrong, 79% correct-but-nit. Prompting, few-shot and an LLM severity judge all failed. Per-team vector store of upvoted/downvoted comments; block if similar to 3 downvoted. Self-reported address rate 19% to 55% in two weeks. |
| BitsAI-CR (ByteDance) | Jan 2025 | RuleChecker, then ReviewFilter | ReviewFilter raised precision from 54.5% to 67.1% in the paper. Deployed to 12k weekly users. Proposes "outdated rate" as an adoption proxy. |
| Sourcery | Feb 2024 | Generator plus validator | A naive "is this useful?" second LLM did nothing (43% to 42%). Structured boolean validators helped in their report, but my verifiers could not confirm the size of the gain. |
| RevMate (Mozilla, Ubisoft) | Nov 2024 | GPT-4o, RAG, LLM-as-judge filter | Peer-reviewed live study. Only 7 to 8% of comments accepted. Judge filter alone did not give precision. |
| GitHub Copilot code review | 2025 to 2026 | Lite-tier multi-model ensemble (several model runs merged) | Offline ReviewBench predicted the ensemble result. Online: addressed rate +8%, recall +13.6%, comment volume +61%, cost -8%. |
| CodeRabbit | 2025 to 2026 | Agent runs shell in a sandbox to explore the repo per PR ("dynamic discovery") | Description comes from a competitor's post, not CodeRabbit. Reads AGENTS.md and .cursorrules automatically. |
| Qodo / PR-Agent | 2023 to 2026 | One LLM call per command, PR compression for large diffs | PR-Agent is now a community legacy project. Qodo 2.0 is the hosted product. |
| Google (internal) | 2024 | ML-suggested edits to resolve human review comments | 7.5% of all reviewer comments addressed by applying a suggested edit. Different problem: resolving comments, not writing them. |

## 3. Signal versus noise

### What did not work

- **Prompt tweaks on one big prompt.** cubic, Greptile and Cloudflare all report that longer prompts, "ignore style", temperature or sampling changes gave little or no gain.
- **Few-shot examples.** Greptile says they made output worse.
- **A naive LLM judge.** Sourcery's "is this comment useful?" pass did nothing. Greptile's 1 to 10 severity judge gave "nearly random" ratings. RevMate's judge filter left acceptance under 10%.
- **Making the model conservative.** Cursor tried this and reversed it. Greptile could not cut nits by prompt without also cutting valuable comments.

### What practitioners report works

- **A structured verifier with an evidence bar.** Anthropic's plugin scores each finding 0 to 100 with a rubric and drops under 80. Anthropic's product has a verification agent that checks candidates against actual code behavior and a documented "file:line evidence" bar. Uber's grader scores confidence with thresholds tuned per category. Cloudflare's coordinator reads source with tools when unsure. BitsAI's ReviewFilter is the one with a published precision delta.
- **An explicit "do not flag" list.** Cloudflare's main noise fix was to tell each reviewer what not to flag: theoretical risks, "consider library X". Anthropic's plugin lists: pre-existing issues, things a linter or compiler catches, general quality not required by CLAUDE.md, lint-ignored lines, intentional behavior changes, real issues on unmodified lines. Anthropic's security action drops whole categories: DoS, rate limiting, generic input validation without proven impact, open redirects.
- **Leave syntax to linters.** Uber: linters for syntactic rules, LLM for semantic checks. Anthropic plugin: assume CI runs build and typecheck.
- **Dedupe by meaning.** Uber uses semantic similarity. Cloudflare and Anthropic dedupe in the coordinator.
- **Suppress categories by measured value.** Uber's classifier drops categories with low historical developer value. RevMate found refactoring comments accepted at 18% versus functional at 5%, so value differs by category and by team.
- **Per-team feedback loops.** Greptile's embedding filter, Ellipsis's reaction-embedding search, Cursor's learned rules. All three say what counts as a nit varies by team, so a universal filter fails.
- **Majority vote over repeated passes.** Early Bugbot shuffled the diff and kept issues several passes found. Anthropic's old plugin version ran two CLAUDE.md agents for redundancy.
- **Reasoning before the finding.** cubic requires reasoning, then finding, then confidence in JSON. The logs let them find flawed reasoning patterns.

### The precision-recall conflict

| Source | Finding |
|---|---|
| Qodo benchmark (2025) | Most tools are high precision, low recall. |
| c-CRAB (Mar 2026, preprint) | Claude Code 32.1%, Devin 24.8%, PR-Agent 23.1%, Codex 20.1% pass rate on tests built from human review comments. Union of all four: 41.5%. Tools post 1.8 to 7.3 comments per PR versus 1.3 for humans. Tools do well on localized bugs and badly on categories that need repo conventions (maintainability 8% to 27%). |
| GitHub ensemble (2026) | More comments (+61%) and a higher addressed rate at the same time. |
| Cursor (2026) | Dropped conservative prompting; relies on verification instead. |
| RevMate (2024) | 7 to 8% acceptance; developers wanted concise issue highlights, not full comments. |
| Small-model paper (2026, preprint) | Haiku 4.5 beat Sonnet 4.6 on F1 at one third the cost. Sonnet had higher precision, Haiku higher recall. Union ensemble lowered F1. Diff size dominated: F1 0.657 under 10 lines, 0.043 over 150 lines. Performance-bug recall was 0% for 4 of 5 models. |

Takeaway: tune recall up in the finders and precision in the verifier. Do not try to get both from one prompt.

## 4. Metrics

Every vendor reports a different number. None are comparable.

| Metric | Definition | Who | Value |
|---|---|---|---|
| Accepted | Reviewer marked the comment accepted | RevMate | 7 to 8% |
| Appreciation | Accepted or rated useful as a tip | RevMate | 23 to 28% |
| Useful | Engineer thumbs up | Uber, Sourcery | 75% (Uber, self-selected), 43% (Sourcery) |
| Addressed | 5 re-runs on the final commit do not reproduce the comment | Uber | 65% (humans 51%) |
| Address rate | Developer changed the code before merge | Greptile | 19% to 55% |
| Resolution rate | LLM judge says the comment was addressed by merge | Cursor, GitHub | 78% (Cursor, public repos only) |
| Auto-resolved | Thread auto-closed because the issue is gone | Anthropic product | Dashboard only |
| Incorrect-marked | Engineer marked the finding wrong | Anthropic product | under 1% |
| Applied edit | Author applied the ML-suggested edit | Google | 7.5% |
| Outdated rate | Comment refers to code that later changed | BitsAI-CR | 26.7% (Go) |
| Findings per review | Count | Cloudflare | about 1.2 |

Lessons:

- Pick one online metric with an automated definition. "Addressed" via a re-run or an LLM judge is the common choice. Thumbs reactions are sparse; Greptile rejected them. Anthropic pre-attaches 👍/👎 to each comment to raise response rate.
- Track it per category and per repo. Thresholds that are tuned globally hide category-level noise.
- Acceptance and actionability do not line up. In RevMate's manual review, 62% of rejected comments were still actionable and only 36% of "useful" ones were.

## 5. Context engineering

- **Diff only hallucinates.** Cloudflare's naive version invented syntax errors and asked for error handling that existed. An independent builder saw "undefined variable" hallucinations. Both moved to diff plus selected files.
- **Full files through the API hit rate limits.** One builder hit 429s on a 40-file PR and moved to a two-phase design: model selects 5 to 10 files by a forced tool call, pack them locally, review. Cost fell from about $0.20 to $0.02 per review on Haiku. Cap the selection: the model once chose 47 files for a 3-line CSS change.
- **Agentic exploration versus an index.** CodeRabbit runs shell in a sandbox per PR. Cursor says the agentic loop with tools was its biggest gain. Cloudflare's coordinator reads source when unsure. Ellipsis built an index instead: AST chunks, incremental SHA-keyed re-index, an LLM relevance classifier because "cosine similarity does a very poor job", and a language server for symbol lookup because "LLMs are bad at column numbers". No source compares the two.
- **Past PRs and their review comments.** Atlassian's online A/B test: resolution rate 31.9% to 41.9% with similar past PRs plus their comments. Diffs alone gave half the lift. "Comments tell the model what to look for; diffs tell it what correct looks like." Same-repo retrieval with a 0.75 similarity threshold; cross-repo added coverage but no quality. Anthropic's plugin has an agent that reads previous PRs on the same files. Uber reads code only and still reports good numbers.
- **Repo guidance files.** CLAUDE.md and AGENTS.md are read hierarchically by Anthropic, Cloudflare and CodeRabbit. Anthropic's product adds a review-only REVIEW.md that goes to finder and verifier agents. Its docs warn that length dilutes the rules that matter. The plugin notes that CLAUDE.md is guidance for writing code, so not every rule applies to review. The scorer double-checks that CLAUDE.md actually names the issue before it counts a compliance finding.
- **Large PRs.** Effort tiers by diff size (Cloudflare, Anthropic product). Anthropic's data: 84% of PRs over 1,000 lines get findings (7.5 on average) versus 31% under 50 lines. The small-model paper suggests splitting large diffs. PR-Agent compresses. Hallucinations rise once over half the context is filled (Ellipsis).
- **Shared context to control cost.** Cloudflare's sub-reviewers share one context file and per-file patch files to avoid about 7x token cost. Its 85.7% cache hit rate points to a large shared prompt prefix.
- **Filter scope before review.** Exclude generated, vendored, lock, binary and minified files. CodeRabbit ships defaults. One heuristic post claims a 30% scope cut gives 50% fewer comments (unverified).

## 6. Multi-agent decomposition: the evidence

**For fan-out:** every production system in section 2 fans out. Ellipsis's reason is operational: small agents can be benchmarked and tuned independently. cubic's reason is that one prompt could not separate nits from bugs.

**Against, or at least unproven:**

- Anthropic's multi-agent research post (Jun 2025): multi-agent uses about 15x the tokens of chat. On BrowseComp, token usage explained about 80% of the performance variance. Coding tasks with shared context are "a poor fit". Subagents need explicit objective, output format and boundaries or they duplicate work.
- Tran and Kiela (Apr 2026, preprint): single agents match or beat multi-agent at equal thinking budget on multi-hop reasoning.
- Small-model paper (2026): union of two models lowered F1.
- No source ablates specialists versus one reviewer for code review.

**Decompositions seen in the wild:**

| Axis | Examples |
|---|---|
| By concern | Cloudflare (security, perf, quality, docs, release, RFC, AGENTS.md), cubic, pr-review-toolkit |
| By evidence source | Anthropic plugin (CLAUDE.md, diff-only, git blame, past PRs, code comments) |
| By hypothesis | Baz (one sub-agent per risk hypothesis) |
| By repetition | Early Bugbot (shuffled passes + majority vote), old Anthropic plugin (two CLAUDE.md agents) |
| By model | Ellipsis mixed Sonnet and GPT-4o; GitHub merges several model runs |

**Model tiering** is universal: cheap model for gates and scoring (Haiku in Anthropic's plugin), standard for reviewers (Sonnet), top tier only for the coordinator (Cloudflare). The small-model paper and the two-phase builder both found Haiku-class models competitive on review F1.

## 7. Operations

### Same engine in CI and locally

- Cloudflare: the same agents run locally through a `/fullreview` command.
- Anthropic plugin: prints to terminal by default, posts with `--comment`. The GitHub Action uses the same plugin.
- Anthropic security action: exposed locally as a slash command users copy into `.claude/commands/`.
- PR-Agent: CLI, Docker, Action, webhook, same code.

### Re-review and idempotency

- **Cloudflare:** coordinator receives its previous review and the existing thread list. Fixed findings are omitted, which auto-resolves threads. Unfixed are re-emitted. Developer "won't fix" replies are respected. Approval biased toward approve; a human "break glass" comment forces it (0.6% of MRs).
- **Anthropic product:** push-triggered re-review auto-resolves threads when fixed. Check run always concludes neutral so it never blocks. Findings also go into check-run annotations and a severity table so they survive when GitHub rejects an inline comment on a moved line. Machine-readable severity JSON is embedded in the check-run text for the user's own CI gating. A queued review waits if one is running. Findings on lines removed mid-review go under "Additional findings". Documented "re-review convergence": suppress nits after the first review.
- **Qodo:** one review comment per PR, edited on each push. New findings get a "New" label; earlier runs go in a "Previous reviews" section. `enable_incremental_review` defaults true. Push trigger is off by default.
- **Anthropic plugin:** skips closed, draft, trivial, automated, and already-reviewed PRs. Re-checks eligibility right before posting.
- **Bugbot:** inline threads resolve on re-review but the summary comment goes stale. Users report this as a known limitation (Mar 2026). Several related idempotency bug reports exist.

### Output shape

- One structured summary comment: Cloudflare, Anthropic plugin.
- Overview comment plus inline comments: Anthropic product, Bugbot, Copilot.
- Permalinks need the full SHA and a line range (Anthropic plugin formats this precisely).
- Each comment should carry a short reason. Unexplained flags get ignored (InterWorks). RevMate's survey: 10 of 22 reviewers preferred concise issue highlights over full comments.
- Suggested-change blocks: used by the two-phase builder and Google. No evidence on acceptance.

### Per-repo configuration formats

| Tool | File | Scoping | Limits and notes |
|---|---|---|---|
| Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | `applyTo` glob list; files without it are ignored | Org-level instructions also apply. `excludeAgent` key added Nov 2025. Advice: separate focused files per area. |
| CodeRabbit | `.coderabbit.yaml` | `reviews.path_instructions` (glob + free text), `reviews.path_filters` (`!` excludes, any exclusion wins) | 20,000 chars per instruction. Also reads AGENTS.md and .cursorrules. Custom pass/fail checks are separate. Advice: add path instructions only after consistent misses. `@coderabbitai emit path instructions` turns the last 7 days of review chat into a config PR. |
| Cursor Bugbot | `.cursor/BUGBOT.md` | Root always, then walk up from changed files | 30,000 chars per rule, 100,000 total. Verbose mode lists rules used and truncated. `.cursor/rules/*.mdc` do not apply. Learned rules live in the UI. |
| Greptile | `.greptile/` folder (`config.json`, `rules.md`, `files.json`) or legacy `greptile.json` | Cascades root to directory; closest wins for settings; rules add up; disable by rule `id` | Dashboard for org defaults. If both files exist, `greptile.json` is ignored. |
| Qodo / PR-Agent | `.pr_agent.toml` on the default branch; org repo `pr-agent-settings` | Filters on title, branch, labels, authors, folders | `ignore_bot_pr` only works under provider sections. Precedence: wiki over local over global. |
| Anthropic product | `CLAUDE.md` (hierarchical) plus `REVIEW.md` (root, review-only) | Hierarchical | Levers: severity redefinition, nit caps, skip rules, evidence bar, convergence, summary shape. |
| Cloudflare | AGENTS.md plus internal RFCs | One reviewer dedicated to AGENTS.md compliance | |

Common pattern: path-scoped natural-language rules, applied in a hierarchy, with **scope filters kept separate from review guidance**. Governance lesson from InterWorks: reviewer definitions drift team by team; fix with one shared standard, a named owner per reviewer, and treat reviewer instructions as code with tests.

### Cost

| Setup | Cost per review |
|---|---|
| Anthropic Code Review product | $15 to $25, about 20 min |
| Cloudflare 7-agent full tier | $1.68 (avg $1.19 across tiers) |
| Two-phase Haiku builder | about $0.02 |
| Small-model paper, Haiku 4.5 | $0.003 |

Controls seen: effort tiers by diff size, model tiers by role, prompt caching with a shared prefix, skip drafts, forks and bot PRs, path exclusions, file caps, per-repo trigger mode (once, every push, manual), org monthly spend cap, `--max-turns` and workflow timeouts.

### Security

Incidents in 2026 against CI review agents:

- **CVE-2026-47751** (claude-code-action under 1.0.74): the action checked out the PR head and loaded `.mcp.json` from it, so an attacker's PR could run arbitrary MCP servers on the runner. Fix: restore `.claude/` and `.mcp.json` from the **base branch** before the CLI runs. This matters directly for repo-defined custom reviewers.
- **claude-code-action permission bypass** (disclosed Jun 2026, CVSS 7.8): any GitHub App actor passed the write check. The example workflow shipped `allowed_non_write_users: "*"`. Hidden instructions in an issue made the agent read `/proc/self/environ` and leak OIDC tokens.
- **"Comment and Control"** (Apr to May 2026): PR title injection against Anthropic's Security Review action leaked `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`. Same class hit Gemini CLI Action and Copilot Agent. Bounties were small and no CVEs were issued.
- Cloudflare's only injection mitigation is regex-stripping boundary tags from MR bodies. They say so.

Defenses the sources agree on:

1. Trigger on `pull_request`, never `pull_request_target`, for untrusted PRs. Skip fork PRs on automatic triggers (Anthropic product does this).
2. `GITHUB_TOKEN` with an explicit minimal `permissions` block. No `id-token: write`. Pull-requests write and contents read is enough to comment.
3. Read reviewer configuration (rules, custom reviewer definitions, MCP config) from the trusted base branch, not the PR head.
4. Reviewer runs read-only. Put any step that needs secrets or push in a downstream job. GitHub Agentic Workflows (Feb 2026 preview) formalizes this split.
5. Delimit untrusted content (title, body, commits, branch names, diff) from instructions. Strip HTML comments. Scan agent-posted output for secrets.
6. Require write permission or maintainer approval for the triggering actor. Reject bot actors unless allow-listed, to stop bot loops.
7. Pin actions to SHAs. This does not fix injection but limits supply-chain risk.

## 8. Evaluation harnesses

| Harness | Shape | Headline | Caveats |
|---|---|---|---|
| ReviewBench (GitHub + Microsoft, Oct 2026) | 219 PRs, 187 repos, 19 languages. Golden set pooled from humans, follow-up commits, analyzers and several LLMs, deduped, validated by Claude Sonnet 5 judge | Grounded recall is the comparison metric. Augmented metrics credit valid findings outside the gold set. Senior engineers agreed with gold labels 96.6% | GitHub ran competitors itself. Judge can be wrong. 7 days old at research time. |
| Martian Code Review Bench (Feb 2026) | 50 PRs from Sentry, Grafana, Cal.com, Discourse, Keycloak; 173 golden comments with severity and category. Plus an online track that matches bot comments to real developer fixes in the last 7 days | F-beta 0.5 to 3.0. Online precision = suggestions matched to fixes | Rankings move up to 2 places when the judge model changes. Several vendors each claim first. |
| c-CRAB (Mar 2026, preprint) | Each human comment becomes an executable test. A coding agent applies the tool's review. Pass = test passes | Execution-based, no text matching | Measures recall of human-raised issues only. 82% of tests are structural. One group. |
| Qodo benchmark | Verified bugs injected into real merged PRs plus AGENTS.md rule violations | Precision, recall, F1 | Vendor-run. Default configs. |
| Uber golden set | Curated PRs, F1 used to pick generator and grader models | Re-tested when new models ship | Internal |
| Ellipsis | Start with about 30 examples. LLM-as-judge works with chain of thought | | |
| Anthropic research team | About 20 queries. One LLM judge call returning 0 to 1 plus pass/fail matched humans best. Human spot checks still caught what the judge missed | | Not code review |
| Baz | Step-wise fixtures: is the context map right, are the questions complete, is the evidence sufficient | Makes the pipeline debuggable | |

Warnings:

- **Synthetic bug injection overstates quality.** Haiku's F1 was 0.847 on synthetic samples and 0.066 on real PRs. Mix real PRs into any golden set.
- **Offline rarely predicts online with confidence.** GitHub has one case where it did. Atlassian's offline results were mostly not significant while its online test was positive. c-CRAB argues LLM judges are unreliable for review evaluation and proposes execution instead.
- Static golden sets leak into training data. Martian's online track exists for this reason.

## 9. Open questions

1. Do specialist reviewers beat one strong reviewer, or N self-consistency runs of it, at equal token budget and equal precision? No source measures this.
2. Does agentic exploration beat a prebuilt index for review context? CodeRabbit and Cursor chose exploration; Ellipsis and Greptile chose an index. No comparison exists.
3. How should a repo-defined custom reviewer be trusted on a fork PR? CVE-2026-47751 says load config from the base branch, but nobody has published a model for untrusted reviewer definitions beyond that.
4. What is the right severity threshold, and should it differ per category? Anthropic uses 80/100 and gives no reason. Uber tunes per category and publishes no values.

## 10. Sources

Primary, verified by 3 agents:

- Cloudflare, "AI code review" (Apr 2026): https://blog.cloudflare.com/ai-code-review
- Anthropic Code Review docs: https://code.claude.com/docs/en/code-review and launch post https://claude.com/blog/code-review (Mar 2026)
- Anthropic GitHub Actions docs: https://code.claude.com/docs/en/github-actions
- Anthropic `code-review` plugin: https://github.com/anthropics/claude-code/tree/main/plugins/code-review (also read locally)
- Anthropic security review action: https://github.com/anthropics/claude-code-security-review
- Anthropic, "How we built our multi-agent research system" (Jun 2025): https://www.anthropic.com/engineering/multi-agent-research-system
- Uber, uReview (Aug 2025): https://www.uber.com/us/en/blog/ureview/
- Ellipsis, "Lessons from 27 months building LLM coding agents" (Jan 2025): https://nickbradford.substack.com/p/lessons-from-27-months-building-llm
- Sourcery (Feb 2024): https://www.sourcery.ai/blog/improving-llm-responses
- RevMate paper (Nov 2024): https://arxiv.org/abs/2411.07091 and Ubisoft post: https://www.ubisoft.com/en-us/studio/laforge/news/3SsR9KkpyUCBvy1Wyw3lTS/impact-of-an-llmbased-code-review-assistant-in-practice
- Atlassian PR-context experiment (Mar 2026): https://www.atlassian.com/blog/development/improving-code-reviewer-with-pr-context
- GitHub ReviewBench (Oct 2026): https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/
- Martian Code Review Bench: https://github.com/withmartian/code-review-benchmark
- c-CRAB (Mar 2026): https://arxiv.org/abs/2603.23448
- Google, resolving code review comments with ML (2024): https://research.google/pubs/resolving-code-review-comments-with-machine-learning/
- Cursor Bugbot learning (Apr 2026): https://cursor.com/blog/bugbot-learning and https://cursor.com/changelog/04-08-26; Bugbot docs: https://cursor.com/help/ai-features/bugbot
- Copilot path-scoped instructions (Sep 2025): https://github.blog/changelog/2025-09-03-copilot-code-review-path-scoped-custom-instruction-file-support
- CodeRabbit docs: https://docs.coderabbit.ai/configuration/path-instructions and https://docs.coderabbit.ai/reference/configuration
- Greptile docs: https://www.greptile.com/docs/code-review/customization-overview and https://www.greptile.com/docs/code-review/greptile-config
- Qodo docs: https://docs.qodo.ai/code-review/persistent-review-comments and https://docs.qodo.ai/code-review/ignore-content-from-analysis
- PR-Agent: https://github.com/The-PR-Agent/pr-agent
- BitsAI-CR (Jan 2025): https://arxiv.org/abs/2501.15134

Extracted by one agent, not voted on (treat as leads):

- cubic, "Learnings from building AI agents" (Jun 2025): https://cubic.dev/blog/learnings-from-building-ai-agents
- Baz, agentic code review architecture: https://baz.co/resources/engineering-intuition-at-scale-the-architecture-of-agentic-code-review
- Greptile, Dec 2024 nit-filter post (via ZenML summary): https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings
- Cursor forum, "Building a better Bugbot": https://forum.cursor.com/t/building-a-better-bugbot/149040 and stale-summary thread: https://forum.cursor.com/t/bugbot-summary-comment-not-updated-after-fixes-are-pushed/154935
- Small-model review paper (2026): https://arxiv.org/html/2606.15689v1
- Qodo benchmark: https://qodo.ai/blog/how-we-built-a-real-world-benchmark-for-ai-code-review
- CVE-2026-47751: https://releasealert.dev/cve/CVE-2026-47751 (check GHSA-8q5r-mmjf-575q)
- claude-code-action permission bypass and CI hardening (Jun 2026): https://codex.danielvaughan.com/2026/06/14/claude-code-github-action-rce-lessons-codex-cli-ci-cd-pipeline-hardening-prompt-injection-defence/
- Cloud Security Alliance notes on prompt injection in GitHub Actions (2026): https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/ and https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-github-actions-security-20260503-csa-st/
- Two-phase Bedrock reviewer (dev.to): https://dev.to/alexandreamadocastro/building-a-custom-ai-code-reviewer-for-github-enterprise-with-bedrock-and-go-1jaj
- InterWorks governance post (Jun 2026): https://interworks.com/blog/2026/06/26/building-governed-ai-code-review-agents-across-your-engineering-org/
- Tran and Kiela, single vs multi-agent at equal budget (Apr 2026): arXiv 2604.02460

Refuted by verifiers (do not use): Sourcery's "structured validator raised usefulness to about 60%"; "self-assessment fails because the model rationalizes"; "TF-IDF matches GPT-4o at predicting comment usefulness"; "Anthropic's plugin uses 4 agents" (it uses 5, confirmed locally).
