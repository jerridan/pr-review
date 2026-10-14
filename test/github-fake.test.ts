import { describe, expect, it } from "vitest";
import { GitHubError } from "../src/github/client.js";
import { createFakeGitHubClient } from "../src/github/fake.js";

const SLUG = "acme/widgets";

describe("createFakeGitHubClient (R1)", () => {
  it("serves the seeded pull request, viewer and permission", async () => {
    const gh = createFakeGitHubClient({
      number: 7,
      title: "Add a widget",
      labels: ["skip-review"],
      url: "https://github.com/acme/widgets/pull/7",
      viewer_login: "github-actions[bot]",
      permission: "triage",
    });
    expect(await gh.resolveSlug({ repo: "/tmp/x" })).toBe(SLUG);
    expect(await gh.viewerLogin()).toBe("github-actions[bot]");
    const pr = await gh.getPullRequest({ slug: SLUG, number: 7 });
    expect(pr.title).toBe("Add a widget");
    expect(pr.labels).toEqual(["skip-review"]);
    expect(pr.state).toBe("open");
    expect(await gh.getPermission({ slug: SLUG, login: pr.author })).toBe("triage");
  });

  it("gives defaults when no seed is given", async () => {
    const gh = createFakeGitHubClient();
    const pr = await gh.getPullRequest({ slug: gh.state.slug, number: gh.state.pr.number });
    expect(pr.number).toBeGreaterThan(0);
    expect(pr.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pr.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(gh.state.viewer_login).not.toBe("");
    expect(gh.state.permission).toBe("write");
  });

  it("throws a GitHubError for a pull request number it does not hold", async () => {
    const gh = createFakeGitHubClient({ number: 3 });
    await expect(gh.getPullRequest({ slug: SLUG, number: 4 })).rejects.toBeInstanceOf(GitHubError);
  });

  it("records every call with its input", async () => {
    const gh = createFakeGitHubClient({ number: 2 });
    await gh.viewerLogin();
    await gh.listReviews({ slug: SLUG, number: 2 });
    expect(gh.calls).toEqual([
      { method: "viewerLogin", input: undefined },
      { method: "listReviews", input: { slug: SLUG, number: 2 } },
    ]);
  });

  it("adds a review, one comment and one unresolved thread per inline comment, with ascending ids", async () => {
    const gh = createFakeGitHubClient({ number: 5, viewer_login: "bot[bot]" });
    const review = await gh.createReview({
      slug: SLUG,
      number: 5,
      commit_id: "c".repeat(40),
      body: "Summary",
      comments: [
        { path: "a.ts", line: 3, side: "RIGHT", body: "first" },
        {
          path: "b.ts",
          line: 9,
          start_line: 7,
          side: "RIGHT",
          start_side: "RIGHT",
          body: "second",
        },
      ],
    });
    expect(gh.state.reviews).toHaveLength(1);
    expect(gh.state.reviews[0]).toMatchObject({
      id: review.id,
      body: "Summary",
      author: "bot[bot]",
      commit_id: "c".repeat(40),
    });
    expect(gh.state.reviews[0]?.comments).toHaveLength(2);

    const comments = await gh.listReviewComments({ slug: SLUG, number: 5 });
    expect(comments).toHaveLength(2);
    const [first, second] = comments;
    expect(first).toMatchObject({ path: "a.ts", line: 3, start_line: null, body: "first" });
    expect(second).toMatchObject({ path: "b.ts", line: 9, start_line: 7, body: "second" });
    expect(first?.review_id).toBe(review.id);
    expect(first?.author).toBe("bot[bot]");
    expect(review.id).toBeLessThan(first!.id);
    expect(first!.id).toBeLessThan(second!.id);
    expect(first?.thread_id).not.toBe(second?.thread_id);

    for (const c of comments) {
      const thread = await gh.getThread({ thread_id: c.thread_id });
      expect(thread.resolved).toBe(false);
      expect(thread.comments).toEqual([{ id: c.id, body: c.body, author: "bot[bot]" }]);
    }
    const reviews = await gh.listReviews({ slug: SLUG, number: 5 });
    expect(reviews).toEqual([
      {
        id: review.id,
        body: "Summary",
        author: "bot[bot]",
        commit_id: "c".repeat(40),
        url: review.url,
      },
    ]);
  });

  it("resolves a thread through the client and through resolveThreadAsHuman", async () => {
    const gh = createFakeGitHubClient({ number: 1 });
    await gh.createReview({
      slug: SLUG,
      number: 1,
      commit_id: "c".repeat(40),
      body: "",
      comments: [
        { path: "a.ts", line: 1, side: "RIGHT", body: "x" },
        { path: "a.ts", line: 2, side: "RIGHT", body: "y" },
      ],
    });
    const [a, b] = await gh.listReviewComments({ slug: SLUG, number: 1 });
    await gh.resolveThread({ thread_id: a!.thread_id });
    expect((await gh.getThread({ thread_id: a!.thread_id })).resolved).toBe(true);

    const before = gh.calls.length;
    gh.resolveThreadAsHuman(b!.thread_id);
    expect(gh.calls).toHaveLength(before);
    expect(gh.state.threads.get(b!.thread_id)?.resolved).toBe(true);
    expect(() => gh.resolveThreadAsHuman("nope")).toThrow(GitHubError);
    await expect(gh.resolveThread({ thread_id: "nope" })).rejects.toBeInstanceOf(GitHubError);
  });

  it("lists the reactions that react adds", async () => {
    const gh = createFakeGitHubClient({ number: 1 });
    await gh.createReview({
      slug: SLUG,
      number: 1,
      commit_id: "c".repeat(40),
      body: "",
      comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "x" }],
    });
    const [c] = await gh.listReviewComments({ slug: SLUG, number: 1 });
    expect(await gh.listReactions({ slug: SLUG, comment_id: c!.id })).toEqual([]);
    gh.react(c!.id, "-1", "alice");
    gh.react(c!.id, "+1", "bob");
    expect(await gh.listReactions({ slug: SLUG, comment_id: c!.id })).toEqual([
      { content: "-1", user: "alice" },
      { content: "+1", user: "bob" },
    ]);
  });

  it("adds a reply to the thread of the comment", async () => {
    const gh = createFakeGitHubClient({ number: 1, viewer_login: "me[bot]" });
    await gh.createReview({
      slug: SLUG,
      number: 1,
      commit_id: "c".repeat(40),
      body: "",
      comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "x" }],
    });
    const [c] = await gh.listReviewComments({ slug: SLUG, number: 1 });
    const reply = await gh.replyToComment({
      slug: SLUG,
      number: 1,
      comment_id: c!.id,
      body: "Fixed.",
    });
    expect(reply.id).toBeGreaterThan(c!.id);
    expect(gh.state.replies).toEqual([{ comment_id: c!.id, body: "Fixed." }]);
    const thread = await gh.getThread({ thread_id: c!.thread_id });
    expect(thread.comments.map((x) => x.body)).toEqual(["x", "Fixed."]);
    expect(thread.comments[1]?.author).toBe("me[bot]");
    await expect(
      gh.replyToComment({ slug: SLUG, number: 1, comment_id: 999_999, body: "?" }),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("lists, creates and updates issue comments", async () => {
    const gh = createFakeGitHubClient({ number: 1, viewer_login: "me[bot]" });
    const { id } = await gh.createIssueComment({ slug: SLUG, number: 1, body: "one" });
    expect(await gh.listIssueComments({ slug: SLUG, number: 1 })).toEqual([
      { id, body: "one", author: "me[bot]" },
    ]);
    await gh.updateIssueComment({ slug: SLUG, comment_id: id, body: "two" });
    expect(gh.state.issue_comments).toEqual([{ id, body: "two", author: "me[bot]" }]);
    await expect(
      gh.updateIssueComment({ slug: SLUG, comment_id: id + 1, body: "x" }),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("creates a check run", async () => {
    const gh = createFakeGitHubClient({ head_sha: "d".repeat(40) });
    const run = await gh.createCheckRun({
      slug: SLUG,
      head_sha: "d".repeat(40),
      name: "pr-review",
      title: "Title",
      summary: "Summary",
      conclusion: "neutral",
    });
    expect(gh.state.check_runs).toEqual([
      {
        id: run.id,
        head_sha: "d".repeat(40),
        name: "pr-review",
        title: "Title",
        summary: "Summary",
        conclusion: "neutral",
      },
    ]);
  });

  it("throws the failNext error once, on the next call of that method only, and records the call", async () => {
    const gh = createFakeGitHubClient({ number: 1 });
    const error = new GitHubError({
      endpoint: "repos/acme/widgets/check-runs",
      exitCode: 1,
      message: "boom",
    });
    gh.failNext("createCheckRun", error);
    await gh.viewerLogin();
    const input = {
      slug: SLUG,
      head_sha: "d".repeat(40),
      name: "n",
      title: "t",
      summary: "s",
      conclusion: "neutral" as const,
    };
    await expect(gh.createCheckRun(input)).rejects.toBe(error);
    expect(gh.state.check_runs).toEqual([]);
    expect(gh.calls.map((c) => c.method)).toEqual(["viewerLogin", "createCheckRun"]);
    await expect(gh.createCheckRun(input)).resolves.toMatchObject({ id: expect.any(Number) });
    expect(gh.state.check_runs).toHaveLength(1);
  });

  it("returns copies, so a caller cannot change the state by accident", async () => {
    const gh = createFakeGitHubClient({ number: 1, labels: ["a"] });
    const pr = await gh.getPullRequest({ slug: SLUG, number: 1 });
    pr.labels.push("b");
    expect(gh.state.pr.labels).toEqual(["a"]);
  });
});

describe("GitHubError (R1)", () => {
  it("holds the endpoint and the exit code", () => {
    const err = new GitHubError({ endpoint: "graphql", exitCode: 4, message: "denied" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitHubError");
    expect(err.endpoint).toBe("graphql");
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain("denied");
  });
});
