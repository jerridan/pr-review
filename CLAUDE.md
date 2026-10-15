# pr-review

pr-review is a CLI that reviews a diff with the Claude Agent SDK. Follow the five rules below in every change.

## Rules

1. **TypeScript, as ESM.** Write TypeScript for Node 20 or later. Use `import` and `export`. Never use `require`. Why: one module system keeps the build and the `bin` entry simple.
2. **Test with vitest, and test behaviour.** Every change has a vitest test. A unit test needs no network and no credentials. Apply five checks to each test: it names one behaviour; it asserts only what a user or caller can observe, such as a return value, output, an exit code, a record, a file, or a request that leaves the process; a rename of an internal would not break it; breaking the behaviour would make it fail; it checks a call or an argument list only when that call is the behaviour, such as a request to a third party. A test survives every change that keeps the behaviour it names at the boundary it observes. Use a fake when the real thing is awkward: a third party, a model call, the clock, or something slow or nondeterministic. A module of this repo is fast and deterministic, so do not fake it. Never test a fake for its own sake, and never restate the code. When two tests fail for the same defect, keep the lower one, the one with the smaller scope and the faster run. Keep the higher one only when it proves something the lower one cannot, such as the wiring between modules or the output a user sees. Why: a test of the implementation breaks on every refactor and proves nothing, and every test has a cost.
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
