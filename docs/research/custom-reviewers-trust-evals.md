# Custom reviewers, trust model, fast path, and evaluation

Research date: 2026-10-12. Follow-up to `prior-art-llm-pr-review.md`. Method: two deep-research passes (Sonnet agents, 3-vote verification of 50 claims, 43 sources), plus direct reads of Anthropic's Code Review docs, the GitHub Action security doc, the full source of the `claude-code-security-review` filter, the `ReviewBench` agent contract and golden schema, and the current CodeRabbit and Bugbot docs. Verified claims are stated plainly. Single-source or unverified items say so.

## 1. Summary

**Custom reviewers.** No vendor spawns one agent per rule. Vendors do one of two things. They hand the rule text to every reviewer as shared instructions, or they run each rule as a separate pass/fail check. Only Claude Code subagent files map one definition to one agent with its own tools and model. That makes your design more granular than anything on the market, which is fine, but nobody has published results for it.

**Trust.** The strongest documented pattern is to load all reviewer configuration from the base branch, never from the PR head. Anthropic's Action does this for a fixed file list after a CVE. Cursor's cloud Bugbot documents the same for its config file. Cursor's local review does not, and a researcher showed a fork PR running commands on a maintainer's machine through a hooks file.

**Fast path.** Qodo is the only vendor that published how it routes by PR complexity. Its finding: diff size is a poor routing signal. Hunk count and semantic content work better. Every other vendor skips by metadata only (drafts, titles, labels, bot authors) or scales depth without saying how.

**Evaluation.** You can assemble a harness today from public parts. ReviewBench gives 219 PRs, a container contract, a rich golden schema and an MIT license. Martian gives 50 PRs with a severity and category taxonomy. Score with a hit-based judge, not a holistic score. Repeat reviewer runs, because the reviewer is the noisy part, not the judge. Start with 20 to 50 cases.

## 2. How vendors turn repo rules into reviewer behavior

| Vendor | Mechanism | Model | Notes |
|---|---|---|---|
| Anthropic Code Review | `REVIEW.md` goes to finder and verifier agents with the default guidance. Ranker and reporter consult it. `CLAUDE.md` is project context; violations become nits | Shared text | Agents are split by issue class, not by rule. Docs say rules in REVIEW.md "land more reliably than the same rules in a long CLAUDE.md" and "a long REVIEW.md dilutes the rules that matter most". Local `/code-review` ignores REVIEW.md. |
| Anthropic `code-review` plugin | Fixed 5 reviewers. CLAUDE.md feeds one of them | Shared text | Scorer must confirm CLAUDE.md names the issue before it counts. |
| Anthropic security action | Two text files appended to the prompt: custom scan categories (added after the default "Data Exposure" category) and custom false-positive filtering instructions (replaces the default 17 precedents) | Shared text | The filter prompt gives the verifier the full file, the finding JSON, the PR title and body, and asks for a 1 to 10 confidence plus `keep_finding`. |
| CodeRabbit | Three mechanisms. Path instructions: glob plus text, max 20,000 chars. Code guidelines: AGENTS.md, .cursorrules, read automatically. Custom checks: natural-language pass/fail conditions | Shared text and checks | Checks return Passed, Failed or Inconclusive with reasoning, in three steps: analyze, verify with tools, decide. Results appear only in the summary table, never inline. Mode off, warning (default) or error. Error blocks merge only with the request-changes workflow on. 50-char name, 10,000-char instructions. Checks run in a read-only sandbox: changed files, PR context, ast-grep, ripgrep, shell, web, MCP. They cannot run tests, read node_modules or run repo code. If a check needs something the sandbox lacks, it returns Inconclusive. |
| Greptile | `.greptile/rules.md` is passed whole to the reviewer as context, scoped to the directory. `config.json` rules have scope, severity, id | Shared text | Suggests learned rules after about 10 PRs; admin approves. Suggestions can duplicate existing rules (known issue). |
| Cursor Bugbot | Merged rule block in this order: team rules, project `BUGBOT.md` files, learned rules, manual rules | Shared text | 30,000 chars per rule, 100,000 total, required team rules first. `@cursor remember [fact]` adds a learned rule from a PR comment. Verbose mode shows which rules were included, truncated or omitted. |
| Qodo | `pr_compliance_checklist.yaml`, one per folder, global copy in the `pr-agent-settings` repo | Checks (how they run is unconfirmed) | Page is marked v1 and being sunset. |
| GitHub Copilot | Repo and path-scoped instruction files | Shared text | GitHub says files over about 1,000 lines cause inconsistent behavior. |
| Claude Code subagents | `.claude/agents/*.md` with frontmatter: `name`, `description` required; `tools` allowlist; `disallowedTools` denylist applied first; `model` sonnet, opus, haiku, fable, full ID or inherit | One agent per definition | Own context window, system prompt, tool scope. Anthropic's `pr-review-toolkit` ships 6 such agents. Nobody has published a vendor product built this way. |

### Rule-writing advice that survived

- One concern per rule or check. Clear pass/fail criteria. Examples for complex rules. Avoid "verify best practices", facts the agent cannot see such as approval status, and speculation. (CodeRabbit)
- Add a scoped rule only after you see the reviewer miss the same thing repeatedly. Rules supplement built-in logic. (CodeRabbit)
- Keep review rules short and separate from general project context. (Anthropic)
- Be specific about architecture: "We use AWS Cognito for all authentication." Document why a pattern is excluded. Version control the rules and have the team review them. (Anthropic security action)
- No source published a measured effect of custom rules on addressed rate or false positives.

### Learned rules

Three vendors generate rules from feedback instead of asking teams to write them. Cursor uses downvotes, replies and human comments about missed bugs, promotes candidate rules when signal accumulates, and disables rules with consistent negative signal. Greptile suggests rules after about 10 PRs. CodeRabbit's `@coderabbitai emit path instructions` turns the last 7 days of review chat into a config PR. All three keep a human approval step in the loop.

## 3. Trust model for repo-defined configuration

### What is documented

| Tool | Config source on a PR | Notes |
|---|---|---|
| Anthropic GitHub Action (v1.0.74+) | Base branch, for a fixed list: `.claude/`, `.mcp.json`, `.claude.json`, `.gitmodules`, `.ripgreprc`, `CLAUDE.md`, `CLAUDE.local.md`, `.husky/` | Paths missing on base are removed. PR versions are kept under `.claude-pr/` for reference. Everything else stays at PR head, so a hook that runs `npm run format` executes PR-controlled scripts. Docs say to invoke tools directly with pinned versions and pass config on the command line. |
| Cursor cloud Bugbot | Base branch for `.cursor/config/bugbot.yaml` | "A PR cannot change its own review settings." Files over 64 KB ignored. Precedence: author's personal settings, then repo file, then dashboard. The repo file can lower the autofix mode but not raise it. |
| Cursor local review | PR head | A fork PR with a malicious `.cursor/hooks.json` ran commands on the maintainer's machine when they ran the review. Cursor closed the report as out of scope (July 2026). The researcher's mitigation: review the diff, do not check out the branch. |
| Anthropic Code Review (managed) | Not documented | Fork PRs are never reviewed automatically. A user with write access to the base repo must comment. Pushes and check re-runs do not start a review on a fork. |
| CodeRabbit, Greptile, Copilot, Qodo | Not documented | |
| GitHub Agentic Workflows | Workflow definitions compile to `.lock.yml` in `.github/workflows/`, which GitHub itself only runs from the base | See below. |

### Incidents

- **CVE-2026-47751** (claude-code-action under 1.0.74, published 2026-07-16, CVSS 4.0 base 5.3): the action checked out the PR head and read `.mcp.json` from it with `enableAllProjectMcpServers`, so a PR could run arbitrary MCP servers on the runner and read workflow secrets. Fixed by restoring config from the base branch. The CVSS score looks low for the impact; aggregators disagree.
- **claude-code-action permission bypass** (disclosed June 2026): any GitHub App actor passed the write check. The example workflow shipped `allowed_non_write_users: "*"`.
- **Cursor local review hooks** (July 2026, see above).
- **Comment and Control** (April to May 2026): PR title injection against Anthropic's security action, Gemini CLI Action and Copilot Agent leaked API keys.
- **GitLost** (Noma Labs, July 2026): prompt injection against a GitHub Agentic Workflow leaked repository data through over-broad read access. No secrets were taken.

### Claude Code specifics that matter for your custom reviewers

- Plugin subagents ignore `hooks`, `mcpServers` and `permissionMode` frontmatter.
- Project agents in `.claude/agents/` load frontmatter hooks only after folder trust (v2.1.218) and inline MCP servers only after folder trust (v2.1.238). A `-p` run is not trusted, so in CI those do not run.
- If the parent runs in `bypassPermissions`, `acceptEdits` or auto mode, the subagent inherits it and ignores its own `permissionMode`. A CI reviewer in a permissive mode must restrict `tools` or use `disallowedTools` or deny rules. It cannot rely on per-agent `permissionMode`.
- A `tools` allowlist that includes Bash can still change files. Read-only means Read, Grep, Glob only, or a PreToolUse hook, or deny rules.
- A tool allowlist is only a sandbox if the agent definitions come from a trusted branch.

### GitHub Agentic Workflows security model

Technical preview 2026-02-13, public preview 2026-06-11. Agents are Markdown with frontmatter in `.github/workflows/`. The `gh aw` CLI compiles them to a standard Actions workflow. By default the agent is read-only and holds no secrets. LLM tokens live in an isolated API proxy. MCP credentials live in a separate gateway container. The agent runs on a private network with egress through a Squid allowlist proxy. It reads GitHub through a read-only MCP server. Writes are staged through a "safe outputs" MCP server and vetted after the agent exits: authors cap write types and counts (for example, at most three PRs per run) and sanitize content (for example, strip URLs). A threat-detection stage uses a prompted model, so it is not fully deterministic. On public repos, `min-integrity` defaults to `approved` (owners, members, collaborators); `merged` accepts only default-branch content; `none` accepts hostile input.

### What this implies for a design

1. Load every reviewer definition, rule file and tool config from the base branch. Keep the PR's copies in a separate directory the reviewer can read as data, never as instructions.
2. Run reviewers read-only. Give them Read, Grep, Glob and a diff. Put posting in a separate step or job that holds the token.
3. Treat the PR title, body, commit messages, branch name and diff as untrusted input. Delimit them. Strip HTML comments and invisible characters.
4. Never review fork PRs automatically. Require a write-access human to request it.
5. Reject bot actors unless allow-listed, to stop loops.
6. If a custom reviewer needs Bash, decide explicitly whether that is allowed on PRs from outside the team.

## 4. Fast path for small PRs

### Who does what

| Tool | Decision signal | Cheaper path |
|---|---|---|
| Qodo (adaptive router, 2026) | A lightweight classifier reads risk and scope: logic complexity, uncertainty, blast radius, hunk count | Skip (no logic: lockfiles, comment fixes, formatting), Fast (single pass, light model), Balanced (one full pass, default), Deep (several passes across models) |
| Cloudflare | Line count plus security paths | Trivial under 10 lines: 2 agents. Lite under 100: 4. Full: 7+. `auth/` and `crypto/` always full |
| Anthropic Code Review | PR size and complexity, thresholds not published | "Trivial ones get a lightweight pass." Automatic triggers skip drafts and forks. REVIEW.md can add skip rules and a higher bar for low-priority paths |
| Anthropic `code-review` plugin | A Haiku agent judges closed, draft, automated, trivial, or already reviewed | Stop before any reviewer runs |
| Cursor Bugbot | `review.effort`: low, default, high, or `smart`, where a prompt picks the level | Effort levels only on usage-based plans. Drafts off by default. `triggers.frequency: oncePerPr` |
| CodeRabbit | Metadata only: `drafts` false by default, `ignore_title_keywords`, `labels` with `!` negation, `ignore_usernames` for bots, `base_branches` | `profile`: quiet, chill (default), assertive. Incremental review pauses after 5 reviewed commits. `path_filters` with default excludes |
| Qodo / PR-Agent | Metadata: title regex, branch regex, labels, authors, GitHub bot detection | Drops extra patch context on large PRs |

### Qodo's lessons, the only published routing data

- Their first router used diff size and scored about 4% below a fixed baseline. Hunk count (how dispersed the change is) and semantic content worked better.
- Uncertainty routes to a deeper review, not a lighter one.
- Skip and Fast are removed for very large diffs. Deep needs minimum line and hunk thresholds.
- If the classifier times out, errors or returns bad output, the PR falls back to a safe tier.
- A regenerated lockfile with thousands of changed lines is a Skip. Size alone would have sent it to Deep.
- No numeric cutoffs published.

### Findings rate versus size

Anthropic's internal data: 31% of PRs under 50 lines get findings (0.5 on average) versus 84% over 1,000 lines (7.5 on average). The small-model paper found Haiku's F1 fell from 0.657 under 10 lines to 0.043 over 150 lines, so quality per finding also drops with size. Both support a cheap path for small PRs and a split or deeper path for large ones.

### The opposite failure

Small PRs that touch security, migrations or permissions. Cloudflare forces full review by path. Qodo protects "sensitive logic" by content, with no path override described. Anthropic's REVIEW.md can raise the bar per path. Nobody published a case study of a trivial-looking PR that caused an incident after a light review.

## 5. Evaluation harness

### Public datasets you can reuse

| Set | Size | Labels | License | How to run | Flaws |
|---|---|---|---|---|---|
| ReviewBench (GitHub + Microsoft, 2026-10-05) | 219 PRs, 187 repos, 19 languages. TypeScript 68, Python 41, C# 25, Go 19, JS 15. 78 PRs over 1,000 lines, only 17 at 50 or fewer | Per finding: `tp_fp`, `severity`, `category`, `scope` (introduced-by-pr), `difficulty`, `context_required` (for example diff-plus-related-files), three justification fields, `producer`, `source.type` | MIT repo; golden data license not stated separately | Clone, `npm ci`, `scripts/try-agent.sh <image>`, then `npm run judge`. Defaults to a 25-PR test set; `--set full` for all. You pick and pay for the judge | Weighted toward large PRs, so it does not test a small-PR fast path. Many golden findings were produced by Claude Sonnet 4.6 and the official judge is Sonnet 5, so a Claude-based reviewer may be favored. Corpus is closed to new PRs. GitHub ran competitor entries itself |
| Martian Code Review Bench (Feb 2026) | 50 PRs, 10 each from Sentry, Grafana, Cal.com, Discourse, Keycloak. 173 golden comments | Severity: Medium 61, High 54, Low 46, Critical 12. Category: bug 94, concurrency 14, api 13, security 11, style 10, doc_defect 9, data 7, perf 6, speculative 5, test_gap 4 | MIT | Fork the 50 PRs into an org with your tool installed, let it review, add the tool name to the config, run the pipeline. Judge prompt is in `offline/code_review_benchmark/step3_judge_comments.py` | Small. Judge-swap moves rankings up to 2 places. Online track needs 600 to 1,000 attributable public PRs, so private tools cannot join it |
| c-CRAB (Mar 2026) | 184 PRs, 234 comments, average 418 changed lines | Each comment has a hidden executable test | Not stated | `run_batch_tool_eval.py --tool-results-dir`. No documented path to add a reviewer | Recall only. Mixes the fixer's skill (Claude Code, Sonnet 4.6) into the score. Internal repo-count conflict (67 vs 56) |
| SWR-Bench (FSE 2026) | 1,000 PRs, 12 Python projects, half with changes and half clean | "Change-actions": location, problem, solution. Extracted by Gemini 2.5 Pro, verified by two annotators (kappa 66) | Not checked | | Python only. Best F1 was 19%. Recall drops from 38% with one golden issue to 9% with five or more |
| Qodo benchmark | Injected bugs plus AGENTS.md violations in real merged PRs | | Public on GitHub and Hugging Face | | Vendor-run, default configs |
| CRQBench | 100 C++ reasoning questions | | | | Not a review-finding benchmark |

### ReviewBench agent contract, in brief

One fresh container per PR. Mounted: the repo at head with `.git` (shallow, frozen, no other branches, LFS pointers only), `diff.patch` as a three-dot diff, `pr.json` with title and body. Env vars: `RB_BASE`, `RB_HEAD`, `RB_OUT`, `RB_CONFIG_<KEY>` for each manifest setting, `RB_MODEL_BASE_URL`. No GitHub API and no token. Output: one JSON with `findings[]` of `file`, `start_line`, `end_line`, `message`, `producer`. One entry per logical issue. The judge matches on `message`, so vague messages score badly. Linux amd64, 15 minutes per PR, egress only to declared hosts on 443. A run is all or nothing. Truncated JSON output was their most common failure.

This contract is a good template for your own harness: diff plus checkout in, one findings file out, no network to GitHub.

### Building a private golden set

Evidence here is thin. What survived:

- **Mining human comments is low yield.** In Atlassian's offline set (1,468 PRs, 2,894 human comments), only about 4% of LLM comments aligned with a human comment and about 7% of PRs had one aligned comment. The LLM reviewer wrote bug comments at 2.8x the human share and maintainability at 1.4x, while humans wrote more about readability and design. A set mined from human comments under-represents what an LLM reviewer finds. (Single source, not voted.)
- **"Resolved in the same PR" is a noisy label.** Atlassian found 36% to 43% of accepted human comments led to a code change, and design comments resolve later. (Refuted on exact numbers, direction stands.)
- **Pool candidates from several sources**, then validate. ReviewBench pooled humans, author follow-up commits, static analyzers and several LLM families, deduplicated, had a judge classify, then had senior engineers re-label. 47 findings first marked true were corrected by hand.
- **Mix real PRs with any synthetic ones.** Synthetic injection gave F1 0.847 versus 0.066 on real PRs for the same model.
- **Size.** Anthropic: start with 20 to 50 tasks from real failures. Early changes have large effects. Ellipsis: about 30. Grow the set as effects get smaller.
- **Freshness.** Martian's reason for an online track is that static sets leak into training data. Nobody published a refresh cadence.

### Scoring

- **Match, then judge.** A deterministic first pass (same file, line window of 5 to 10, compatible category) resolves most matches. The small-model paper's pass resolved about 70%. Then one LLM call per ambiguous pair: "do these describe the same underlying issue?" Partial matches can count 0.5.
- **Do not use a holistic score.** SWR-Bench: a hit-based judge agreed with human pairwise preference at kappa 53 to 62, about the same as humans with each other (56 to 63). A holistic 1 to 10 judge got 31 to 45. BLEU was worse than chance. Per-finding hit decisions agreed at kappa 71 to 87 across human and LLM pairs.
- **One judge call is enough.** Majority voting of 3 gave only a small gain in SWR-Bench.
- **Isolate judge dimensions.** Anthropic: one call for match or no match, a separate call for severity agreement. Give the judge an "Unknown" option.
- **Report grounded recall as the headline.** ReviewBench's reason: augmented recall's denominator changes with each system's own findings, so it is a per-system diagnostic only.
- **Severity weighting** used by one paper: critical 4x, high 2x, medium 1x, low 0.5x.
- **Same-vendor bias is untested.** Every public harness uses a Claude or Gemini judge and nobody measured whether a Claude judge favors a Claude reviewer. Use a second judge from another family on a sample.
- **Per-stage measurement.** Atlassian ablated stages: an actionability classifier trained on 50k comments labeled by resolution raised human-aligned comment rate by about 20 points; their LLM factual-correctness filter had minimal effect. Log every dropped candidate with the stage and reason, as Ellipsis and the Anthropic security action do, so you can score finders and verifiers separately.

### Running it

- **Repeat reviewer runs.** SWR-Bench: five runs of the same model hit only 27 golden items in common; combining 10 runs raised recall 119%. One run is a noisy measurement. Another study found aggregate repeatability varies by model: sigma 0.2 points for Opus 4.6, 3.5 for Sonnet 4.6. No source gives a required repeat count.
- **pass@k versus pass^k.** Anthropic: at 75% per trial, pass^3 (all three succeed) is 42% and pass@3 (any succeeds) is 98%. Use pass^k when a known bug must be found every time.
- **Cost.** A full SWR-Bench judge run cost about $1.57. Braintrust recommends a sampled subset on PRs (`--first N` or `--sample N`) and the full set on merge.
- **CI gating.** promptfoo exits 100 on any failure or below `PROMPTFOO_PASS_RATE_THRESHOLD` (default 100%), and its docs also show a jq script that exits 1 under 95%. Its Actions example triggers only on `prompts/**`, which would miss orchestration and model changes. Braintrust's `bt eval` fails only on exceptions; a score gate needs a custom reporter or a script over `--json`. Neither tool compares against a baseline or handles repetition for you.
- **Human spot checks.** Anthropic's research team still caught failures the judge missed.

### Offline to online

- GitHub has one case where ReviewBench predicted the direction of an online ensemble test (critical comments +227% predicted, +262% observed; addressed rate +8%, recall +13.6%, volume +61%, cost -8%).
- Atlassian's offline results were mostly not significant while its online test was positive (31.9% to 41.9%). Its internal online test was tiny (34 runs with context).
- Cursor pairs an offline set called BugBench with online resolution rate and ran 40 experiments in six months. Many regressed. No correlation numbers.
- Martian made online its headline after offline and online rankings diverged. On 2026-10-06, online F1 put Cubic first and Copilot fourth; offline F2 put Qodo first and Copilot fifth.
- Online metric definitions in use: Uber re-runs the reviewer 5 times on the final commit and calls a comment addressed if none reproduces it. Atlassian's Code Resolution Rate is the share of comments where the commented lines changed in the next commit. Cursor and GitHub use an LLM judge at merge time. Atlassian excludes dismissed comments.

Takeaway: use the offline set to catch regressions and to compare variants, then confirm with an online addressed rate. Do not expect offline deltas to predict online deltas in size.

## 6. Open questions

1. Does a Claude judge inflate scores for a Claude reviewer? A cross-vendor judge on a sample would answer this cheaply.
2. How many repeats and how many PRs detect a given change in grounded recall for current Claude models? No source gives numbers.
3. Which signals should a fast-path classifier use? Qodo says hunk count and semantics beat line count but publishes no thresholds. This is testable on your own PRs once a golden set exists.
4. How should a repo-defined reviewer with Bash be treated on a PR from outside the team? No vendor has published a policy beyond "do not review forks automatically."

## 7. Sources

Primary, verified by 3 agents unless noted:

- Anthropic Code Review docs: https://code.claude.com/docs/en/code-review (read directly)
- Anthropic GitHub Actions docs: https://code.claude.com/docs/en/github-actions (read directly)
- claude-code-action security doc: https://github.com/anthropics/claude-code-action/blob/main/docs/security.md (read directly)
- claude-code-security-review source, `findings_filter.py`, `claude_api_client.py`, `prompts.py`, `docs/`: https://github.com/anthropics/claude-code-security-review (read directly)
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- CVE-2026-47751: https://nvd.nist.gov/vuln/detail/cve-2026-47751 and https://github.com/anthropics/claude-code-action/security/advisories/GHSA-8q5r-mmjf-575q
- CodeRabbit custom checks: https://docs.coderabbit.ai/pr-reviews/custom-checks; path instructions: https://docs.coderabbit.ai/configuration/path-instructions; auto review: https://docs.coderabbit.ai/configuration/auto-review; config reference: https://docs.coderabbit.ai/reference/configuration (read directly)
- Greptile custom standards: https://www.greptile.com/docs/code-review/custom-standards
- Cursor Bugbot docs: https://cursor.com/docs/bugbot (read directly); learned rules: https://cursor.com/blog/bugbot-learning; building Bugbot: https://cursor.com/blog/building-bugbot
- Cursor local review hooks disclosure: https://lumia.security/blog/cursor-bugbot-remote-code-execution (single source)
- Qodo adaptive router: https://www.qodo.ai/blog/building-an-adaptive-router-for-code-review-depth/ (single source); custom compliance: https://docs.qodo.ai/qodo-documentation/code-review/qodo-merge/features/custom-compliance; config options: https://docs.qodo.ai/qodo-documentation/code-review/qodo-merge/configuration/configuration-file/configuration-options
- GitHub Agentic Workflows: https://github.blog/changelog/2026-02-13-github-agentic-workflows-are-now-in-technical-preview/, https://github.blog/2026/03/09/under-the-hood-security-architecture-of-github-agentic-workflows/, https://github.github.com/gh-aw/introduction/architecture/
- ReviewBench repo, `AGENT_CONTRACT.md`, `golden/`: https://github.com/review-bench/ReviewBench (read directly); blog: https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/
- Martian Code Review Bench: https://github.com/withmartian/code-review-benchmark
- c-CRAB: https://arxiv.org/html/2603.23448v3
- SWR-Bench (FSE 2026): https://arxiv.org/pdf/2509.01494
- Small-model review paper: https://arxiv.org/html/2606.15689v1 (single source)
- Anthropic, "Demystifying evals for AI agents" (2026-01-09): https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Atlassian, which comments developers resolve: https://www.atlassian.com/blog/how-we-build/atlassian-rovo-dev-research-what-types-of-code-review-comments-do-developers-most-frequently-resolve (partly refuted on numbers); PR context experiment: https://www.atlassian.com/blog/development/improving-code-reviewer-with-pr-context
- Uber uReview: https://www.uber.com/en-US/blog/ureview/
- promptfoo CI: https://www.promptfoo.dev/docs/integrations/ci-cd/ (2-1 vote); Braintrust CI: https://www.braintrust.dev/docs/evaluate/run-in-ci (2-1 vote)
- Review-comment benchmark mining paper: https://arxiv.org/html/2408.08453v1 (refuted on numbers)

Refuted by verifiers, do not use: ReviewBench "352 golden findings" count; "Qodo compliance checklist goes to a single reviewer pass"; "Anthropic Code Review has no fast path" (the docs do describe a lightweight pass); the Martian online-track pipeline description; Atlassian resolution percentages by category.
