import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCases } from "../src/eval/case.js";
import { cloneCase } from "../src/eval/checkout.js";
import { injectionInstructions, injectionVariantsCommand } from "../src/eval/injection/variants.js";
import {
  BUG_LINE,
  PLAIN_BODY,
  PLAIN_TITLE,
  git,
  hashTree,
  makeInjectionCases,
} from "./fixtures/injection-cases.js";
import { captureOutput, output, tempDir, cleanup } from "./fixtures/eval-fixture.js";

const made: string[] = [];
let input: ReturnType<typeof makeInjectionCases>;
let out = "";
let inputHash = "";
const instructions = injectionInstructions();

beforeAll(async () => {
  input = makeInjectionCases([
    { name: "inj-a", file: "src/mean.ts" },
    { name: "plain-pr", file: "src/mean.ts", source: "pr" },
  ]);
  made.push(join(input.dir, ".."));
  inputHash = hashTree(input.dir);
  out = join(tempDir("variants-out", made), "out");
  expect(await injectionVariantsCommand(["--cases", input.dir, "--out", out])).toBe(0);
}, 60_000);
afterAll(() => cleanup(made));
captureOutput();
afterEach(() => vi.restoreAllMocks());

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const ARMS = ["body-no-finding", "body-reviewed-safe", "body-print-prompt", "commit", "comment"];

describe("pr-review eval-injection-variants", () => {
  it("copies the injection case with its injection patch, and makes five variants", async () => {
    const cases = await loadCases(out);
    expect(cases.map((c) => c.name)).toEqual(["inj-a", ...ARMS.map((a) => `inj-a--${a}`)].sort());
    expect(existsSync(join(out, "inj-a", "injection.patch"))).toBe(true);
    for (const file of [
      "case.json",
      "repo.bundle",
      "diff.patch",
      "golden.json",
      "injection.patch",
    ]) {
      expect(readFileSync(join(out, "inj-a", file))).toEqual(
        readFileSync(join(input.caseDir("inj-a"), file)),
      );
    }
    expect(existsSync(join(out, "plain-pr"))).toBe(false);
  });

  it("sets variant_of and the source on each variant", async () => {
    const cases = await loadCases(out);
    for (const arm of ARMS) {
      const c = cases.find((x) => x.name === `inj-a--${arm}`);
      expect(c?.source).toBe("injection");
      expect(c?.variant_of).toEqual({ case: "inj-a", arm });
    }
    expect(cases.find((x) => x.name === "inj-a")?.variant_of).toBeUndefined();
  });

  it("changes only the body in a body variant, to the plain body, a blank line, the instruction", () => {
    const plain = json(join(out, "inj-a", "case.json"));
    const texts: Record<string, string> = {
      "body-no-finding": instructions.noFinding,
      "body-reviewed-safe": instructions.reviewedSafe,
      "body-print-prompt": instructions.printPrompt,
    };
    for (const [arm, text] of Object.entries(texts)) {
      const dir = join(out, `inj-a--${arm}`);
      const meta = json(join(dir, "case.json"));
      expect(meta).toEqual({
        ...plain,
        name: `inj-a--${arm}`,
        body: `${PLAIN_BODY}\n\n${text}`,
        variant_of: { case: "inj-a", arm },
      });
      for (const file of ["repo.bundle", "diff.patch", "golden.json"]) {
        expect(readFileSync(join(dir, file))).toEqual(readFileSync(join(out, "inj-a", file)));
      }
    }
  });

  it("puts the no-finding instruction in a new head commit message for the commit variant", async () => {
    const [plain] = (await loadCases(out)).filter((c) => c.name === "inj-a");
    const [variant] = (await loadCases(out)).filter((c) => c.name === "inj-a--commit");
    if (!plain || !variant) throw new Error("missing case");
    const meta = json(join(out, "inj-a--commit", "case.json"));
    expect(meta.description_from).toBe("commits");
    expect(variant.body).toBe(PLAIN_BODY);
    expect(variant.title).toBe(PLAIN_TITLE);
    expect(variant.head).not.toBe(plain.head);
    const tmp = tempDir("variants-clone", made);
    const checkout = await cloneCase(variant, join(tmp, "repo"));
    expect(git(checkout, "log", "-1", "--format=%B", variant.head)).toBe(
      `${PLAIN_TITLE}\n\n${PLAIN_BODY}\n\n${instructions.noFinding}`,
    );
    expect(git(checkout, "rev-parse", `${variant.head}^`)).toBe(input.base("inj-a"));
    const plainCheckout = await cloneCase(plain, join(tmp, "plain"));
    expect(git(checkout, "rev-parse", `${variant.head}^{tree}`)).toBe(
      git(plainCheckout, "rev-parse", `${plain.head}^{tree}`),
    );
    const identity = "%an|%ae|%aI|%cn|%ce|%cI";
    expect(git(checkout, "log", "-1", `--format=${identity}`, variant.head)).toBe(
      git(plainCheckout, "log", "-1", `--format=${identity}`, plain.head),
    );
  }, 60_000);

  it("adds the already-reviewed instruction as a comment at the end of a file for the comment variant", async () => {
    const cases = await loadCases(out);
    const plain = cases.find((c) => c.name === "inj-a");
    const variant = cases.find((c) => c.name === "inj-a--comment");
    if (!plain || !variant) throw new Error("missing case");
    expect(variant.golden).toEqual(plain.golden);
    expect(plain.golden[0]?.start_line).toBe(BUG_LINE);
    const diff = readFileSync(join(out, "inj-a--comment", "diff.patch"), "utf8");
    expect(diff).toContain(`+// ${instructions.reviewedSafe}`);
    const tmp = tempDir("variants-clone", made);
    const checkout = await cloneCase(variant, join(tmp, "repo"));
    const file = readFileSync(join(checkout, "src/mean.ts"), "utf8");
    expect(file.trimEnd().split("\n").at(-1)).toBe(`// ${instructions.reviewedSafe}`);
    expect(file.split("\n")[BUG_LINE - 1]).toContain("reduce");
    expect(git(checkout, "log", "-1", "--format=%B", variant.head)).toBe(
      `${PLAIN_TITLE}\n\n${PLAIN_BODY}`,
    );
    expect(git(checkout, "rev-parse", `${variant.head}^`)).toBe(input.base("inj-a"));
  }, 60_000);

  it("does not change the input directory", () => {
    expect(hashTree(input.dir)).toBe(inputHash);
  });

  it("gives the same head shas on a second run", async () => {
    const again = join(tempDir("variants-again", made), "out");
    expect(await injectionVariantsCommand(["--cases", input.dir, "--out", again])).toBe(0);
    const heads = async (dir: string) => (await loadCases(dir)).map((c) => [c.name, c.head]);
    expect(await heads(again)).toEqual(await heads(out));
  }, 60_000);

  it("fails before any write when --out is inside the input directory", async () => {
    const inside = join(input.dir, "nested", "out");
    expect(await injectionVariantsCommand(["--cases", input.dir, "--out", inside])).not.toBe(0);
    expect(existsSync(join(input.dir, "nested"))).toBe(false);
    expect(hashTree(input.dir)).toBe(inputHash);
  });

  it("fails before any write when --out is inside eval/cases under the working directory", async () => {
    const cwd = tempDir("variants-cwd", made);
    mkdirSync(join(cwd, "eval", "cases"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const target = join(cwd, "eval", "cases", "new");
    expect(await injectionVariantsCommand(["--cases", input.dir, "--out", target])).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("fails before any write when the input holds no injection case", async () => {
    const only = makeInjectionCases([{ name: "only-pr", file: "src/mean.ts", source: "pr" }]);
    made.push(join(only.dir, ".."));
    const target = join(tmpdir(), `pr-review-no-injection-${process.pid}`, "out");
    expect(await injectionVariantsCommand(["--cases", only.dir, "--out", target])).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    rmSync(join(target, ".."), { recursive: true, force: true });
  }, 60_000);

  it("makes no variant of a case with no file for a comment, and names the case", async () => {
    const odd = makeInjectionCases([{ name: "inj-odd", file: "data/mean.xyz" }]);
    made.push(join(odd.dir, ".."));
    const target = join(tempDir("variants-odd", made), "out");
    expect(await injectionVariantsCommand(["--cases", odd.dir, "--out", target])).not.toBe(0);
    expect(output.stderr).toContain("inj-odd");
    expect(existsSync(join(target, "inj-odd--comment"))).toBe(false);
    expect(existsSync(join(target, "inj-odd--body-no-finding"))).toBe(false);
  }, 60_000);
});
