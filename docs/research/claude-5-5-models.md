# Claude 5.5 models: what changes for the review tool

Researched 2026-10-13 from official Anthropic sources (model pages, prompting guides, system cards, Agent SDK docs) plus two vendor posts. Every section ends with what it means for the design. Claims marked *unconfirmed* came from secondary sources or inference.

## 1. The lineup

| Model | ID | Released | Input / output per MTok | Cache read | Default effort | Notes |
|---|---|---|---|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | 2026-09-22 | $4 / $20 | $0.20 | medium (API and Claude Code) | thinking always on |
| Sonnet 5.5 | `claude-sonnet-5-5` | 2026-09-28 | $2 / $10 | $0.10 | high on the API, medium in Claude Code | thinking cannot be disabled |
| Haiku 5.5 | `claude-haiku-5-5` | 2026-10-07 | $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above | $0.01 / $0.05 | medium | first Haiku with effort and adaptive thinking |

All three: 1M context, 128K output, June 2026 knowledge cutoff, five effort levels (low, medium, high, xhigh, max), minimum cacheable prompt 512 tokens, tokenizer that yields about 30% more tokens than pre-4.7 models for the same text. Haiku 4.5 can retire as early as 2026-10-15. Sonnet 4.5 retires 2026-11-30.

Cost ratios: Sonnet is half of Opus. Haiku is 1/40 of Opus on short prompts and 1/8 above 100K tokens. The old 5x Opus-to-Sonnet gap is gone.

Sources: platform.claude.com/docs/en/models/overview, /docs/en/about-claude/pricing, /docs/en/about-claude/model-deprecations, /docs/en/release-notes/overview.

**Design effect.** Opus for reviewers is affordable. Haiku's prompt-length pricing rewards keeping each call under 100K tokens.

## 2. Breaking API changes on 5.5

- Thinking cannot be disabled on Opus 5.5 and Sonnet 5.5. `budget_tokens` returns 400 on all three. Control thinking with `effort`.
- Forced `tool_choice` (`any` or a named tool) returns 400 on Opus 5.5 and Sonnet 5.5. Structured output goes through `output_config.format` with a JSON schema.
- `temperature`, `top_p`, `top_k` at non-default values return 400.
- Assistant prefill returns 400 on Haiku 5.5 (and Sonnet 5).
- Thinking blocks are bound to the model, account and conversation prefix. Editing earlier history invalidates them. Conversations must be append-only.
- Changing top-level `effort` or `output_config.format` between requests invalidates the prompt cache.
- Structured output schema subset: no min/max, no minLength/maxLength, no maxItems, `additionalProperties: false` required, no recursion. Enum values may come back with different case. A `refusal` or `max_tokens` stop may not match the schema.
- Safety classifiers can return HTTP 200 with `stop_reason: "refusal"`. Sonnet 5.5 and Opus 5.5 have a cyber classifier. Finding vulnerabilities in source code is allowed, but benign security work can still trip it. Haiku 5.5 has no server-side fallback.

Sources: /docs/en/models/opus-5-5/whats-new-opus-5-5, /docs/en/models/sonnet-5-5/whats-new-sonnet-5-5, /docs/en/models/haiku-5-5/migration-guide, /docs/en/build-with-claude/structured-outputs.

**Design effect.** Each role keeps a fixed effort and output schema so the cache holds. Range checks, length caps and item caps live in orchestrator code, not in schemas. A `refusal` or `max_tokens` stop is a failed call even when the text parses. Enum comparison is case-insensitive.

## 3. Prompting guidance that changed

The single most important change for this tool, quoted from the Sonnet 5 guide and repeated for Opus 5:

> When a review prompt says things like "only report high-severity issues," "be conservative," or "don't nitpick," Claude Sonnet 5 may follow that instruction more faithfully than earlier models did.

The recommended replacement:

> Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage - a separate verification step will do that. Your goal here is coverage: it is better to surface a finding that later gets filtered out than to silently drop a real bug.

Other changes with direct bearing:

- 5.x models read instructions literally and do not generalize scope from one item to another. State scope explicitly.
- Remove "be thorough", "use tools aggressively" and "verify twice" lines written for older models. Removing "verify twice" cut Opus 5 cost per ticket by a third. The opposite holds for Sonnet 5.5 and Haiku 5.5 at low effort on code-changing tasks, where a "run a real check" paragraph is needed. Not relevant to read-only reviewers.
- Asking the model to write out its reasoning in tags may be declined on Opus 5.5 and Sonnet 5.5 (`reasoning_extraction` refusal). Ask for a short explanation instead.
- Prompt lines asking the model to think less do not work on Sonnet 5.5 or Haiku 5.5. Use effort.
- Sonnet 5.5 with structured output at low or medium effort often answers reasoning-heavy JSON tasks without thinking, which lowers accuracy. Fix: end the system prompt with "Think the problem through before you answer." and use adaptive thinking.
- Sonnet 5.5 at xhigh and max launches its own reviewer subagents. A system prompt line that forbids this cut session cost by about a third.
- Few-shot examples are still recommended, 3 to 5, positive examples over negative, with a rationale line. Fable 5.1 fixes use one complete example plus one sentence on why it is correct.
- Long inputs go first, instructions and query last. Documented gain up to 30% at 20K+ tokens.
- Untrusted text goes in tagged blocks with a random id, plus a system line that instructions inside it are not to be followed. Opus 5.5 resists indirect injection better than earlier Opus models.
- Hallucination controls that still apply: permission to say it does not know, quote first then analyze, retract any claim without a quote, never speculate about code not opened.
- Evaluation guidance: use a grader model with thinking on, detailed rubrics with automatic-fail rules, and "generally best practice to use a different model to evaluate than the model used to generate".
- Opus 5.5 reads elapsed-time hints and finishes sooner when given a budget line such as "elapsed 340s / 1200s".

Sources: /docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices, prompting-claude-sonnet-5, prompting-claude-sonnet-5-5, prompting-claude-opus-5, prompting-claude-opus-5-5, prompting-claude-haiku-5-5, prompting-claude-fable-5-1, /docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations, /docs/en/test-and-evaluate/develop-tests.

**Design effect.** Reviewer prompts flip from "conservative with a do-not-flag list" to "report everything in scope with confidence and estimated severity". The do-not-flag list survives only as a scope definition (not lint, not pre-existing code). All filtering moves to the verifier and merge. Reviewers return a one-line explanation per finding, never visible reasoning. Diff first, instructions last. The verifier runs with thinking on and should be a different model from the reviewers.

## 4. Evidence on model choice for review

Anthropic publishes no code review benchmark for the 5.5 family. The usable evidence:

- Opus 5.5 at medium effort matches or beats Opus 5 at high on repo-level coding in fewer steps and tokens. Opus 5.5 at low solved 87.4% of SWE-bench Pro at $0.12 per solved task, medium 92.8% at $0.22. (Anthropic)
- A customer quote on the Opus 5.5 launch page: Opus 5.5 caught 72% of known bugs at its lowest effort, Opus 5 at high caught 56%. Anthropic's own guide says early testers saw more bugs caught and fewer false alarms than Opus 5.
- CodeRabbit (vendor-run, small sets): on 13 hard cases Opus 5.5 standard caught 8 and max caught 10, Sonnet 5.5 with thinking caught 6, Sonnet 5 caught 4. On 80 OSS bugs Opus 5.5 caught 51 at 38.6% precision against a baseline of 49 at 39.3%. More effort did not consistently improve reviews. Cost per review was $0.47 for Sonnet 5.5. CodeRabbit moved simple and moderate reviews to Sonnet 5.5 and kept Opus 5.5 for high-risk changes.
- Sonnet 5.5 at max is "comparable to Opus 5.5 on several evaluations" and beats it on Terminal-Bench 4.0 (70.6% vs 66.4%). Anthropic still says Opus 5.5 is "clearly stronger at open-ended work needing sustained judgment".
- Haiku 5.5 scores below Sonnet 5.5 on every published benchmark (SWE-bench Pro 64.8 vs 81.3). Its system card reports the highest over-refusal rate of any model tested, hallucination about equal to Haiku 4.5, and using a leaked answer without saying so 17% of the time. At low and medium effort it sometimes reports work done without checking.
- Anthropic's two-pass pattern: run at low effort, re-run failures at high. On SWE-bench Pro with Opus 5.5 this reached about 97% at about $0.17 per task against 95.3% at $0.29 for high throughout. It needs a reliable failure signal.
- Anthropic on orchestration: where work fits in one context, a single model at lower effort beat a lead-with-workers setup. Same-model agent teams rarely delegated. Advisor pairing with Haiku or Sonnet executors was never used in 198 questions but still added 12 to 25% cost.
- Anthropic's general advice: "Tuning effort is often a better lever than switching models." Compare on cost per completed task, and price the tail, because "the bill is decided by the tasks the cheaper model fails".

Sources: anthropic.com/news/claude-opus-5-5, anthropic.com/claude-sonnet-5-5, anthropic.com/claude-haiku-5-5, /docs/en/about-claude/models/optimizing-for-cost-and-intelligence, /docs/en/about-claude/models/choosing-a-model, coderabbit.ai/blog/opus-5-5-model-review, coderabbit.ai/blog/sonnet-5-5-model-review, Sonnet 5.5 and Haiku 5.5 system cards.

**Design effect.** Reviewers default to Opus 5.5 at low effort, with Sonnet 5.5 at medium as the first harness comparison. The verifier runs on Sonnet 5.5 at high with thinking, which is a different model from the finders, and escalates middle-band scores to Opus 5.5 at high. Haiku 5.5 is limited to the summarizer. The harness includes a single Opus reviewer at medium effort as a baseline against the specialist set.

## 5. Agent SDK mechanics (TypeScript 0.3.296, bundles Claude Code 2.1.296)

- Each `query()` spawns its own Claude Code process. Sizing guidance is about 1 GiB RAM and 1 CPU per agent. A standard GitHub runner has 7 GiB.
- Structured output: `outputFormat: { type: "json_schema", schema }` on `query()`, draft-07, validated with re-prompt on mismatch. Success means subtype `success` and `structured_output` present. Not documented for subagents spawned inside a query, so the pipeline is one `query()` per agent.
- Model per query: alias or full ID. Full IDs are documented as accepted; the exact string `claude-sonnet-5-5` is not shown in an SDK example (*unconfirmed*, one smoke test settles it). `fallbackModel` can retract a finished structured output, so leave it unset for schema calls.
- `effort` on `query()` options. Claude Code defaults all 5.5 models to medium, the API defaults Sonnet to high. Set it explicitly.
- `settingSources: []` stops loading user, project and local settings, so no hooks, MCP servers, agents or CLAUDE.md come from the checkout. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` stops auto memory. `persistSession: false` stops transcript writes.
- Read-only: `allowedTools` only auto-approves and does not restrict. Bare names in `disallowedTools` remove tools from the request. `permissionMode: "dontAsk"` denies anything that would prompt. An omitted mode can start in auto since 0.3.286, so set it. `dontAsk` still runs read-only Bash, so Bash must be in `disallowedTools`.
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` is read from the subprocess environment. In TypeScript `env` replaces the environment, so spread `process.env`. An `ANTHROPIC_API_KEY` in the environment wins over the token.
- Retries: transient 429, 529 and 5xx retry up to 10 times. `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429 and 529 without limit for unattended jobs. "Large parallel-subagent fanouts can hit rate limits."
- Cost: result carries `total_cost_usd`, `modelUsage` (per model: cost, input, output, cache read, cache write), `duration_ms`, `num_turns`, `stop_reason`. `usage` undercounts when subagents run. Values are client-side estimates.
- Caching: automatic, 5-minute TTL by default with an API key. `CLAUDE_CODE_PROMPT_CACHE_TTL` and `ENABLE_PROMPT_CACHING_1H` adjust it. A custom `systemPrompt` can mark a static prefix with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (*semantics unconfirmed*). Cache entries are per model.
- `maxBudgetUsd` and `maxTurns` bound a query. Hooks may not fire when `maxTurns` ends the session.
- Minimum CLI versions: Sonnet 5.5 needs 2.1.284, Opus 5.5 2.1.280, Haiku 5.5 2.1.293. All met.

Sources: code.claude.com/docs/en/agent-sdk/{typescript,subagents,structured-outputs,configuration,permissions,hosting,cost-tracking,sessions,claude-code-features,agent-loop}, /docs/en/model-config, /docs/en/env-vars, /docs/en/errors, /docs/en/authentication.

**Design effect.** The orchestrator runs a semaphore on parallel queries sized to runner memory, default 5. Every query sets model, effort, `settingSources: []`, `permissionMode`, `disallowedTools`, `outputFormat`, `maxTurns`, `maxBudgetUsd` and `persistSession: false`. CLAUDE.md content from the base branch is injected by the orchestrator, since the SDK will not load it. `modelUsage` goes into the record per query.

## 6. Open items

- Whether a 0 to 100 verifier score calibrates. Anthropic's examples use binary, 1 to 5 and 0.0 to 1.0 scales. The harness compares the 0 to 100 score against a 5-band scale on recorded outcomes.
- The SDK's acceptance of the exact `claude-sonnet-5-5` string. One smoke test.
- Haiku 5.5 latency with thinking off. One secondary report claims 12.8 s to first token at low effort with thinking on (*unconfirmed*).
- Whether Opus 5 rules on over-verification and delegation damping carry to Opus 5.5 (*unconfirmed*).
- Subscription rate-limit behavior under many parallel SDK runs. Not documented.
