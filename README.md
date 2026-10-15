pr-review reviews the diff between two commits of a local git repo, or the diff of a GitHub pull request. It runs triage, seven reviewers, verification and merge with the Claude Agent SDK. It writes a JSON run record. With `--format github`, it posts one review on the pull request.

## Setup

| Need | Version |
|------|---------|
| OS | macOS or Linux |
| Shell | bash |
| Node | 20.19 or later |
| git | 2.40 or later |
| gh | 2.40 or later, logged in. Only `--pr` needs it. |

Run these commands in the repo root:

```bash
npm ci
npm run build
npm link
```

`npm run build` compiles the code to `dist/`. `npm link` puts the `pr-review` command on your PATH.

Check the code with these commands:

| Command | Purpose |
|---------|---------|
| `npm test` | Run the vitest unit tests. They need no network and no credentials. |
| `npm run lint` | Run eslint and the prettier check. |
| `npm run typecheck` | Run the TypeScript type check. |
| `npm run build` | Compile the code to `dist/`. |

## Auth

The tool uses your Claude subscription. It never reads or stores credentials. Pick one method:

1. Run `claude setup-token`. Export the token it prints:

   ```bash
   export CLAUDE_CODE_OAUTH_TOKEN=<token>
   ```

2. Log in with Claude Code on this machine. The tool then uses the saved login.

When `CLAUDE_CODE_OAUTH_TOKEN` is set, it wins over the saved login.

The tool removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches from the environment of every query, so the subscription login is the only route. To keep them, pass `--allow-api-key`. It always removes `GH_TOKEN` and `GITHUB_TOKEN` from that environment.

The environment variable `PR_REVIEW_PROMPTS_DIR` replaces the prompts directory of the package. The tests use it. Set it only to ship other prompts.

## Run

Run the command from inside the repo that you want to review:

```bash
pr-review run --base <sha> --head <sha>
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--base <sha>` | The base commit. | required without `--pr` |
| `--head <sha>` | The head commit. | required without `--pr` |
| `--repo <path>` | The repo to review. | current directory |
| `--format json\|table\|github` | The output format. `github` needs `--pr`. See [Run on GitHub](#run-on-github). | `table` |
| `--out <dir>` | The directory for the run record. | `./pr-review-records` |
| `--tier full\|fast\|skip` | Force the review tier. | chosen by triage |
| `--allow-api-key` | Keep `ANTHROPIC_API_KEY` in the environment. | off |
| `--author-write-access` | Tell the run that the PR author has write access. See [`--author-write-access`](#--author-write-access). | off, or the permission of the author with `--pr` |
| `--pr <n>` | Review pull request `<n>`. See [Run on GitHub](#run-on-github). | none |
| `--github-repo <owner/repo>` | The repo slug. It overrides the slug of the checkout. | read from the checkout |
| `--fresh` | Run as a first run, even when the PR has an earlier review. | off |

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | The run wrote a record. This holds for every verdict. |
| 1 | The run could not write a record. A config error is one such case. Or the run could not post the review that `--format github` asked for. |
| 2 | Usage error. |

Each run writes one file named `<timestamp>-<7-char head sha>.json` in the records directory. With `--pr`, the file goes in the `pr-<n>` subdirectory.

A config error exits with code 1. The run writes no record and sends no model query. The message on stderr names the file and the field.

With `--format json`, the command prints one JSON document to stdout. Its keys are `record_path`, `tier`, `verdict`, `coverage`, `excluded_files`, `total_cost_usd`, `queries_without_cost` and `findings`. With `--format github`, the document also holds `review_url`. `total_cost_usd` is a lower bound when `queries_without_cost` is above 0. The [new keys](#record-and-output-keys) of the coverage are in this document.

The verdict is one of `skipped`, `incomplete`, `would request changes` and `would approve`.

## Run on GitHub

Run the command with a PR number to review a pull request. Add `--format github` to post the review:

```bash
pr-review run --pr <n> --format github
```

The run reads the PR through `gh`. The tool never reads `GH_TOKEN` or `GITHUB_TOKEN`. `gh` finds its own login.

| Option | Effect |
|--------|--------|
| `--pr <n>` | Read PR `<n>`. `--base` and `--head` default to the base sha and the head sha of the PR. The option works with every format. |
| `--github-repo <owner/repo>` | Use this slug. Without it, the run reads the slug from the checkout. |
| `--format github` | Post one review on the PR. The option needs `--pr`. Without `--pr`, the command exits with code 2. |
| `--fresh` | Run as a first run, even when the PR holds an earlier review of the tool. See [Later runs](#later-runs). |

With `--format github`, stdout holds the same JSON document as `--format json`, plus a `review_url` key. The key is `null` when the run posts no review.

### The tier on a PR

With `--pr`, the first rule that applies sets the tier:

1. The `--tier` option.
2. A label. The order is `review:skip`, `review:fast`, `review:full`. The first match wins.
3. A skip rule of the config. A rule applies when one of these is true:
   - The PR is a draft and `skip.draft` is `true`.
   - The title holds an entry of `skip.title_keywords`. The match ignores case.
   - The PR has a label in `skip.labels`.
   - The author login is in `skip.bot_authors`.
4. The PR has zero hunks. The tier is `skip`.
5. A sensitive path. The tier is at least `full`.
6. The triage result.

Each skip rule gives a tier reason. The reason names the rule and the value that matched.

### Labels and the comment

| Trigger | Effect |
|---------|--------|
| Label `review:skip` | Run at the `skip` tier. |
| Label `review:fast` | Run at the `fast` tier. |
| Label `review:full` | Set the tier floor to `full`. The `labeled` event that adds the label also runs fresh. |
| Comment `@pr-review full` | Run fresh at the `full` tier. Only an owner, member or collaborator can start it. |

The CLI never reads comments. The workflow reads the comment and passes `tier: full` and `fresh: true`.

When someone adds `review:fast` or `review:skip` to a head that has a review, the `labeled` event starts a later run with no new hunk. That run posts nothing, unless a stale thread or body finding closed. See [Later runs](#later-runs).

### What the run posts

With `--format github`, the run posts in this order:

1. One review with event COMMENT on the head sha. See [The review body](#the-review-body).
2. One check run named `pr-review` on the head sha. Its status is `completed` and its conclusion is `neutral`. The title is the verdict. The summary holds the number of posted findings, the counts table, the coverage, the candidate findings and the cost.
3. With `pre_existing: comment`, one issue comment titled "Cleanup opportunities". It holds the marker `<!-- pr-review cleanup -->`. A later run replaces the body of that comment. It updates only a comment by the login of the tool.

A verified pre-existing finding is a true finding about code that the PR did not add, change or aggravate. Its quote must be in the head file. The record lists these findings under `stages.pre_existing`. With `pre_existing: off`, the run posts nothing for them.

A run that posts no review posts no check run and no cleanup comment.

At the `skip` tier on a first run, the review is one line. It holds the marker with `tier=skip` and the tier reason. The run posts it only when the PR holds no earlier `tier=skip` review with the same reason. A later run whose own tier is `skip` posts nothing.

| Failure | What the run does | Exit code |
|---------|-------------------|-----------|
| `gh` is absent or not logged in. | The error names `gh`. | 1 |
| A stage fails before the review posts. | Posts one short review: `pr-review failed at <stage>: <message>`. Its marker holds `status=failed`. Writes the record when it can. | 1 |
| The create-review call fails. | Retries once. The retry holds every finding in the body and no inline comment. | 0 when the retry works |
| The retry fails too. | Records the error under `posted.github.error` and writes the record. Posts no check run and no cleanup comment. | 1 |
| The check run fails. | Records the error under `posted.github.check_run.error`. The review stays posted. | 0 |
| The cleanup comment, a thread resolve or a reply fails. | Skips that step and runs the later steps. Records the error under `posted.github.errors`. | 0 |

A local token can lack the `checks` scope. The check run then fails and the review still posts.

### Sanitizing

The run sanitizes the PR title, the PR body and the commit messages before they enter a prompt. The steps are:

- Remove HTML comments.
- Remove Unicode format characters and default ignorable code points. This covers zero-width characters, bidi controls, the soft hyphen, the byte order mark, the variation selectors and the Hangul fillers. The braille blank goes too.
- Remove C0 control characters, except tab and newline.
- Normalize the text to NFC.
- Cut the text at 20000 characters.

With `--pr`, the description is the sanitized title, a blank line and the sanitized body. The record key `identity.description_meta` says whether sanitizing changed or cut the text.

## The review body

The review body has these parts, in this order:

- **Line 1.** The marker.
- **The verdict.** A heading with an icon: "Would approve", "Would request changes" or "Review incomplete".
- **The tier and the tier reason.**
- **The counts.** A table of blocking findings, suggestions and nits. When earlier runs hold open blocking findings, a line names how many.
- **Findings outside the diff.** One entry for each posted finding that does not go inline. An entry holds the severity in bold, the title, the claim, a permalink and a fingerprint marker.
- **Coverage and cost.** A folded block. It lists the reviewers that ran, each coverage part that is not empty, the number of candidate findings and how many the verifier dropped, the cost and the run time. The table output holds the same coverage parts on one line.
- **The tool version.**

A finding goes inline when every line of its span is a right-side line of one hunk. The hunk is in the PR diff at the head. An added line and a context line are right-side lines. Any other finding goes in the body.

An inline comment has the path, the line and the side `RIGHT`. It has a start line when the span has more than one line. Its body holds the severity in bold, the title, the claim and a fingerprint marker.

| Marker | Where | Content |
|--------|-------|---------|
| `<!-- pr-review run=<run id> head=<head sha> base=<base sha> tier=<tier> -->` | Line 1 of every review body. | The run id is the record file name without `.json`. |
| `<!-- pr-review run=<run id> head=<head sha> base=<base sha> tier=<tier> status=failed -->` | The failure review. | The same keys, plus `status=failed`. The tier is `unknown` when the run failed before it decided the tier. |
| `<!-- pr-review fp=<fingerprint> -->` | Each inline comment and each body entry. | The fingerprint of the finding. |
| `<!-- pr-review cleanup -->` | The cleanup comment. | None. |

The permalink has this form:

```text
https://github.com/<slug>/blob/<head sha>/<path>#L<start>-L<end>
```

A later review body also holds the fingerprint marker of every body finding from earlier runs that is still open. So the newest review body of the tool lists every open body finding.

## Later runs

A later run is a `--format github` run on a PR that holds a review with the marker of the tool, without `--fresh`. The run ignores a review whose marker has `tier=skip` or `status=failed`. A PR with only such reviews gets a first run. When a draft is skipped and then becomes ready at the same head, the run is a first run.

The run reads markers only from reviews by the login of the tool. When `GITHUB_ACTIONS` is set, that login is `github-actions[bot]`. Otherwise, it is the login of the `gh` user.

### Prior state

| Source | What it gives |
|--------|---------------|
| GitHub | The thread state, the posted fingerprints and the 👎 reactions. |
| The previous record | The last reviewed head, H0, and the full finding of each open thread. |

With `--pr`, the run reads the newest record in `<out>/pr-<n>/` that meets all of these:

- `posted.github` is not `null` and holds no `error`.
- `identity.tier` is not `skip`.
- The slug and the PR number match.

When the run finds no record, it takes H0 from the newest body marker. It dedupes against the comment fingerprints. It resolves no thread. Coverage says "no prior record".

| Fingerprint state | Meaning |
|-------------------|---------|
| Open | Posted. The thread is not resolved. The comment has no 👎 reaction. A finding in a review body is open too. |
| Dismissed | A human resolved the thread, or the comment has a 👎 reaction. |
| Resolved by the tool | The last comment of the resolved thread is the "Resolved by pr-review" reply. The fingerprint is neither open nor dismissed. |

### Scope

The run computes the PR diff at the new head, from the merge base. It also computes the diff at H0, from its own merge base. A hunk is new when no hunk of the H0 diff has the same path and the same added and removed text. Only files with a new hunk reach the reviewers. Only new hunks are in the diff text.

Triage runs on the whole PR diff. The triage result is the higher of the triage tier of this run and the triage tier of the prior record. Items 1 to 5 of [the tier order](#the-tier-on-a-pr) still win over it.

When H0 is not in the local object store, the run fetches it with git. When the fetch fails, the run becomes a fresh run. Coverage says so.

When the run finds no new hunk, it still re-verifies the open findings and resolves the stale threads. When a thread resolved or a body finding closed, the push changed what holds, so the run posts one short review at the tier of the prior record with the recomputed verdict and a check run. When nothing closed, it posts nothing, writes a record with `posted.github: null` and exits with code 0.

### What a later run does

- **Severity floor.** Only blocking findings post. The run records the others under `posted.below_floor`.
- **Dedupe.** A new finding with an open or dismissed fingerprint does not post. The run records it under `posted.not_reposted`.
- **Re-verification.** For each open thread, the run compares the span text of the finding with the file at the new head. When the file no longer holds the text, the run resolves the thread. It first replies "Resolved by pr-review: the code this comment refers to changed at <head sha>." It records the thread under `posted.github.resolved`.
- **Body findings.** A body finding has no thread. It stays open while its span text is in the file. It counts for the verdict by its severity. The run drops it when the text is gone. The run resolves nothing for it.
- **Verdict.** The verdict is "Review incomplete" by the usual rules. Otherwise it is "Would request changes" when a new blocking finding exists, or when a blocking thread or body finding is open. Otherwise it is "Would approve". The body says "Review of changes since <H0 short sha>".

### Fresh runs

`--fresh` makes the run a first run again. The `labeled` event that adds `review:full` does the same. The scope is full and every severity posts. The run still never reposts an open or dismissed fingerprint.

## The records branch

Each run writes a record. In CI, the workflow keeps the records on the branch `pr-review-records` of the consumer repo. That branch outlives the artifact retention.

| When | What the workflow does |
|------|------------------------|
| Before the run | Checks the branch out at the `out` directory, so the prior records are present. When the branch is absent, it creates an empty directory. |
| After the run | Uploads the `out` directory as the artifact `pr-review-record-<pr>-<run id>`. |
| After the run | Commits the new record at `pr-<n>/<file name>` on the branch and pushes it. It creates the branch as an orphan when the branch is absent. |

These steps run even when the review fails, so a failed run leaves its record too. The commit step skips the commit and the push when no new file exists. On a non-fast-forward refusal, the push step fetches the branch and rebases. It tries up to three times. The push needs the `contents: write` permission.

In CI, `out` is `${{ runner.temp }}/pr-review-records`. That directory is outside the repo under review. A local run writes to `./pr-review-records`, or to the `--out` directory. With `--pr`, the record goes in the `pr-<n>` subdirectory.

## Set up CI

Set up the secret and the workflow in each consumer repo. Set the access setting once, in the repo `jerridan/pr-review`.

### The secret

Run `claude setup-token`. Store the token as the repo secret `CLAUDE_CODE_OAUTH_TOKEN`. The workflow sets `GH_TOKEN` from the job token itself.

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

### The Actions access setting

Other repos of the owner can call the workflow only when the repo `jerridan/pr-review` allows it. The setting is "Accessible from repositories owned by the user". Set it once with this command. `<slug>` is `jerridan/pr-review`:

```bash
gh api -X PUT /repos/<slug>/actions/permissions/access -f access_level=user
```

### The consumer workflow

Save this file as `.github/workflows/pr-review.yml` in the consumer repo:

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
    uses: jerridan/pr-review/.github/workflows/review.yml@v1
    secrets: inherit
```

The consumer holds the trigger list, because GitHub reads `on:` only from the repo where the event happens.

| Trigger | The workflow runs when |
|---------|------------------------|
| `pull_request` | A PR opens, gets a push, reopens or becomes ready. |
| `pull_request_target` | Someone adds a label that starts with `review:`. |
| `issue_comment` | A comment on a PR holds `@pr-review full`. The author is an owner, member or collaborator. |

The workflow runs one review for each PR at a time. A new push cancels the run in progress. The `contents: write` permission lets the job push the [records branch](#the-records-branch). A repo that needs more steps in the job calls the action `jerridan/pr-review@v1` directly.

| Action input | Meaning |
|--------------|---------|
| `pr` | The PR number. Required. |
| `tier` | Force the tier. |
| `fresh` | Run as a first run. |
| `out` | The records directory. The default is `pr-review-records`. |
| `allow-api-key` | Keep `ANTHROPIC_API_KEY` in the environment. |

The action has two outputs: `record`, the record path, and `verdict`. The action reads no secret. The caller sets `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` in `env`. `GH_TOKEN` is the job token, `${{ github.token }}`, in the reusable workflow. The run records the login that posted each review and reads the state of earlier runs as that login, so another token works once it has posted one review; before that, the run reads the viewer login, or `github-actions[bot]` when the token cannot read it.

### Fork PRs

- A `pull_request` event from a fork gets a read-only token and no secrets. It cannot post. The workflow skips it.
- A maintainer adds the label `review:full` or `review:fast` to run a fork PR. The label event must come from an owner, member or collaborator.
- The comment `@pr-review full` from an owner, member or collaborator is the second path that runs a fork PR. It runs fresh at the full tier.
- The run checks out the fork head. It executes no code from it. The CLI reads git objects. It runs no script, hook or build of the repo under review.
- The label sets the tier. The label `review:full` also runs fresh.
- The run grants Bash to no custom reviewer on a fork PR, whatever the permission level of the author.
- Never add a step that builds or tests the fork head in the same job. That job holds the secret.
- The checkout keeps no token in the workspace: the workflow sets `persist-credentials: false`. The fetch and push steps get the job token through the `gh` credential helper, which reads `GH_TOKEN` from the env of those steps only. The reviewer subprocesses get no `GH_TOKEN`.

### The release tag

The workflow and the action both read the tag `v1`. Create the tag on the commit that you release. Move it to ship a fix:

```bash
git tag -f v1
git push -f origin v1
```

## The `/review` command

The `/review` command runs the CLI from Claude Code, in the current repo. Install it with these two commands:

```bash
claude plugin marketplace add jerridan/pr-review
claude plugin install pr-review@pr-review
```

The command runs this:

```bash
pr-review run --base $(git merge-base origin/HEAD HEAD) --head HEAD --format table
```

When `gh pr view` finds an open PR for the branch, the command adds `--pr <n>`. The command never posts a review unless you say `--format github`. The `pr-review` command must be on your PATH. See [Setup](#setup).

## The `.pr-review/` directory

A target repo shapes the review with a `.pr-review/` directory. The run reads the directory from the base commit. It reads the git objects, not a working tree. A change to `.pr-review/` in the PR has no effect on the review of that PR. Each of `config.yaml`, `rules.md` and the reviewer files must be a regular file at the base commit. A symlink or a submodule there stops the run with a config error. The `.pr-review/` directory and the `reviewers/` directory must be real directories. A symlink or a submodule in their place also stops the run.

The directory holds three kinds of file. All of them are optional.

| Path | Content |
|------|---------|
| `.pr-review/config.yaml` | The settings that the table below lists. |
| `.pr-review/rules.md` | Rules in plain text. The run adds them to the system prompt of every reviewer. |
| `.pr-review/reviewers/*.md` | Custom reviewers. Each file has the same frontmatter as a file in `prompts/reviewers/`. |

When the directory is absent, the run uses the defaults. The run also adds the `CLAUDE.md` at the root of the base commit to the system prompt of every reviewer. Each of these files has a cap of 16384 bytes. The record notes a file that the run cut to fit the cap. The root `CLAUDE.md` may be a symlink. The run follows it one level, to a regular file inside the base tree. When the target is outside the tree, is absolute, or is not a regular file, the run injects no `CLAUDE.md` and adds a `config` entry to the record errors.

A config file that does not parse or validate stops the run. An unknown key is an error. See the exit code table above.

### Config keys

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `thresholds.default` | integer 0 to 100 | 80 | The floor for every reviewer threshold. |
| `thresholds.middle_band` | two integers 0 to 100, low then high | `[60, 85]` | The score range that sends a finding to verifier escalation. |
| `reviewers.<name>.enabled` | boolean | `true` | Whether the reviewer may run. |
| `reviewers.<name>.passes` | integer, 1 or more | the frontmatter value | The number of passes of the reviewer. |
| `reviewers.<name>.threshold` | integer 0 to 100 | the frontmatter value, raised to `thresholds.default` when it is lower | The threshold of the reviewer. A value below `thresholds.default` is an error. |
| `reviewers.<name>.model` | alias or exact model id | the frontmatter value | The model of the reviewer. |
| `reviewers.<name>.effort` | `low`, `medium`, `high`, `xhigh` or `max` | the frontmatter value | The effort of the reviewer. |
| `suppressions` | list of objects | empty | Rules that remove a verified finding. See below. |
| `sensitive_globs` | list of globs | empty | Globs that the run adds to the default sensitive globs. |
| `generated_globs` | list of globs | empty | Globs that the run adds to the default generated globs. |
| `skip.draft` | boolean | `false` | Skip the review of a draft PR. |
| `skip.title_keywords` | list of strings | empty | Skip the review when the PR title holds one of the strings. |
| `skip.labels` | list of strings | empty | Skip the review when the PR has one of the labels. |
| `skip.bot_authors` | list of strings | empty | Skip the review when the PR author is one of the bots. |
| `caps.non_blocking_base` | integer, 0 or more | 3 | The base cap on non-blocking findings. |
| `caps.non_blocking_per_hunks` | integer, 1 or more | 4 | The number of hunks that add one to the cap. |
| `caps.non_blocking_max` | integer, 1 or more | 20 | The highest value of the cap. |
| `models.<role>` | object with `model` and `effort` | see below | The model and the effort of one role. |
| `pre_existing` | `off` or `comment` | `off` | The handling of pre-existing problems. |
| `concurrency` | integer, 1 or more | 5 | The number of model queries that run at the same time. |
| `token_ceiling` | integer, 1 or more | absent, which means no ceiling | The most tokens that the run may use. |

Notes on the keys:

- **Band and threshold.** The upper bound of `thresholds.middle_band` must be at least `thresholds.default`. A `reviewers.<name>.threshold` must not be above that upper bound. A score above the band and below the threshold could never escalate and never pass, so the config is an error.
- **Reviewer names.** `<name>` is a built-in reviewer or a custom reviewer. Any other name is an error.
- **Models.** A model is an alias (`opus`, `sonnet` or `haiku`) or an exact model id.
- **Effective model and effort.** The order is `reviewers.<name>.model`, then `models.reviewer.model`, then the frontmatter value. The effort follows the same order.
- **Roles.** The roles of `models.<role>` are `triage`, `reviewer`, `verifier`, `verifier-escalation` and `merge`. The defaults are `sonnet` with `medium` for triage, `opus` with `low` for reviewer, `sonnet` with `high` for verifier, `opus` with `high` for verifier-escalation, and `sonnet` with `medium` for merge. A `models.<role>` object can give `model` alone, `effort` alone, or both.
- **`pre_existing`.** With `comment`, the run posts the verified pre-existing findings as one issue comment. See [What the run posts](#what-the-run-posts).
- **Token ceiling.** When the tokens of the finished queries reach the ceiling, no new reviewer pass starts. Coverage lists each pass that did not start with the reason `token ceiling`, and the verdict is `incomplete`. Verification of findings that the run already has still runs.
- **Hash.** The record holds `config_hash`. It is the SHA-256 of the loaded `.pr-review/` files. Each entry is the path, one newline, and the file bytes. The run sorts the entries by the bytes of the path and joins them with one NUL byte. The `CLAUDE.md` is not an entry. The hash is `null` when the base commit has no `.pr-review/` file.

### Suppressions

A suppression removes a verified finding before the merge groups form. Each item has `reviewer`, `category`, `path` and `reason`. The item needs `reason` and at least one of the other three keys. A finding matches an item when it matches every key that the item gives. The `reviewer` key must name a built-in or a custom reviewer. Any other name stops the run with a config error.

| Key | Matches |
|-----|---------|
| `reviewer` | The name of the reviewer that reported the finding. |
| `category` | The category of the finding: `bug`, `security`, `test`, `convention`, `docs`, `performance` or `other`. |
| `path` | A glob. The run matches it against the file of the finding. |
| `reason` | Free text. It is required. |

Example:

```yaml
reviewers:
  history:
    enabled: false
  security:
    passes: 3
suppressions:
  - reviewer: conventions
    category: convention
    path: "docs/**"
    reason: The docs have their own style guide.
```

The record keeps each removed finding under `stages.suppressed`, with the name of its reviewer and its rule.

### Custom reviewers

A file in `.pr-review/reviewers/` defines a custom reviewer. Its name must not match a built-in reviewer or another custom reviewer. The `triggers.paths` and `triggers.categories` lists gate a custom reviewer. The triage categories gate custom reviewers only.

A custom reviewer gets Bash only when both of these are true:

- The file sets `trusted: true`.
- The run knows that the PR author has write access. See [`--author-write-access`](#--author-write-access).

The run never grants Write or Edit. A built-in reviewer never gets Bash. When a custom reviewer names Bash in `tools` and does not get it, the reviewer runs with read-only tools. Coverage lists it under `reviewers_without_bash` with the reason.

## Reviewers

Seven built-in reviewers exist. The tier and the triggers decide which of them run. Each reviewer reports only what the diff adds, changes or aggravates. Each one has its own evidence source and a "Do not flag" list, so the reviewers do not report the same problem twice. The files are in `prompts/reviewers/`.

| Reviewer | Evidence | Lowest tier | Passes |
|----------|----------|-------------|--------|
| `diff-bugs` | The diff and the head files. | fast | 2 |
| `conventions` | The repo rules and the nearby code. | fast | 1 |
| `tests` | The behaviour changes of the diff, compared with its test changes. | full | 1 |
| `security` | Input handling, secrets and authorization on the changed paths, and the diff of `.pr-review/`. | full | 2 |
| `history` | The blame and log of the changed lines, read at the merge base. | full | 1 |
| `description-drift` | The description of the change, compared with what the code does. | full | 1 |
| `docs-and-comments` | The comments and docs that the change makes stale. | full | 1 |

`diff-bugs` is the original reviewer. The other six are new. All seven run on every change at or above their lowest tier. At the fast tier, every reviewer runs one pass.

The description is the sanitized PR title and body with `--pr`. Without `--pr`, it is the sanitized subject and body of each commit between the base and the head. Every reviewer and the verifier get it. When the description is empty, `description-drift` does not run, and coverage lists it under `reviewers_skipped` with the reason `no description`. The same list names a reviewer that the config disables, with the reason `disabled by config`.

All passes of a reviewer use the same input. The run removes repeated findings by fingerprint before verification, so the verifier checks one copy. The record keeps the findings of every pass.

## `--author-write-access`

The option tells the run that the PR author has write access to the repo. The default is off.

```bash
pr-review run --base <sha> --head <sha> --author-write-access
```

With the option, a custom reviewer that sets `trusted: true` in its file and names Bash in `tools` gets Bash. Without it, that reviewer runs with read-only tools, and coverage gives the reason `author has no write access`. With `--pr` and no flag, the run sets the option from the permission level of the author. The levels `admin`, `maintain` and `write` mean yes. A pull request from a fork never gets write access, whatever the permission level and whatever the flag says. So no custom reviewer gets Bash on a fork head.

## Record and output keys

The run record has these keys, added with the `.pr-review/` directory.

| Key | Content |
|-----|---------|
| `identity.config_hash` | The SHA-256 of the loaded `.pr-review/` files, or `null`. |
| `identity.config.files` | The paths of the loaded `.pr-review/` files. |
| `identity.config.values` | The validated config, with the defaults filled in. |
| `identity.config.custom_reviewers` | For each custom reviewer: `name`, `bash_granted` and `reason`. |
| `identity.description` | The sanitized description that every reviewer and the verifier got. |
| `identity.history` | `built` and `truncated`, for the history block. The history block has a cap of 65536 bytes. |
| `identity.injected` | For each injected rules file: `path` and `truncated`. |
| `stages.suppressed` | For each finding that a suppression removed: `finding`, `reviewer` and `rule`. `posted.findings` omits these findings. |
| `posted.coverage.reviewers_skipped` | For each selected reviewer or pass that did not run: `name`, `reason` and, for `token ceiling`, `pass`. |
| `posted.coverage.reviewers_without_bash` | For each custom reviewer that asked for Bash and did not get it: `name` and `reason`. |
| `posted.coverage.sensitive_without_hunks` | The sensitive paths with no text hunk, for example a mode flip or a binary. |

A sensitive path with no text hunk does not raise the tier. The record and the coverage line name it.

The GitHub review adds these keys:

| Key | Content |
|-----|---------|
| `identity.pr` | The PR number, or `null`. |
| `identity.github` | `null`, or `slug`, `title`, `draft`, `labels`, `author`, `author_type`, `author_write_access`, `fork`, `head_repo` and `url`. |
| `identity.description_meta` | `source` (`pr` or `commits`), `sanitized` and `truncated`. |
| `identity.run_kind` | `first`, `later` or `fresh`. |
| `identity.prior` | `null`, or `head`, `source` (`record`, `marker` or `null`), `record`, `open`, `dismissed` and `fetch_failed`. `open` and `dismissed` are lists of fingerprints. `fetch_failed` is `true` when the fetch of H0 failed. |
| `stages.pre_existing` | The verified pre-existing findings. |
| `posted.github` | `null`, or `review_id`, `review_url`, `error`, `inline`, `in_body`, `check_run`, `cleanup_comment_id`, `resolved` and `errors`. |
| `posted.below_floor` | The findings below the severity floor of a later run. |
| `posted.not_reposted` | For each finding that a later run did not post: `fingerprint` and `reason` (`open` or `dismissed`). |
| `posted.carried` | The full finding of every open fingerprint from earlier runs that this run did not post. |
| `span_text` on each posted finding | The normalized span text that the fingerprint hashes. |

The JSON output holds `reviewers_skipped`, `reviewers_without_bash` and `sensitive_without_hunks` in its `coverage` object. The table output shows the same three lists on its `Coverage` line.

## Measure the passes

`scripts/measure-passes.sh` measures the recall of `diff-bugs` with one pass against two passes. It builds the fixture repo twice. The base commit of the first fixture sets `reviewers.diff-bugs.passes` to 1. The base commit of the second sets it to 2. Both configs also set `enabled: false` for the six other built-in reviewers: `conventions`, `tests`, `security`, `history`, `description-drift` and `docs-and-comments`. Only `diff-bugs` runs. Every posted finding comes from `diff-bugs`. So `covered` measures `diff-bugs` alone. For each arm, the script runs `pr-review run --format json` the given number of times, with the `pr-review` command on your PATH.

```bash
scripts/measure-passes.sh 5
```

The script makes real SDK calls. It needs a Claude login and it costs money. The test suite does not run it against the SDK.

For each arm, the script prints one line:

```text
passes=2: runs=5 failed=0 covered=4 mean_cost_usd=1.2345 mean_findings=2.20
```

`covered` is the number of runs whose posted findings cover the planted line. `mean_cost_usd` and `mean_findings` are the mean cost and the mean count of posted findings per run. A run that fails is counted under `failed` and is not in the means.

## Smoke

Check that your login works:

```bash
pr-review smoke
```

The command sends one structured-output query to `claude-sonnet-5-5`. It prints the model, the cost and whether the output validated.

## Acceptance

The acceptance check runs a real review. It makes real SDK calls and costs money.

| Script | Purpose |
|--------|---------|
| `scripts/make-fixture.sh` | Builds a git repo in a temporary directory with a base commit and a head commit. The head commit plants one bug. Prints the two SHAs. |
| `scripts/acceptance.sh` | Runs `npm run build`. Runs `pr-review run --base <sha> --head <sha> --format json` inside the fixture repo. Prints the cost. |

Run it:

```bash
scripts/acceptance.sh
```

The script does not need `npm link`. It exits 0 when all of these are true:

- The review exits 0.
- The record holds a posted finding that covers the planted line.
- That finding carries a verifier pass.
