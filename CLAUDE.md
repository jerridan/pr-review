# pr-review

pr-review is a CLI that reviews a diff with the Claude Agent SDK. Follow the five rules below in every change.

## Rules

1. **TypeScript, as ESM.** Write TypeScript for Node 20 or later. Use `import` and `export`. Never use `require`. Why: one module system keeps the build and the `bin` entry simple.
2. **Test with vitest, and test behaviour.** Every change has a vitest test. A unit test needs no network and no credentials. A test asserts what a caller can observe: a return value, a record, a file, an exit code, or the request that reaches a third party. It never asserts how the code got there. Replace only a third party with a fake: the SDK client, the `gh` client, or git in a fixture. Never mock a module of this repo, and never test a fake for its own sake. Why: the suite must run on any machine and in CI, and a test of the implementation breaks on every refactor and proves nothing.
3. **Keep prompts in markdown.** Every prompt sent to a model lives in a markdown file with YAML frontmatter under `prompts/`. TypeScript holds only the code that inserts data. Why: a reviewer edits a prompt without reading code.
4. **Keep credentials out of code.** Never read, write, log or commit a credential. Never add a credential file. The SDK subprocess finds the login itself. Why: the tool must never hold a secret.
5. **Write ASD-STE100 prose.** Use it in every markdown file and every code comment. Write short sentences in active voice, with one instruction each. Why: plain text is easy to read and hard to misread.

## Commands

Run all four before you finish a change:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

## Where things live

- `docs/design/` holds the design. Read `high-level-design.md` before you change the pipeline.
- `docs/research/` holds the research notes. `claude-5-5-models.md` fixes the model pins and the SDK query options.
- `action.yml`, `.github/workflows/review.yml`, `.claude-plugin/` and `commands/` package the tool for CI and for Claude Code. This repo is its own Claude Code marketplace, so add no entry in another repo.
- TICKETS.md lists the deliverables that remain. The spec for a deliverable in progress lives outside this repo; ask for its path before you start.
