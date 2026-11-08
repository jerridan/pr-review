// Make a checkout of a case from its git bundle. No network is used.
import { access, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGit } from "../gather/worktree.js";
import { CaseError, type Case } from "./case.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone the bundle of case "c" into "into" and check out its head commit
 * detached. Throw a CaseError when the clone fails or when base or head
 * does not resolve to a commit. Give the path of the checkout.
 *
 * A case made from a shallow repo holds the file "shallow": the commits
 * whose parents the bundle does not hold. Git refuses to clone such a
 * bundle. So the checkout starts as an empty repo that holds the same
 * shallow marks, and fetches the bundle into it.
 */
export async function cloneCase(c: Case, into: string): Promise<string> {
  const target = resolve(into);
  const bundle = join(c.dir, "repo.bundle");
  const shallow = join(c.dir, "shallow");
  const fail = (problem: string, err: unknown): never => {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CaseError(c.name, `case ${c.name}: ${problem}: ${reason}`, { cause: err });
  };

  if (await exists(shallow)) {
    await runGit(c.dir, ["init", "--quiet", target]).catch((err) =>
      fail("cannot make the checkout directory", err),
    );
    await copyFile(shallow, join(target, ".git", "shallow")).catch((err) =>
      fail("cannot copy the shallow file", err),
    );
    await runGit(target, ["fetch", "--quiet", bundle, "+refs/heads/*:refs/case/*"]).catch((err) =>
      fail("cannot fetch repo.bundle", err),
    );
  } else {
    await runGit(c.dir, ["clone", "--quiet", "--no-checkout", bundle, target]).catch((err) =>
      fail("cannot clone repo.bundle", err),
    );
  }
  for (const [label, sha] of [
    ["base", c.base],
    ["head", c.head],
  ] as const) {
    await runGit(target, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).catch((err) =>
      fail(`repo.bundle does not hold the ${label} commit ${sha}`, err),
    );
  }
  await runGit(target, ["checkout", "--quiet", "--detach", `${c.head}^{commit}`]).catch((err) =>
    fail(`cannot check out the head commit ${c.head}`, err),
  );
  return target;
}
