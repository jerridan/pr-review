pr-review reviews the diff between two commits of a local git repo. It runs triage, seven reviewers, verification and merge with the Claude Agent SDK. It writes a JSON run record.

## Setup

| Need | Version |
|------|---------|
| OS | macOS or Linux |
| Shell | bash |
| Node | 20.19 or later |
| git | 2.40 or later |

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

The tool removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches from the environment of every query, so the subscription login is the only route. To keep them, pass `--allow-api-key`.

## Run

Run the command from inside the repo that you want to review:

```bash
pr-review run --base <sha> --head <sha>
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--base <sha>` | The base commit. | required |
| `--head <sha>` | The head commit. | required |
| `--repo <path>` | The repo to review. | current directory |
| `--format json\|table` | The output format. | `table` |
| `--out <dir>` | The directory for the run record. | `./pr-review-records` |
| `--tier full\|fast\|skip` | Force the review tier. | chosen by triage |
| `--allow-api-key` | Keep `ANTHROPIC_API_KEY` in the environment. | off |
| `--author-write-access` | Tell the run that the PR author has write access. See [`--author-write-access`](#--author-write-access). | off |

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | The run wrote a record. This holds for every verdict. |
| 1 | The run could not write a record. A config error is one such case. |
| 2 | Usage error. |

Each run writes one file named `<timestamp>-<7-char head sha>.json` in the records directory.

A config error exits with code 1. The run writes no record and sends no model query. The message on stderr names the file and the field. The exit code table did not change in meaning, because code 1 already means that the run wrote no record.

With `--format json`, the command prints one JSON document to stdout. Its keys are `record_path`, `tier`, `verdict`, `coverage`, `excluded_files`, `total_cost_usd`, `queries_without_cost` and `findings`. `total_cost_usd` is a lower bound when `queries_without_cost` is above 0. The [new keys](#record-and-output-keys) of the coverage are in this document.

The verdict is one of `skipped`, `incomplete`, `would request changes` and `would approve`.

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

- **Reviewer names.** `<name>` is a built-in reviewer or a custom reviewer. Any other name is an error.
- **Models.** A model is an alias (`opus`, `sonnet` or `haiku`) or an exact model id.
- **Effective model and effort.** The order is `reviewers.<name>.model`, then `models.reviewer.model`, then the frontmatter value. The effort follows the same order.
- **Roles.** The roles of `models.<role>` are `triage`, `reviewer`, `verifier`, `verifier-escalation` and `merge`. The defaults are `sonnet` with `medium` for triage, `opus` with `low` for reviewer, `sonnet` with `high` for verifier, `opus` with `high` for verifier-escalation, and `sonnet` with `medium` for merge. A `models.<role>` object can give `model` alone, `effort` alone, or both.
- **Skip fields.** The run parses, validates and records the `skip` fields. It does not apply them yet, because the CLI has no PR metadata.
- **`pre_existing`.** The run parses and records the key. It does not post comments yet.
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

The description is the subject and body of each commit between the base and the head. Every reviewer and the verifier get it. When the description is empty, `description-drift` does not run, and coverage lists it under `reviewers_skipped` with the reason `no description`. The same list names a reviewer that the config disables, with the reason `disabled by config`.

All passes of a reviewer use the same input. The run removes repeated findings by fingerprint before verification, so the verifier checks one copy. The record keeps the findings of every pass.

## `--author-write-access`

The option tells the run that the PR author has write access to the repo. The default is off.

```bash
pr-review run --base <sha> --head <sha> --author-write-access
```

With the option, a custom reviewer that sets `trusted: true` in its file and names Bash in `tools` gets Bash. Without it, that reviewer runs with read-only tools, and coverage gives the reason `author has no write access`. A later release sets the option from the PR.

## Record and output keys

The run record has these keys, added with the `.pr-review/` directory.

| Key | Content |
|-----|---------|
| `identity.config_hash` | The SHA-256 of the loaded `.pr-review/` files, or `null`. |
| `identity.config.files` | The paths of the loaded `.pr-review/` files. |
| `identity.config.values` | The validated config, with the defaults filled in. |
| `identity.config.custom_reviewers` | For each custom reviewer: `name`, `bash_granted` and `reason`. |
| `identity.description` | The description that every reviewer and the verifier got. |
| `identity.history` | `built` and `truncated`, for the history block. The history block has a cap of 65536 bytes. |
| `identity.injected` | For each injected rules file: `path` and `truncated`. |
| `stages.suppressed` | For each finding that a suppression removed: `finding`, `reviewer` and `rule`. `posted.findings` omits these findings. |
| `posted.coverage.reviewers_skipped` | For each selected reviewer or pass that did not run: `name`, `reason` and, for `token ceiling`, `pass`. |
| `posted.coverage.reviewers_without_bash` | For each custom reviewer that asked for Bash and did not get it: `name` and `reason`. |
| `posted.coverage.sensitive_without_hunks` | The sensitive paths with no text hunk, for example a mode flip or a binary. |

A sensitive path with no text hunk does not raise the tier. The record and the coverage line name it.

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
