import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitHubError } from "../src/github/client.js";
import { createGhClient, parseRemoteSlug } from "../src/github/gh.js";

const run = promisify(execFile);

// A fake token. It matches the form of a real GitHub token, so the
// redaction in the client applies to it.
const FAKE_TOKEN = `ghp_${"Z9".repeat(18)}`;
const SLUG = "acme/widgets";
const SYSTEM_PATH = "/usr/bin:/bin";

// A stub for gh. Call n writes its arguments (NUL-separated), its stdin
// and the presence of GH_TOKEN to files. Then it prints the canned
// stderr and stdout for call n and exits with the canned code.
const STUB = `#!/usr/bin/env bash
set -euo pipefail
dir="$GH_STUB_DIR"
n=1
while [ -e "$dir/args-$n" ]; do n=$((n + 1)); done
printf '%s\\0' "$@" > "$dir/args-$n"
cat > "$dir/stdin-$n"
printf '%s' "\${GH_TOKEN:+set}" > "$dir/token-$n"
if [ -f "$dir/stderr-$n" ]; then cat "$dir/stderr-$n" >&2; fi
if [ -f "$dir/stdout-$n" ]; then cat "$dir/stdout-$n"; fi
exit "$(cat "$dir/exit-$n" 2>/dev/null || echo 0)"
`;

type Reply = { stdout?: unknown; stderr?: string; exit?: number };
type Call = { args: string[]; stdin: string; token: string };

let work: string;
let bin: string;
let stubPath: string;
let dir: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pr-review-gh-"));
  bin = join(work, "bin");
  mkdirSync(bin);
  stubPath = join(bin, "gh");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(work, "calls-"));
});

// No call may put the token in an argument or on stdin.
afterEach(() => {
  for (const call of calls()) {
    for (const arg of call.args) expect(arg).not.toContain(FAKE_TOKEN);
    expect(call.stdin).not.toContain(FAKE_TOKEN);
  }
});

function env(path = `${bin}:${SYSTEM_PATH}`): NodeJS.ProcessEnv {
  return { PATH: path, GH_TOKEN: FAKE_TOKEN, GH_STUB_DIR: dir };
}

function client() {
  return createGhClient({ env: env() });
}

/** Give the canned replies for calls 1, 2, and so on. */
function reply(...replies: Reply[]): void {
  replies.forEach((r, i) => {
    const n = i + 1;
    if (r.stdout !== undefined) {
      const text = typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout);
      writeFileSync(join(dir, `stdout-${n}`), text);
    }
    if (r.stderr !== undefined) writeFileSync(join(dir, `stderr-${n}`), r.stderr);
    if (r.exit !== undefined) writeFileSync(join(dir, `exit-${n}`), String(r.exit));
  });
}

function calls(): Call[] {
  const out: Call[] = [];
  for (let n = 1; existsSync(join(dir, `args-${n}`)); n++) {
    const raw = readFileSync(join(dir, `args-${n}`), "utf8");
    out.push({
      args: raw.split("\0").slice(0, -1),
      stdin: readFileSync(join(dir, `stdin-${n}`), "utf8"),
      token: readFileSync(join(dir, `token-${n}`), "utf8"),
    });
  }
  return out;
}

function onlyCall(): Call {
  const all = calls();
  expect(all).toHaveLength(1);
  return all[0]!;
}

function graphqlBody(call: Call): { query: string; variables: Record<string, unknown> } {
  expect(call.args).toEqual(["api", "graphql", "--input", "-"]);
  return JSON.parse(call.stdin) as { query: string; variables: Record<string, unknown> };
}

const REST_PR = {
  number: 7,
  title: "Add a widget",
  body: "Body text",
  state: "open",
  draft: true,
  labels: [{ name: "skip-review" }, { name: "docs" }],
  user: { login: "alice", type: "User" },
  head: { sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
  base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
  html_url: "https://github.com/acme/widgets/pull/7",
};

describe("createGhClient: REST reads (R1)", () => {
  it("reads a pull request with GET and maps its fields", async () => {
    reply({ stdout: REST_PR });
    const pr = await client().getPullRequest({ slug: SLUG, number: 7 });
    expect(pr).toEqual({
      number: 7,
      title: "Add a widget",
      body: "Body text",
      state: "open",
      draft: true,
      labels: ["skip-review", "docs"],
      author: "alice",
      author_type: "User",
      head_sha: "a".repeat(40),
      head_repo: "acme/widgets",
      fork: false,
      base_ref: "main",
      base_sha: "b".repeat(40),
      url: "https://github.com/acme/widgets/pull/7",
    });
    const call = onlyCall();
    expect(call.args).toEqual(["api", "-X", "GET", "repos/acme/widgets/pulls/7"]);
    expect(call.stdin).toBe("");
  });

  it("passes the env through, so gh finds GH_TOKEN itself", async () => {
    reply({ stdout: REST_PR });
    await client().getPullRequest({ slug: SLUG, number: 7 });
    expect(onlyCall().token).toBe("set");
  });

  it("sets the fork flag for a head repo that differs from the base repo or is gone", async () => {
    reply(
      { stdout: { ...REST_PR, head: { sha: "a".repeat(40), repo: { full_name: "eve/widgets" } } } },
      { stdout: { ...REST_PR, body: null, head: { sha: "a".repeat(40), repo: null } } },
    );
    const gh = client();
    const fork = await gh.getPullRequest({ slug: SLUG, number: 7 });
    expect(fork.fork).toBe(true);
    expect(fork.head_repo).toBe("eve/widgets");
    const gone = await gh.getPullRequest({ slug: SLUG, number: 7 });
    expect(gone.fork).toBe(true);
    expect(gone.head_repo).toBe("");
    expect(gone.body).toBe("");
  });

  it("reads the permission, and prefers role_name", async () => {
    reply(
      { stdout: { permission: "write", role_name: "maintain" } },
      { stdout: { permission: "admin", role_name: "custom-role" } },
    );
    const gh = client();
    expect(await gh.getPermission({ slug: SLUG, login: "alice" })).toBe("maintain");
    expect(await gh.getPermission({ slug: SLUG, login: "dependabot[bot]" })).toBe("admin");
    const [first, second] = calls();
    expect(first!.args).toEqual([
      "api",
      "-X",
      "GET",
      "repos/acme/widgets/collaborators/alice/permission",
    ]);
    expect(second!.args).toEqual([
      "api",
      "-X",
      "GET",
      "repos/acme/widgets/collaborators/dependabot%5Bbot%5D/permission",
    ]);
  });

  it("gives none for a user GitHub does not know on the repo (HTTP 404)", async () => {
    reply({ stderr: "gh: Not Found (HTTP 404)\n", exit: 1 });
    expect(await client().getPermission({ slug: SLUG, login: "stranger" })).toBe("none");
  });

  it("refuses a login or a slug that is not a plain name, before it runs gh", async () => {
    const gh = client();
    await expect(gh.getPermission({ slug: SLUG, login: "../x" })).rejects.toBeInstanceOf(
      GitHubError,
    );
    await expect(gh.getPullRequest({ slug: "acme/../x", number: 1 })).rejects.toBeInstanceOf(
      GitHubError,
    );
    await expect(gh.getPullRequest({ slug: "-X", number: 1 })).rejects.toBeInstanceOf(GitHubError);
    await expect(gh.getPullRequest({ slug: SLUG, number: 1.5 })).rejects.toBeInstanceOf(
      GitHubError,
    );
    expect(calls()).toEqual([]);
  });

  it("lists the reviews over all pages", async () => {
    const page1 = [
      {
        id: 1,
        body: "one",
        user: { login: "alice" },
        commit_id: "c".repeat(40),
        html_url: "https://x/1",
      },
    ];
    const page2 = [{ id: 2, body: null, user: null, commit_id: null, html_url: "https://x/2" }];
    reply({ stdout: `${JSON.stringify(page1)}${JSON.stringify(page2)}` });
    const reviews = await client().listReviews({ slug: SLUG, number: 7 });
    expect(reviews).toEqual([
      { id: 1, body: "one", author: "alice", commit_id: "c".repeat(40), url: "https://x/1" },
      { id: 2, body: "", author: "ghost", commit_id: null, url: "https://x/2" },
    ]);
    expect(onlyCall().args).toEqual([
      "api",
      "-X",
      "GET",
      "--paginate",
      "repos/acme/widgets/pulls/7/reviews?per_page=100",
    ]);
  });

  it("lists the reactions on a review comment", async () => {
    reply({
      stdout: [
        { content: "-1", user: { login: "alice" } },
        { content: "+1", user: { login: "bob" } },
      ],
    });
    expect(await client().listReactions({ slug: SLUG, comment_id: 55 })).toEqual([
      { content: "-1", user: "alice" },
      { content: "+1", user: "bob" },
    ]);
    expect(onlyCall().args).toEqual([
      "api",
      "-X",
      "GET",
      "--paginate",
      "repos/acme/widgets/pulls/comments/55/reactions?per_page=100",
    ]);
  });

  it("lists the issue comments", async () => {
    reply({ stdout: `[{"id":3,"body":"hi","user":{"login":"bot[bot]"}}]\n[]` });
    expect(await client().listIssueComments({ slug: SLUG, number: 7 })).toEqual([
      { id: 3, body: "hi", author: "bot[bot]" },
    ]);
    expect(onlyCall().args).toEqual([
      "api",
      "-X",
      "GET",
      "--paginate",
      "repos/acme/widgets/issues/7/comments?per_page=100",
    ]);
  });
});

describe("createGhClient: REST writes (R1)", () => {
  it("creates a review with event COMMENT and the body on stdin", async () => {
    reply({ stdout: { id: 900, html_url: "https://github.com/acme/widgets/pull/7#r900" } });
    const comments = [
      { path: "a.ts", line: 3, side: "RIGHT" as const, body: "first" },
      {
        path: "b.ts",
        line: 9,
        start_line: 7,
        side: "RIGHT" as const,
        start_side: "RIGHT" as const,
        body: "second",
      },
    ];
    const out = await client().createReview({
      slug: SLUG,
      number: 7,
      commit_id: "c".repeat(40),
      body: "Summary",
      comments,
    });
    expect(out).toEqual({ id: 900, url: "https://github.com/acme/widgets/pull/7#r900" });
    const call = onlyCall();
    expect(call.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/acme/widgets/pulls/7/reviews",
      "--input",
      "-",
    ]);
    expect(JSON.parse(call.stdin)).toEqual({
      commit_id: "c".repeat(40),
      body: "Summary",
      event: "COMMENT",
      comments,
    });
  });

  it("replies to a review comment", async () => {
    reply({ stdout: { id: 901 } });
    expect(
      await client().replyToComment({ slug: SLUG, number: 7, comment_id: 55, body: "Fixed." }),
    ).toEqual({ id: 901 });
    const call = onlyCall();
    expect(call.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/acme/widgets/pulls/7/comments/55/replies",
      "--input",
      "-",
    ]);
    expect(JSON.parse(call.stdin)).toEqual({ body: "Fixed." });
  });

  it("creates an issue comment", async () => {
    reply({ stdout: { id: 902 } });
    expect(await client().createIssueComment({ slug: SLUG, number: 7, body: "Note" })).toEqual({
      id: 902,
    });
    const call = onlyCall();
    expect(call.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/acme/widgets/issues/7/comments",
      "--input",
      "-",
    ]);
    expect(JSON.parse(call.stdin)).toEqual({ body: "Note" });
  });

  it("updates an issue comment with PATCH", async () => {
    reply({ stdout: { id: 902 } });
    await client().updateIssueComment({ slug: SLUG, comment_id: 902, body: "New" });
    const call = onlyCall();
    expect(call.args).toEqual([
      "api",
      "-X",
      "PATCH",
      "repos/acme/widgets/issues/comments/902",
      "--input",
      "-",
    ]);
    expect(JSON.parse(call.stdin)).toEqual({ body: "New" });
  });

  it("creates a completed check run", async () => {
    reply({ stdout: { id: 903 } });
    const out = await client().createCheckRun({
      slug: SLUG,
      head_sha: "d".repeat(40),
      name: "pr-review",
      title: "Title",
      summary: "Summary",
      conclusion: "neutral",
    });
    expect(out).toEqual({ id: 903 });
    const call = onlyCall();
    expect(call.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/acme/widgets/check-runs",
      "--input",
      "-",
    ]);
    expect(JSON.parse(call.stdin)).toEqual({
      name: "pr-review",
      head_sha: "d".repeat(40),
      status: "completed",
      conclusion: "neutral",
      output: { title: "Title", summary: "Summary" },
    });
  });
});

describe("createGhClient: GraphQL (R1)", () => {
  it("reads the viewer login", async () => {
    reply({ stdout: { data: { viewer: { __typename: "User", login: "octocat" } } } });
    expect(await client().viewerLogin()).toBe("octocat");
    const body = graphqlBody(onlyCall());
    expect(body.query).toMatch(/viewer\s*\{\s*__typename\s+login\s*\}/);
  });

  it("adds [bot] to the viewer login when the viewer is a bot", async () => {
    reply({ stdout: { data: { viewer: { __typename: "Bot", login: "my-app" } } } });
    expect(await client().viewerLogin()).toBe("my-app[bot]");
  });

  it("lists the review comments with their threads, over all thread pages", async () => {
    const comment = (id: number, extra: object) => ({
      databaseId: id,
      id: `PRRC_${id}`,
      body: `c${id}`,
      path: "a.ts",
      line: id,
      startLine: null,
      author: { __typename: "User", login: "alice" },
      pullRequestReview: { databaseId: 77 },
      reactions: { totalCount: 0 },
      ...extra,
    });
    const page = (
      threads: { id: string; comments: object[] }[],
      next: string | null,
    ): { data: object } => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: next !== null, endCursor: next },
              nodes: threads.map((t) => ({
                id: t.id,
                isResolved: false,
                comments: { nodes: t.comments },
                lastComment: { nodes: [] },
              })),
            },
          },
        },
      },
    });
    reply(
      {
        stdout: page(
          [
            {
              id: "T1",
              comments: [
                comment(1, { author: { __typename: "Bot", login: "github-actions" } }),
                comment(2, { pullRequestReview: null, startLine: 1 }),
              ],
            },
          ],
          "CUR1",
        ),
      },
      { stdout: page([{ id: "T2", comments: [comment(3, { author: null, line: null })] }], null) },
    );
    const out = await client().listReviewComments({ slug: SLUG, number: 7 });
    const open = { thread_resolved: false, thumbs_down: 0, thread_last_comment: null };
    expect(out).toEqual([
      {
        id: 1,
        node_id: "PRRC_1",
        body: "c1",
        path: "a.ts",
        line: 1,
        start_line: null,
        author: "github-actions[bot]",
        thread_id: "T1",
        review_id: 77,
        ...open,
      },
      {
        id: 2,
        node_id: "PRRC_2",
        body: "c2",
        path: "a.ts",
        line: 2,
        start_line: 1,
        author: "alice",
        thread_id: "T1",
        review_id: null,
        ...open,
      },
      {
        id: 3,
        node_id: "PRRC_3",
        body: "c3",
        path: "a.ts",
        line: null,
        start_line: null,
        author: "ghost",
        thread_id: "T2",
        review_id: 77,
        ...open,
      },
    ]);
    const [first, second] = calls().map(graphqlBody);
    expect(first!.query).toContain("reviewThreads");
    expect(first!.query).toContain("pageInfo");
    expect(first!.variables).toEqual({ owner: "acme", name: "widgets", number: 7, cursor: null });
    expect(second!.variables).toEqual({
      owner: "acme",
      name: "widgets",
      number: 7,
      cursor: "CUR1",
    });
  });

  it("gives the resolved flag, the thumbs-down count and the last comment of each thread in one call", async () => {
    // The thread holds more comments than the first page. Its last comment
    // comes from its own field, not from the end of the page.
    const node = (id: number, login: string, downs: number) => ({
      databaseId: id,
      id: `PRRC_${id}`,
      body: `c${id}`,
      path: "a.ts",
      line: 3,
      startLine: null,
      author: { __typename: "User", login },
      pullRequestReview: { databaseId: 77 },
      reactions: { totalCount: downs },
    });
    reply({
      stdout: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: true,
                    comments: { nodes: [node(1, "alice", 2), node(2, "bob", 0)] },
                    lastComment: {
                      nodes: [
                        {
                          body: "Resolved by pr-review: x",
                          author: { __typename: "Bot", login: "pr-review" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const out = await client().listReviewComments({ slug: SLUG, number: 7 });
    expect(calls()).toHaveLength(1);
    expect(out.map((c) => [c.id, c.thread_resolved, c.thumbs_down, c.thread_last_comment])).toEqual(
      [
        [1, true, 2, { author: "pr-review[bot]", body: "Resolved by pr-review: x" }],
        [2, true, 0, { author: "pr-review[bot]", body: "Resolved by pr-review: x" }],
      ],
    );
  });

  it("reads a thread by its node id, with its first comment id and its last comment", async () => {
    reply({
      stdout: {
        data: {
          node: {
            id: "T1",
            isResolved: true,
            comments: {
              nodes: [
                { databaseId: 1, body: "x", author: { __typename: "User", login: "alice" } },
                { databaseId: 2, body: "y", author: { __typename: "Bot", login: "pr-review" } },
              ],
            },
            firstComment: { nodes: [{ databaseId: 1 }] },
            lastComment: {
              nodes: [{ body: "z", author: { __typename: "User", login: "carol" } }],
            },
          },
        },
      },
    });
    expect(await client().getThread({ thread_id: "T1" })).toEqual({
      id: "T1",
      resolved: true,
      comments: [
        { id: 1, body: "x", author: "alice" },
        { id: 2, body: "y", author: "pr-review[bot]" },
      ],
      first_comment_id: 1,
      last_comment: { author: "carol", body: "z" },
    });
    const body = graphqlBody(onlyCall());
    expect(body.query).toContain("PullRequestReviewThread");
    expect(body.variables).toEqual({ id: "T1" });
  });

  it("gives no first comment id and no last comment for a thread with no comment", async () => {
    reply({
      stdout: {
        data: {
          node: {
            id: "T1",
            isResolved: false,
            comments: { nodes: [] },
            firstComment: { nodes: [] },
            lastComment: { nodes: [] },
          },
        },
      },
    });
    expect(await client().getThread({ thread_id: "T1" })).toMatchObject({
      first_comment_id: null,
      last_comment: null,
    });
  });

  it("throws a GitHubError for a thread id that names no thread", async () => {
    reply({ stdout: { data: { node: null } } });
    const err = await client()
      .getThread({ thread_id: "nope" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).endpoint).toBe("graphql");
  });

  it("resolves a thread with the resolveReviewThread mutation", async () => {
    reply({
      stdout: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } },
    });
    await client().resolveThread({ thread_id: "T1" });
    const body = graphqlBody(onlyCall());
    expect(body.query).toMatch(
      /mutation[\s\S]*resolveReviewThread\(input:\s*\{\s*threadId:\s*\$id/,
    );
    expect(body.variables).toEqual({ id: "T1" });
  });

  it("throws a GitHubError when the response has no data", async () => {
    reply({ stdout: { errors: [{ message: "bad" }] } });
    await expect(client().viewerLogin()).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("createGhClient: errors (R1)", () => {
  it("throws a GitHubError with the endpoint and the exit code, and no token", async () => {
    reply({
      stderr: `gh: Bad credentials (HTTP 401) for ${FAKE_TOKEN} and github_pat_${"A1".repeat(20)}\n`,
      exit: 4,
    });
    const err = await client()
      .getPullRequest({ slug: SLUG, number: 7 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    const ghErr = err as GitHubError;
    expect(ghErr.endpoint).toBe("repos/acme/widgets/pulls/7");
    expect(ghErr.exitCode).toBe(4);
    expect(ghErr.message).toContain("repos/acme/widgets/pulls/7");
    expect(ghErr.message).toContain("4");
    expect(ghErr.message).toContain("Bad credentials");
    expect(ghErr.message).not.toContain(FAKE_TOKEN);
    expect(ghErr.message).not.toContain("github_pat_A1");
    expect(String(ghErr.stack)).not.toContain(FAKE_TOKEN);
  });

  it("throws a GitHubError for output that is not JSON", async () => {
    reply({ stdout: "not json" });
    const err = await client()
      .getPullRequest({ slug: SLUG, number: 7 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).endpoint).toBe("repos/acme/widgets/pulls/7");
  });

  it("names gh when the binary is not on PATH", async () => {
    const empty = mkdtempSync(join(work, "empty-"));
    const gh = createGhClient({ env: env(empty) });
    const err = await gh.viewerLogin().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).exitCode).toBeNull();
    expect((err as GitHubError).endpoint).toBe("graphql");
    expect((err as GitHubError).message).toMatch(/\bgh\b/);
    expect((err as GitHubError).message).toMatch(/not (found|installed)/);
  });

  it("runs the binary at ghPath", async () => {
    reply({ stdout: REST_PR });
    const gh = createGhClient({ ghPath: stubPath, env: env(SYSTEM_PATH) });
    expect((await gh.getPullRequest({ slug: SLUG, number: 7 })).number).toBe(7);
    expect(onlyCall().args[0]).toBe("api");
  });
});

describe("resolveSlug (R1)", () => {
  async function repoWithOrigin(url: string | null): Promise<string> {
    const repo = mkdtempSync(join(work, "repo-"));
    await run("git", ["init", "-q", repo]);
    if (url !== null) await run("git", ["-C", repo, "remote", "add", "origin", url]);
    return repo;
  }

  it("gives the owner/repo of the origin remote, and runs no gh", async () => {
    const repo = await repoWithOrigin("git@github.com:acme/widgets.git");
    expect(await client().resolveSlug({ repo })).toBe("acme/widgets");
    expect(calls()).toEqual([]);
  });

  it("throws a GitHubError when the checkout has no origin", async () => {
    const repo = await repoWithOrigin(null);
    await expect(client().resolveSlug({ repo })).rejects.toBeInstanceOf(GitHubError);
  });

  it("does not put the remote URL in the error, because a URL can hold a credential", async () => {
    const repo = await repoWithOrigin(`https://x-access-token:${FAKE_TOKEN}@example.com/only`);
    const err = await client()
      .resolveSlug({ repo })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).not.toContain(FAKE_TOKEN);
  });

  it.each([
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["git@github.com:acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets/", "acme/widgets"],
    ["ssh://git@github.com:22/acme/my.repo.git", "acme/my.repo"],
    [`https://x-access-token:${FAKE_TOKEN}@github.com/acme/widgets`, "acme/widgets"],
    ["https://ghe.example.com/acme/widgets.git", "acme/widgets"],
  ])("parses %s", (url, slug) => {
    expect(parseRemoteSlug(url)).toBe(slug);
  });

  it.each(["", "not a url", "https://github.com/only", "/local/path/repo"])(
    "gives null for %j",
    (url) => {
      expect(parseRemoteSlug(url)).toBeNull();
    },
  );
});
