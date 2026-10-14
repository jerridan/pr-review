import { describe, expect, it } from "vitest";
import { createFakeGitHubClient } from "../src/github/fake.js";
import { loadPrContext, prDescription } from "../src/github/metadata.js";

const NO_ACTIONS: NodeJS.ProcessEnv = {};

describe("loadPrContext (R2)", () => {
  it("resolves the slug from the checkout and reads the pull request", async () => {
    const gh = createFakeGitHubClient({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      viewer_login: "me",
    });
    const ctx = await loadPrContext(gh, {
      repo: "/repo",
      number: 7,
      authorWriteAccessFlag: false,
      env: NO_ACTIONS,
    });
    expect(ctx.slug).toBe("acme/widgets");
    expect(ctx.pr.number).toBe(7);
    expect(ctx.viewerLogin).toBe("me");
    expect(gh.calls[0]).toEqual({ method: "resolveSlug", input: { repo: "/repo" } });
    expect(gh.calls).toContainEqual({
      method: "getPullRequest",
      input: { slug: "acme/widgets", number: 7 },
    });
  });

  it("uses githubRepo over the slug of the checkout", async () => {
    const gh = createFakeGitHubClient({ number: 7 });
    const ctx = await loadPrContext(gh, {
      repo: "/repo",
      number: 7,
      githubRepo: "other/place",
      authorWriteAccessFlag: false,
      env: NO_ACTIONS,
    });
    expect(ctx.slug).toBe("other/place");
    expect(gh.calls.map((c) => c.method)).not.toContain("resolveSlug");
    expect(gh.calls).toContainEqual({
      method: "getPullRequest",
      input: { slug: "other/place", number: 7 },
    });
  });

  it("gives github-actions[bot] as the viewer in GitHub Actions, with no viewer call", async () => {
    const gh = createFakeGitHubClient({ number: 1, viewer_login: "someone" });
    const ctx = await loadPrContext(gh, {
      repo: "/repo",
      number: 1,
      authorWriteAccessFlag: false,
      env: { GITHUB_ACTIONS: "true" },
    });
    expect(ctx.viewerLogin).toBe("github-actions[bot]");
    expect(gh.calls.map((c) => c.method)).not.toContain("viewerLogin");
  });

  it.each([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
  ] as const)("takes write access from the permission %s: %s", async (permission, expected) => {
    const gh = createFakeGitHubClient({ number: 1, author: "alice", permission });
    const ctx = await loadPrContext(gh, {
      repo: "/repo",
      number: 1,
      authorWriteAccessFlag: false,
      env: NO_ACTIONS,
    });
    expect(ctx.authorWriteAccess).toBe(expected);
    expect(gh.calls).toContainEqual({
      method: "getPermission",
      input: { slug: gh.state.slug, login: "alice" },
    });
  });

  it("takes write access from the flag", async () => {
    const gh = createFakeGitHubClient({ number: 1, permission: "read" });
    const ctx = await loadPrContext(gh, {
      repo: "/repo",
      number: 1,
      authorWriteAccessFlag: true,
      env: NO_ACTIONS,
    });
    expect(ctx.authorWriteAccess).toBe(true);
  });

  it("gives no write access for a fork, whatever the permission and the flag", async () => {
    const gh = createFakeGitHubClient({
      number: 1,
      fork: true,
      head_repo: "eve/widgets",
      permission: "admin",
    });
    const ctx = await loadPrContext(gh, {
      repo: "/repo",
      number: 1,
      authorWriteAccessFlag: true,
      env: NO_ACTIONS,
    });
    expect(ctx.authorWriteAccess).toBe(false);
  });

  it("lets a GitHub error through", async () => {
    const gh = createFakeGitHubClient({ number: 1 });
    await expect(
      loadPrContext(gh, {
        repo: "/repo",
        number: 2,
        authorWriteAccessFlag: false,
        env: NO_ACTIONS,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("prDescription (R3)", () => {
  it("is the sanitized title, a blank line and the sanitized body", () => {
    const gh = createFakeGitHubClient({ title: "Add\u200D average", body: "Body<!-- x -->." });
    expect(prDescription(gh.state.pr)).toEqual({
      text: "Add average\n\nBody.",
      sanitized: true,
      truncated: false,
    });
  });

  it("reports a clean description as not sanitized", () => {
    const gh = createFakeGitHubClient({ title: "Add average", body: "Body." });
    expect(prDescription(gh.state.pr)).toEqual({
      text: "Add average\n\nBody.",
      sanitized: false,
      truncated: false,
    });
  });

  it("reports a long body as cut", () => {
    const gh = createFakeGitHubClient({ title: "T", body: "b".repeat(30_000) });
    const out = prDescription(gh.state.pr);
    expect(out.truncated).toBe(true);
    expect(out.sanitized).toBe(true);
    expect(out.text).toBe(`T\n\n${"b".repeat(20_000)}`);
  });
});
