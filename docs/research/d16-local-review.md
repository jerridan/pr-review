# D16: what it takes to run the review locally instead of in CI

## Open questions for the user

1. Which design do you want to study further: all local, mixed (the six Claude reviewers stay in CI, and the staff engineer reviewer runs on your machine), or a self-hosted runner on your machine? The recommendation at the end is the mixed design, started by a hook when an agent session opens a PR.
2. The staff engineer review once per PR: the design of D16 runs it on a first run or a fresh run only. Is one staff engineer review when the PR opens, and another only when you ask for it, enough?
3. PRs from another machine or the web: must they get the staff engineer review without a request? A hook on your machine does not see them; a watcher does, at a larger cost (section 3).
4. The account that posts: a local review posts under your own GitHub account, not as `github-actions[bot]`, and it posts no check run (section 2). Is that acceptable?
5. Trust: a local review reads the PR on the machine that holds your logins (section 7). You are the only person who pushes, and agent sessions write many PRs. Do you treat those PRs as trusted?

## Question

What would it take for the review to run on the user's machine instead of in CI? The reason: the Codex subscription login refreshes about every 8 days and cannot stay on a GitHub-hosted runner (`docs/research/d16-codex-in-ci.md`), so the staff engineer reviewer cannot run in CI on the subscription with no upkeep. The user is the only person who pushes to these repos, and agent sessions on the user's machine open many of the PRs. The user has not decided; this is a study.

## Method

Reading of the code and the docs on main at 047fb72: `action.yml`, `.github/workflows/review.yml` and `pr-review.yml`, `src/cli.ts`, `src/run.ts`, `src/github/`, `src/record/`, `commands/review.md`, `.claude-plugin/`, README and `docs/design/high-level-design.md`, and two pages of the GitHub documentation. No model call, no Codex call, and no run. One critic round checked the note against the code.

## 1. What runs locally today with no change

- `pr-review run --base <sha> --head <sha>` reviews a diff in a local checkout and prints a table (`README.md:55`). It needs the Claude login (the SDK process finds it) and a checkout with the two commits. It needs no GitHub login.
- `pr-review run --pr <n>` reads the PR through `gh` and reviews it, with `--base` and `--head` from the PR. It needs a `gh` login and a local clone of the repo that holds the base and head commits (`--repo`, default the current folder; `src/run.ts:473-541`).
- `pr-review run --pr <n> --format github` posts the review and the cleanup comment to the PR (`README.md:93`, `src/github/post.ts:113-196`). It is the same command that CI runs. The tool reads no token: every GitHub call goes through `gh`, which finds its own login (`src/github/gh.ts:1-2`). `--fresh` asks for a first-run review on a reviewed head.
- The Claude Code plugin has one command, `/review` (`commands/review.md`). It reviews the branch against its merge base and prints a table, and with `--format github` and an open PR it runs `pr-review run --pr <n> --format github`.

So a person can post a review from a machine today, by hand, from a clone of the repo.

## 2. What depends on CI today

| What | In CI today | What it needs to work locally |
|---|---|---|
| The trigger on each push | the workflow on `pull_request` (opened, synchronize, reopened, ready for review), a `review:` label, or an `@pr-review full` comment (`pr-review.yml:2-8`, `review.yml:45-61`) | a local trigger (section 3) |
| A clone of the repo | a fresh checkout of the PR head, with the base fetched (`review.yml:76-110`) | a clone of each repo on the machine, a fetch of the PR head (`refs/pull/<n>/head`) before each run, and a map from a repo name to its clone |
| Two runs on one PR | the concurrency group `pr-review-<n>` with `cancel-in-progress: true` (`review.yml:32-34`). The code has no lock | a lock in the local trigger. The Codex reviews need one lock for the whole machine, not one for each PR: one Codex login file must not serve two runs at one time (`docs/research/d16-codex-in-ci.md`) |
| A head that moves during a run | the concurrency group cancels the old run | the trigger reads the PR head again before it posts, and drops the review when the head changed |
| The later run and the resolution of threads | a later run reads the newest review of its own login with a run marker, and the newest record of the PR in its out folder, and it reviews only the hunks since that head (`src/github/prior.ts:45-125`, `src/run.ts:531-613`). Threads resolve only when the prior comes from a record (`src/github/post.ts:275-290`). In CI the out folder is a worktree of the records branch | the records of the PR in the local out folder (`./pr-review-records` or `--out`; `src/record/write.ts:35-37`). One fixed out folder for all repos holds `pr-<n>/` of many repos, so the folder needs one level for each repo (`<out>/<owner>/<repo>/`); the prior lookup already filters by repo, but scans more files |
| The records branch | only the workflow reads and pushes `pr-review-records`, as `github-actions[bot]` (`review.yml:115-232`). A local run never touches it | either the local out folder (no history on GitHub), or a step that commits and pushes the records branch from the machine |
| The status check | the check run `pr-review`, always `neutral` (`src/github/post.ts:170`), so no branch protection rule can use it | none. GitHub says: "To create a check run, you must use a GitHub App" and "OAuth apps and authenticated users can view check runs and check suites, but they are not able to create them" (https://docs.github.com/en/rest/checks/runs). A local run under the user's `gh` login gets a refusal, and the run records it as a check-run error. The local path must skip the check run on purpose. A branch protection rule could use a commit status (`POST /repos/{owner}/{repo}/statuses/{sha}`), which a user login can set, but the tool does not post one today |
| The identity that posts | `github-actions[bot]`, from the job token | the user's own account, through the `gh` login |

The account that posts matters in four ways:

- The review event is always `COMMENT` (`src/github/gh.ts:505-512`), never "request changes". So the GitHub rule that an author cannot request changes on their own PR does not touch the tool. The verdict lives in the text of the review.
- A later run finds its prior review by the login of the poster (`sameLogin`, defined in `src/github/client.ts`, used in `src/github/prior.ts:111-145`). A local run and a CI run post under two logins, so neither sees the reviews of the other. Each one starts its own chain of first and later runs.
- The cleanup comment, the refactor comment of D16 and the dedupe of skip reviews match by the login and a marker (`src/github/post.ts:43-45`, `:209-222`). Under the user's account they still need the marker, so a comment by the user with no marker is never taken for the tool's. They also split by login: a CI comment and a local comment are two comments.
- A full review by hand (`pr-review run --pr <n> --format github`) under the user's account starts a third chain beside the CI chain and the staff engineer chain.

## 3. Ways to trigger a local review

| Trigger | The work | Weak points |
|---|---|---|
| A manual command (`pr-review run --pr <n> --format github`, or `/review --format github`) | none for a full review; for the staff engineer review alone, the run command needs `--reviewers` (section 5) | a person must remember it; the plugin command runs in the clone of the session |
| A Claude Code hook after an agent session opens a PR (`gh pr create`) | a hook that matches `gh pr create` in a session and starts the staff engineer review in the background, in the clone of that session | only for PRs opened by a Claude Code session on this machine; a PR opened from a terminal or the web gets no review; it uses the plan window of the session's account at that moment |
| A git pre-push hook | a hook in each clone, or a global hooks folder, that starts the review in the background after the push | git has no post-push hook, so the job must wait until the new head is on GitHub; it is set up in each clone; a push from the web gets no review |
| A watcher on the machine (a launchd job) | a command that polls the user's open PRs with `gh` every few minutes and reviews each new PR once | the most work: a clone and a fetch for each repo; on its first start it must record the current heads and review none of them, or it reviews every old PR; it skips closed, merged and draft PRs; its state key is repo, PR and head; it waits for the CI review of a head with a time limit and a fallback (CI can skip, fail or be cancelled); it runs only while the machine is on and awake; a launchd job has a small `PATH` and may not reach the keychain for `gh` or the Claude login while the screen is locked (not verified) |
| A self-hosted GitHub Actions runner on the same machine | register the machine as a runner for each private repo, and give the job `runs-on: self-hosted` | CI in form, local in fact (below) |

The self-hosted runner is different from the other four. GitHub starts the job on each push, as today, with the workflow, the checkout and the concurrency group as they are. The job runs on the user's machine, so the Codex login stays in the Codex home of that machine and renews itself, and the records branch works as in CI. A job that a GitHub App token runs can post the check run. But the vendor allows a ChatGPT login in CI only on "trusted private infrastructure" and not "for public or open-source repositories" (`docs/research/d16-codex-in-ci.md`). So pr-review, a public repo, cannot use it, and the user's private repos can. A job for a machine that is off waits in the queue: "If the job remains queued for more than 24 hours, the job will fail" (https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

## 4. What is lost and what is gained against CI

| | CI today | Local |
|---|---|---|
| A review when the machine is off or asleep | yes | no: the review waits until the machine is on (watcher, runner) or never comes (hook) |
| A PR opened from another machine or the web | yes | with a watcher or a runner, yes while the machine is on; with a hook, no |
| Two reviews at one time | the concurrency group cancels the older run | the trigger keeps a lock for each PR, and one lock for all Codex reviews of the machine; Codex reviews of many agent PRs wait in line |
| The plan window | the CI token comes from `claude setup-token` (`action.yml:3-7`) on the same subscription, so it is the same plan window | the same plan window, but the run now competes with the user's own interactive work in the same minutes, and one run for each agent PR adds up |
| The status check | a neutral check run | none: a user login cannot create a check run |
| Setup | a secret and a workflow file in each repo | a clone of each repo on the machine; for a hook, a hook in Claude Code; for a watcher, a launchd job; for a runner, a runner for each repo |
| The staff engineer reviewer and the Codex login | no subscription login in a GitHub-hosted job | it works with the Codex login of the machine, and no credential is in GitHub |

## 5. A mixed design

The six Claude reviewers stay in CI as today. Only the staff engineer reviewer and the refactor comment run on the machine, and they add to the same PR.

What the tool needs:

- A run of one reviewer that posts: `pr-review run --pr <n> --format github --reviewers staff-reviewer`. The `--reviewers` option exists on the eval command only (`src/cli.ts:497`); the run command (`src/cli.ts:401-446`) gets it. It posts its own `COMMENT` review under the user's account. It cannot add to the review of `github-actions[bot]`: a review belongs to its poster.
- Once per PR: the staff engineer reviewer runs on a first run or a fresh run only (`docs/design/staff-reviewer.md`). So the local chain posts the first review when the PR opens, and a fresh review when the user asks (`--fresh`). A later push starts no local review. A later local run with no reviewer selected posts nothing.
- No check run: the local path skips the check run on purpose and records why, so no run records a refused check as an error.
- No verdict line: the staff engineer review states its findings and no verdict, so a reader does not see two verdicts. The CI review keeps the verdict. When CI did not review (a draft PR, `review:skip`), the staff engineer review says that it holds no verdict.
- Duplicates with the CI review: probably rare, because the staff engineer reviewer reports design-level findings and the prompt tells it not to repeat the work of the six specialists. Measure the overlap on the D15 records before any dedupe code. If a dedupe is needed, it uses the fingerprints and the quotes of the CI comments (`parseFingerprintMarkers`), not the line numbers, which shift between heads.
- The refactor comment of D16 part c posts from the local run, with its marker, under the user's account.
- The trigger: a hook after `gh pr create` in a Claude Code session fits the once-per-PR rule with the least work. A watcher is the step after it, if PRs from other sources must get the review without a request.

## 6. The size of each design

### Mixed, with a hook (recommended)

Work items:
1. `--reviewers` on the run command, and the once-per-PR rule for a one-reviewer chain (`src/cli.ts`, `src/run.ts`).
2. Skip the check run on a local run, with the reason in the record (`src/github/post.ts`).
3. No verdict line in a one-reviewer review (`src/github/review-body.ts`).
4. A hook for Claude Code that matches `gh pr create` and starts the staff engineer review in the background, with one machine-wide lock for Codex (a plugin hook in `.claude-plugin/`, and a small runner script).
5. The out folder with one level for each repo (`src/record/write.ts`, `src/github/prior.ts`).
6. Measure the overlap with the CI findings on the D15 records, before deciding on a dedupe (no code).

On top of D16 parts a and c. About 5 code items and one measurement.

### Mixed, with a watcher

The items of the hook design, with item 4 replaced by a watcher (`pr-review watch`, in `src/cli.ts` and a new `src/watch/`): a clone and a fetch for each repo, a map from repo to clone, a first start that records the current heads, a skip of closed, merged and draft PRs, a state file keyed by repo, PR and head, a wait for the CI review with a time limit and a fallback, a check of the head before posting, the machine-wide Codex lock, and a launchd plist with its `PATH` and its access to the keychain checked. About 10 items in all: about twice the hook design.

### All local

The watcher design with all seven reviewers in the local run, and the CI workflow removed from the consumer repos. It also needs a full-review chain on each push (not once per PR), so the later-run and thread-resolution logic runs locally with the records of each repo, and the CPU and the plan window carry the six Claude reviewers too. About the watcher design plus 2 items, and the largest change in behaviour.

### Self-hosted runner

A workflow job for the staff engineer reviewer with `runs-on: self-hosted` in each private repo, beside the job on GitHub-hosted runners; the runner setup on the machine in the docs (registration, a service, the Codex login); and items 1 and 3 of the hook design if the two jobs post two reviews. The fewest tool changes, a check run that works, and setup for each repo. Private repos only.

## 7. Security

CI is a machine that ends with the job and holds no login of the user, and `review.yml` keeps the job token away from the reviewer processes. A local review reads the PR on the machine that holds the user's `gh` login, SSH keys and the Codex login. A PR that an agent session wrote can hold text that steers a reviewer (E6, issue 63).

- The staff engineer reviewer runs as `docs/design/staff-reviewer.md` plans: a copy of the head tree with no `.git`, a small environment, the read-only sandbox, and `redact` on its output. The read-only sandbox does not stop reads, and that risk is the same on the machine as in CI.
- The six Claude reviewers stay in CI in the mixed design, so they do not read PRs on the machine. In the all-local design they would, with their read-only tools over the checkout; a custom reviewer with Bash needs the same small environment.
- The user is the only person who pushes, so the PRs come from the user or the user's agent sessions. That is the trust that a local review assumes (open question 5).

## Recommendation

The mixed design, started by a hook when an agent session opens a PR.

- It keeps what CI does well: the six Claude reviewers review every push, also when the machine is off.
- The staff engineer reviewer runs where the Codex login lives and renews itself, with no credential in GitHub, on public and private repos alike.
- The design of D16 already runs the staff engineer reviewer once per PR, so a trigger at the opening of a PR is enough, and it is about half the work of a watcher. A manual `/review` or `--fresh` covers a PR from another source.
- A missed staff engineer review is acceptable by the user's own rule: the reviewer never fails a review, and the CI review stands on its own.
- A watcher can come later, if PRs from other sources must get the review without a request.

The self-hosted runner is the better choice for a private repo where the user wants GitHub to start the job and keep a check run, with the fewest tool changes. It cannot serve pr-review itself.

## What I could not verify

- Whether a launchd job reaches the keychain for `gh` and the Claude login while the screen is locked, and what `PATH` it needs.
- The overlap between the staff engineer findings and the CI findings on one head (work item 6 measures it).
- How the hook should find PRs that a session opens under another GitHub account, if any session pushes as another user. The note assumes that all PRs are the user's.
- The cost of polling for a watcher: the rate limit of `gh` for the user's account at one poll every few minutes.
