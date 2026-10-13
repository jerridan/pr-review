pr-review reviews the diff between two commits of a local git repo. It runs triage, one reviewer, verification and merge with the Claude Agent SDK. It writes a JSON run record.

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

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | The run wrote a record. This holds for every verdict. |
| 1 | The run could not write a record. |
| 2 | Usage error. |

Each run writes one file named `<timestamp>-<7-char head sha>.json` in the records directory.

With `--format json`, the command prints one JSON document to stdout. Its keys are `record_path`, `tier`, `verdict`, `coverage` and `findings`.

The verdict is one of `skipped`, `incomplete`, `would request changes` and `would approve`.

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
