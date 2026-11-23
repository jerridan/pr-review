# The staff-engineer reviewer and refactor recommendations (D16 parts a and c)

This design follows D15 (`docs/research/d15-staff-reviewer.md`) and the decisions of the user: add the staff-engineer reviewer to the tool; it never fails a review; its time limit is 10 minutes, a guard against a hung call; refactor recommendations post as a separate PR comment. Part b, how the reviewer runs in CI, is `docs/research/d16-codex-in-ci.md`. No code exists for this design yet.

## Open questions for the user

1. Reads outside the checkout. The Codex sandbox of `-s read-only` stops writes, not reads. A command that the model runs can read any file that the user of the process can read, and the login file of Codex (`$CODEX_HOME/auth.json`) too. A PR can carry text that steers a reviewer (E6, issue 63). So a steered review could put a secret into the text of a finding, and the text of a finding posts to the PR. The design lowers the risk (see "The sandbox") but cannot remove it, because the tool cannot sandbox reads of the Codex process. Do you accept that risk for your private repos, and do you want the reviewer off for pull requests from forks?
2. Selection. The design makes the reviewer opt-in: it runs when a repo config turns it on, or when a run names it. Do you want it on by default where a logged-in Codex CLI exists?
3. Network. The vendor documents "By default, the agent runs with network access turned off", but not what the read-only mode does when a config turns network on. The design passes no network setting and keeps the user config of Codex out of the run. Is that enough?
4. The verdict. When the reviewer does not run, the verdict of the other reviewers stands. A failed Claude reviewer makes the verdict `incomplete` today (section 3.7). The staff-engineer reviewer is the one exception. Do you agree?

## Part a: a reviewer through the Codex CLI

### Declaration

The reviewer is a built-in prompt file in `prompts/reviewers/`, with one new frontmatter key: `kind: codex`. A reviewer with no `kind` is a Claude reviewer, as today. The file of D15 (`prompts/staff-reviewer.md`) moves to `prompts/reviewers/staff-reviewer.md`:

```
name: staff-reviewer
description: A skeptical staff engineer who judges the design of the change and its fit with the codebase.
kind: codex
model: gpt-6.2-sol
effort: medium
opt_in: true
passes: 1
threshold: 80
triggers: { paths: [], categories: [], min_tier: full }
```

`kind: codex` is for built-in reviewers only. A custom reviewer of a repo (`.pr-review/reviewers/*.md`) with `kind: codex` is a config error, because that file comes from the code under review.

The code changes that this needs:

- `ReviewerFrontmatterSchema` gets the optional key `kind` (`claude` or `codex`). For `kind: codex`, `tools` is optional and not used, because Codex reads the checkout with shell commands in its own sandbox.
- `parseReviewer` and `effectiveModel` do not run `resolveModel` (the Claude model aliases) for a Codex reviewer. They take the model id as written. `effort` is checked against the Codex set (low, medium, high, xhigh, max), not the Claude set.
- `reviewers.staff-reviewer.model` and `.effort` in the repo config change the model and the effort, with the same rules.
- The pin: `gpt-6.2-sol` is the model of D15. `CODEX_MODEL` of the eval (`gpt-6.1-sol`) stays the eval's own default and does not change.

### Selection

The selection of section 3.3 runs as today: tier, then triggers. An opt-in reviewer is selected when the run names it (`--reviewers`) or when the repo config sets `reviewers.<name>.enabled: true`. The second rule is new. Today `enabled` defaults to true in `ReviewerEntrySchema`, so a parsed config cannot tell a value that the repo set from the default. The schema makes `enabled` optional with no default, and the code treats "absent" as true for a reviewer that is not opt-in and as false for an opt-in one. `skipSelected` keeps its rule for `enabled: false`.

The min tier is `full`. A run at the fast tier does not select the reviewer, and the record lists it in no list, as for any reviewer that the tier does not select.

### Which runs

The reviewer runs on a first run and on a fresh run only, as the cleanup comment does (`fullScope` in `src/github/post.ts`). A later run reviews only the new hunks and looks only for blocking problems (section 3.9), and a design review of a few new hunks says little. On a later run the reviewer is not selected, and the refactor comment is not touched.

### The run

The find stage of section 3.4 starts the Codex reviewer beside the Claude reviewers. It is one `codex exec` process, not an SDK query, so it takes no slot of the SDK concurrency limit. Its findings, and the truth checks of part c, take verifier slots as all findings do.

1. Find the CLI: look for `codex` on `PATH`. Absent: skip with the reason `codex not installed`.
2. Find the login state: run `codex login status`. The vendor documents that it "exits with 0 when logged in". Any other exit: skip with the reason `codex not logged in`. The tool does not parse the output, reads no credential and reads no file of the Codex home.
3. Run the review, as in D15 (`src/eval/codex.ts`, moved out of `src/eval/`): `codex exec --ephemeral --ignore-user-config --skip-git-repo-check -C <tree> -s read-only -m <model> -c model_reasoning_effort=<effort> --output-schema <file> -o <file> <prompt>`. `<tree>` is a copy of the head tree with no `.git` folder (see "The sandbox").
4. The prompt: the reviewer body, the rules block and the reviewer user message, as in D15. The description block, the diff and the triage brief are in the same untrusted-data wrappers as for the Claude reviewers.
5. The time limit: 10 minutes by default; `reviewers.staff-reviewer.timeout_minutes` in the repo config, an integer of 1 or more, in the config table of section 4. It is a guard against a hung call, not a performance target: in D15 the reviewer took 57 s at the median and 102 s at the maximum. The eval's limit of 15 minutes (`CODEX_TIMEOUT_MS`) does not apply here. The process starts in its own process group, and at the limit the tool kills the whole group, so no command that Codex started lives on. The call reports that it timed out as its own outcome. The review waits for the reviewer up to the limit, so a hung call makes one review take 10 minutes.
6. The outcome:
   - exit 0 and an output that passes the schema: the reviewer ran, and its findings join the others;
   - stderr shows the quota stop (`codexQuotaError`): it did not finish, reason `codex quota`;
   - killed at the limit: it did not finish, reason `codex timeout`;
   - any other failure: it did not finish, reason `codex failed`, with the end of stderr (2000 characters) in the record.

### It never fails a review

A Codex reviewer that does not run or does not finish is not a failure of the review. The review goes on with the other reviewers, and the verdict stays theirs: the rule "a failed reviewer makes the verdict incomplete" has an explicit exception in the code for `kind: codex`. The coverage line of the summary names the reviewer and its reason, for example: "The staff engineer review did not run: codex timeout (10 minutes)."

In the record, a reviewer that was not started (not installed, not logged in) goes to `reviewers_skipped`. A reviewer that started and did not finish (quota, timeout, failed) goes to `reviewers_failed`. Neither is in `reviewers_ran`. `SkippedReviewerSchema.reason` gets the new values.

### Findings

The findings pass the quote and line checks first, as the findings of every reviewer do, so a finding with a bad quote goes to `dropped`. Then the [refactor] findings leave the list (part c). The rest go through the same verifier, merge and cap as the other findings. Each claim keeps its tag ([design], [boundary], [edge-case], [scope], [performance], [security-tradeoff]), which maps to a category of the finding schema, as in D15.

### The sandbox

The code of a PR is not trusted, and E6 showed that text in a PR can steer a reviewer.

- `-s read-only`: the commands that the model runs cannot write. The vendor documents Seatbelt on macOS and bwrap with seccomp on Linux as the enforcement. The commands can read any file that the process user can read: the read-only mode does not limit reads (open question 1).
- A tree with no `.git`: Codex runs on a copy of the head tree, made with `git archive` of the head commit, with no `.git` folder. So a token that a checkout keeps in `.git/config` is not in its tree. (The workflows of this repo already check out with `persist-credentials: false`.)
- A small environment: the process gets `PATH`, `HOME` and `CODEX_HOME` only, not the environment of the run. So no token that the run holds in its environment reaches Codex.
- Network: the vendor documents "By default, the agent runs with network access turned off". The key that turns it on (`sandbox_workspace_write.network_access`, default false) is for the workspace-write mode. The tool passes no network setting, and `--ignore-user-config` keeps a user config from turning it on (open question 3).
- Writes: the schema and the output file are in a temp folder of the tool, outside the tree. `--ephemeral` stores no session.
- Output text: every text of a Codex finding that can post (claim, explanation, suggested fix) passes `redact` before it posts or goes to the record. `redact` today removes GitHub tokens and a credential in a URL. It gets the token forms of the vendor: an API key (`sk-` followed by key characters) and a JWT (three base64url parts with `eyJ` at the start), which is the form of the tokens in the login file.
- A finding still needs an exact quote of the head file, so an injected instruction cannot add a finding that the verifier does not check.

### The record

- `stages.reviewers[]` gets an entry for the Codex reviewer with `kind: "codex"`. The entry keeps the fields that all entries have (`name`, `pass`, `status`, `findings`, `dropped`), and its `meta` holds the model, the effort, the token count that Codex prints, the wall time and the exit code, with no `costUsd`. For a failure, it holds the reason and the end of stderr. `QueryMeta` and the entry schema get these fields as optional fields for `kind: "codex"`.
- `cost.queries` gets a row with the role `codex-reviewer` and no cost. `queries_without_cost` counts it, so `total_cost_usd` says that it holds no Codex cost. The run-level `token_ceiling` does not count Codex tokens, because they are not plan tokens.
- The tool stores no part of a login.

### Where it runs

- Local CLI and the plugin: the reviewer runs when the user's machine has a logged-in Codex CLI. This is option D of part b.
- CI: the reviewer runs when the job has a logged-in Codex CLI (options A, B or C of part b). With none, it skips with its reason, and the review goes on.

## Part c: refactor recommendations on their own path

D15 showed that the verifier rejects or holds back 3 of 4 refactor recommendations. The verifier checks that a finding is introduced by the change, and a refactor recommendation is about existing code by design.

### The path

1. Split: after the quote and line checks, a finding whose claim matches `^\[refactor\] ` (lowercase, in square brackets, then one space, as the prompt asks) leaves the findings list. It never reaches the verifier, the merge, the cap or the review. A claim with no known tag stays in the findings list, and the record counts it as "claim with no tag", so a drifted tag shows up.
2. Limit first: of the recommendations, the two with the highest reviewer confidence (ties by the order of the reviewer) go on, and the rest are kept in the record only. The prompt asks for at most two, and this step enforces it before any call.
3. Truth check: one call for each of the two, with a new prompt, `prompts/verifier-refactor.md`, and its own schema. It checks the facts only: that the quote is in the head file, that the old code that the claim names exists, and that it forces the workaround that the change shows. It does not judge that the refactor is worth doing, and it has no rule on "introduced by the change". Its result is `{ holds, score, quotes, rationale }`. A recommendation passes when it holds and its score is at the threshold or above. The calls use verifier slots of the `concurrency` limit. The truth form of replay (`prompts/verifier-truth.md`) is not used: it still asks "in scope" and "introduced by the change".
4. The comment: one PR comment, outside the review, with the hidden marker `<!-- pr-review refactor -->` (a new `REFACTOR_MARKER` beside `CLEANUP_MARKER` in `src/github/markers.ts`). On a first or fresh run, the tool looks for the comment of its own login with that marker. With one or more passed recommendations, it edits that comment, or creates one when none exists. With none, it edits an existing comment to say that no recommendation is open now, and it never creates an empty comment. The comment is titled "Refactor recommendations" and gives, for each one, the ticket title and lines from the suggested fix, the claim, and a permalink to the lines. `PostedGitHub` gets `refactor_comment_id`. A failed comment goes to `errors`, and the exit code stays 0, as for the cleanup comment.
5. Off switch: `refactor_comment: off` in the repo config. The default is `on` when the staff reviewer runs. With `off`, the split still happens, and the recommendations are kept in the record only.
6. Where it posts: only with `--format github`. A fork PR whose token cannot write a comment gets no comment, and the record notes the skip with its reason. A local run in another format prints the recommendations in their own section.

### The record

A new stage, `stages.refactor`: each recommendation (the finding as the reviewer gave it), whether it passed the limit, its truth-check result (holds, score, rationale, cost), whether it posted, the count of claims with no tag, and the comment id. It is in the record also when the comment is off.

### How the eval measures it

No known-item list holds refactor recommendations, and the user wants no hand labels at scale. The eval counts, from the records, with no model call:

- the recommendations for each case, and the share that passed the truth check (read from `stages.refactor`);
- that the named file and lines exist in the head commit;
- that the evidence quote is an exact quote of the head file;
- that the evidence lines are on added or changed lines of the diff. A context line of a hunk counts as not changed. The prompt asks for "the new code in this change that shows the workaround", so a quote off the changed lines is a defect of the path;
- that each code name that the claim gives in backticks, and that looks like a path or a symbol, exists in the base or the head. A name that the ticket proposes can be new, so this is a count to read, not a defect.

These counts show whether the path posts recommendations that are true and tied to the change. They do not show whether a recommendation is worth doing. Only the user's reading shows that.

## What changes in the code, later

This is a list for the plan, not a spec: `kind` and its schema, loader and model rules; the optional `enabled`; the Codex run in the find stage, moved from `src/eval/`, with the tree copy, the small environment, the process group and the time limit; the skip and failure reasons, the verdict exception and the coverage line; the record fields and the cost row; the extended `redact`; the config keys `timeout_minutes` and `refactor_comment` in the table of section 4; the split, the limit, `prompts/verifier-refactor.md`, the comment and `stages.refactor`; the eval counts of part c. Each part comes with its tests. The eval of D15 runs again on the shipped path before the reviewer is on by default anywhere.
