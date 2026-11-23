# D16 part b: the Codex CLI in CI on a ChatGPT subscription

## Open questions for the user

1. Which option do you choose: A (a self-hosted private runner), B (a GitHub-hosted job that carries the login file through a secret), C (an API key for this one reviewer), or D (the reviewer runs only where a logged-in Codex CLI exists, and CI skips it)? A and B are not allowed for a public repo. pr-review is public, so A and B can apply only to your private repos.
2. For A or B: do the terms of your plan permit a login that a CI job uses? The terms bar sharing account credentials, and they do not name Codex CI (see "Not documented").
3. For C: is an API cost of about $0.11 to $0.19 for each review acceptable?

## Question

Can the staff-engineer reviewer of D15 run in a CI job on the user's ChatGPT subscription, and not on an API key?

## Method

Web research only, on 2026-11-22, from the official sources of the vendor. No login file of this machine was read, and no login flow was run. The documentation pages show no date. The old `developers.openai.com/codex/*` addresses redirect to `learn.chatgpt.com/docs/*`. The three key quotes below were checked again on the source page.

## What the vendor documents

### Login modes

Source: https://learn.chatgpt.com/docs/auth

- The Codex CLI has two modes: "Sign in with ChatGPT for subscription access" and "Sign in with an API key for usage-based access."
- The browser login is `codex login`. The API-key login is `printenv OPENAI_API_KEY | codex login --with-api-key`. A headless login is `codex login --device-auth` ("Device code authentication (beta)"). It works only when device code login is turned on in the ChatGPT security settings or the workspace permissions.
- `codex login status` prints the login mode and exits with 0 when logged in. The output and the exit code when not logged in are not documented.
- The login lives in `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), or in the credential store of the system, by the setting `cli_auth_credentials_store`.
- The same page says: "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs."

### The ChatGPT login in CI

Source: https://learn.chatgpt.com/docs/auth/ci-cd-auth

A guide for this use exists. It permits it with warnings:

- "The right way to authenticate automation is with an API key."
- "API keys are still the recommended option for most CI/CD jobs."
- "Do not use this workflow for public or open-source repositories."
- Use it only on "trusted private infrastructure".
- "Treat `~/.codex/auth.json` like a password: it contains access tokens."

How a job gets the login, by the guide: on a trusted machine, log in with the file store. Put the whole content of `auth.json` in a secret (the guide calls it `CODEX_AUTH_JSON`). The job writes the secret to `$CODEX_HOME/auth.json` with tight permissions. Codex reads the file; no environment value carries the token. "The critical detail is to seed `auth.json` only if it is missing."

Refresh: "if `last_refresh` is older than about 8 days, Codex refreshes the token bundle before the run continues", and it writes the new tokens back to the file. So the file changes, and the job must keep the changed file for the next run.

Sharing: "Use one `auth.json` per runner or per serialized workflow stream." "Do not share the same file across concurrent jobs or multiple machines." A refresh on one machine makes the file of another machine stale, and then a person must log in again.

### Plan limits

Source: https://learn.chatgpt.com/docs/pricing

Local messages and cloud tasks share the allowance of the plan. Plus has limits for each five hours, and "Weekly limits may also apply". "Pro plans currently have no five-hour limit." The page gives no figures for the weekly limit. The same page calls an API key "Great for automation in shared environments like CI."

### Terms of use

Source: https://openai.com/policies/row-terms-of-use/

"You may not share your account credentials or make your account available to anyone else." The terms do not name Codex or CI.

### The official GitHub Action

Source: https://github.com/openai/codex-action

`openai/codex-action` takes an `openai-api-key` input. Its README does not name a ChatGPT login. It has a `codex-home` input, so a seeded `auth.json` may work with it, but that is not documented.

### The API price of Sol 6.2

Source: https://developers.openai.com/api/docs/pricing

`gpt-6.2-sol`, standard, short context: $2.00 for each 1M input tokens, $0.10 for each 1M cached input tokens, $10.00 for each 1M output tokens.

## Not documented

- A way for a GitHub-hosted job to write the refreshed login file back to its secret.
- A fixed lifetime of a session or of a refresh token.
- The size of the weekly limit.
- Whether the terms of a plan permit a login that a CI job uses.
- A ChatGPT login in `openai/codex-action`.
- The output and the exit code of `codex login status` when not logged in.

## The options

pr-review itself is a public repo, so it cannot use A or B by the rule of the vendor. A and B can apply only to a private repo of the user that runs the review in its own CI.

### A: a self-hosted private runner with a persistent Codex home

- What it is: a runner on a machine of the user. The Codex home stays on that machine between jobs, so the refreshed login stays too. One runner, one job at a time.
- The tool must: find the Codex CLI and its login state with no read of a credential, run the reviewer, and skip it with a reason when it cannot run (design, part a).
- The user must: set up and keep the runner, log in on it once, and log in again when the vendor asks. Private repos only.
- Cost: no API cost. The reviews count against the plan: about 1.5 points of the five-hour window and 0.2 of the week for each review (D15).

### B: a GitHub-hosted job that carries the login file through a secret

- What it is: the job writes the secret to `auth.json` before the review.
- Why it is fragile: after about 8 days Codex refreshes the tokens and changes the file. A GitHub-hosted job ends with its machine, so the changed file is lost unless the job writes it back to the secret, and the vendor gives no way to do that. Two jobs at once use one file, which the vendor forbids, and a refresh in one job makes the other stale. The login then fails until the user logs in again and updates the secret.
- The tool must: the same as A.
- The user must: log in, put the file in a secret, find a way to store the refreshed file, and log in again when it breaks. Private repos only.
- Cost: no API cost; plan allowance as in A.

### C: an API key for this one reviewer

- What it is: the way that the vendor recommends. A workflow step gives the key from a secret to `codex login --with-api-key` before the review. The design keeps the key out of the environment of the Codex process (`docs/design/staff-reviewer.md`, "The sandbox"), so the `openai-api-key` input of `openai/codex-action` does not fit.
- The tool must: the same as A. Rule 4 of CLAUDE.md holds: the workflow passes the key to the Codex CLI, and the tool never reads, writes or logs it.
- The user must: create an API key, put it in a secret, and pay for the use. It works for public and private repos.
- Cost: a D15 review used about 57,000 to 67,000 tokens. The record holds only the total, not the split between input, cached input and output. At the list price, all input gives $0.11 to $0.13 for each review. With about 10% output, a review costs about $0.16 to $0.19. Cached input lowers it. So about $0.11 to $0.19 for each review.

### D: the reviewer runs only where a logged-in Codex CLI already exists

- What it is: the user's machine, through the local CLI and the plugin. CI does not run the reviewer, and the summary of a CI review says that it did not run and why.
- The tool must: the same skip path as in A, with the reason `codex not installed` or `codex not logged in`.
- The user must: nothing more than a login on their own machine.
- Cost: plan allowance on the user's machine only.

## Limits

- The research read the vendor's pages on one day. The pages show no dates and can change.
- The cost of C rests on the D15 token totals, with an assumed split between input and output.
