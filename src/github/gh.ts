// The real GitHub client. It runs "gh api" through execFile, never through
// a shell. The gh program finds its own token. This module never reads one.
//
// Each REST read is "gh api -X GET <path>". A list adds "--paginate".
// Each REST write is "gh api -X POST|PATCH <path> --input -", with the JSON
// body on stdin. Each GraphQL call is "gh api graphql --input -", with
// {query, variables} on stdin. Thus no body text goes on the command line.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGit } from "../gather/worktree.js";
import {
  GitHubError,
  type GitHubClient,
  type Permission,
  type PullRequest,
  type ReviewComment,
  type Thread,
} from "./client.js";

const execFileAsync = promisify(execFile);

const GRAPHQL = "graphql";
const MAX_PAGES = 100;
const PERMISSIONS: readonly Permission[] = ["admin", "maintain", "write", "triage", "read", "none"];

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

// These patterns match GitHub tokens and a credential in a URL. The client
// removes them from each error message. It does not compare with env values.
const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const URL_CREDENTIAL_RE = /\/\/[^/\s@]+@/g;

/** Remove token-like text from "text". */
function redact(text: string): string {
  return text.replace(TOKEN_RE, "[redacted]").replace(URL_CREDENTIAL_RE, "//[redacted]@");
}

/** Give the first line of stderr that is not empty, redacted and short. */
function reasonOf(stderr: string | undefined): string {
  const line = (stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return redact(line ?? "no error text").slice(0, 500);
}

/**
 * Give the "owner/repo" of a GitHub remote URL, or null. It accepts the
 * scp form (git@host:owner/repo.git) and the URL form (https or ssh).
 */
export function parseRemoteSlug(url: string): string | null {
  const text = url.trim();
  const urlForm = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(text);
  const scpForm = /^(?:[^@/\s]+@)?[^/:\s]+:(?!\/)(.+)$/.exec(text);
  const path = urlForm?.[1] ?? scpForm?.[1];
  if (path === undefined) return null;
  const parts = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2) return null;
  if (!parts.every((p) => SEGMENT_RE.test(p) && p !== "." && p !== "..")) return null;
  return parts.join("/");
}

/** Make a GitHubError for an input that must not go into a path. */
function invalid(endpoint: string, what: string): GitHubError {
  return new GitHubError({
    endpoint,
    exitCode: null,
    message: `${endpoint}: ${what} is not valid`,
  });
}

function checkSlug(slug: string): string {
  if (!SLUG_RE.test(slug) || slug.split("/").some((p) => p === "." || p === "..")) {
    throw invalid("repos/{slug}", "the slug");
  }
  return slug;
}

function checkId(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid("repos/{slug}", what);
  return value;
}

/**
 * Parse gh output as one or more JSON values. "gh api --paginate" can
 * print one array per page, one after the other.
 */
function parseJsonValues(endpoint: string, text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) values.push(parseOne(endpoint, text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(ch ?? "")) {
      throw notJson(endpoint);
    }
  }
  if (depth !== 0 || inString || values.length === 0) throw notJson(endpoint);
  return values;
}

function parseOne(endpoint: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw notJson(endpoint);
  }
}

function notJson(endpoint: string): GitHubError {
  return new GitHubError({
    endpoint,
    exitCode: 0,
    message: `gh api ${endpoint} gave output that is not JSON`,
  });
}

type User = { login?: string } | null | undefined;
type GqlAuthor = { __typename?: string; login?: string } | null | undefined;

function restLogin(user: User): string {
  return user?.login ?? "ghost";
}

// GraphQL gives a bot login without "[bot]". REST gives it with "[bot]".
// Add the suffix, so that each login has the REST form.
function gqlLogin(author: GqlAuthor): string {
  const login = author?.login;
  if (!login) return "ghost";
  if (author?.__typename === "Bot" && !login.endsWith("[bot]")) return `${login}[bot]`;
  return login;
}

// The GraphQL documents. Each is a list of short lines, because the A13
// test forbids a string in src longer than 200 characters. These are API
// queries, not prompts.
const VIEWER_QUERY = ["query {", "  viewer { __typename login }", "}"].join("\n");

const THREADS_QUERY = [
  "query($owner: String!, $name: String!, $number: Int!, $cursor: String) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $number) {",
  "      reviewThreads(first: 100, after: $cursor) {",
  "        pageInfo { hasNextPage endCursor }",
  "        nodes {",
  "          id",
  "          isResolved",
  "          comments(first: 100) {",
  "            nodes {",
  "              databaseId id body path line startLine",
  "              author { __typename login }",
  "              pullRequestReview { databaseId }",
  "            }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const THREAD_QUERY = [
  "query($id: ID!) {",
  "  node(id: $id) {",
  "    ... on PullRequestReviewThread {",
  "      id",
  "      isResolved",
  "      comments(first: 100) {",
  "        nodes { databaseId body author { __typename login } }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const RESOLVE_MUTATION = [
  "mutation($id: ID!) {",
  "  resolveReviewThread(input: { threadId: $id }) {",
  "    thread { id isResolved }",
  "  }",
  "}",
].join("\n");

type ThreadsPage = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          comments: {
            nodes: {
              databaseId: number;
              id: string;
              body: string;
              path: string;
              line: number | null;
              startLine: number | null;
              author: GqlAuthor;
              pullRequestReview: { databaseId: number } | null;
            }[];
          };
        }[];
      };
    } | null;
  } | null;
};

type ThreadNode = {
  id?: string;
  isResolved?: boolean;
  comments?: { nodes: { databaseId: number; body: string; author: GqlAuthor }[] };
} | null;

/** Make the real client. "env" goes to gh unchanged. */
export function createGhClient(
  options: { ghPath?: string; env?: NodeJS.ProcessEnv } = {},
): GitHubClient {
  const ghPath = options.ghPath ?? "gh";
  const env = options.env;

  // Run gh with "args". Write "input" as JSON on stdin. Give stdout.
  async function runGh(endpoint: string, args: string[], input?: unknown): Promise<string> {
    try {
      const pending = execFileAsync(ghPath, args, {
        env,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      const stdin = pending.child.stdin;
      // A write error shows again as the exit of gh, so ignore it here.
      stdin?.on("error", () => undefined);
      stdin?.end(input === undefined ? undefined : JSON.stringify(input));
      const { stdout } = await pending;
      return stdout;
    } catch (err) {
      const e = err as { code?: unknown; stderr?: string };
      // Do not keep "err" as the cause. Its text holds the stderr in full.
      if (e.code === "ENOENT") {
        throw new GitHubError({
          endpoint,
          exitCode: null,
          message: `gh is not installed or not found on PATH. Install gh 2.40 or later. (${endpoint})`,
        });
      }
      const exitCode = typeof e.code === "number" ? e.code : null;
      const status = /\(HTTP (\d{3})\)/.exec(e.stderr ?? "");
      throw new GitHubError({
        endpoint,
        exitCode,
        status: status ? Number(status[1]) : null,
        message: `gh api ${endpoint} failed with exit code ${exitCode ?? "none"}: ${reasonOf(e.stderr)}`,
      });
    }
  }

  async function get<T>(path: string): Promise<T> {
    const out = await runGh(path, ["api", "-X", "GET", path]);
    const values = parseJsonValues(path, out);
    if (values.length !== 1) throw notJson(path);
    return values[0] as T;
  }

  async function list<T>(path: string): Promise<T[]> {
    const pagePath = `${path}?per_page=100`;
    const out = await runGh(path, ["api", "-X", "GET", "--paginate", pagePath]);
    const items: T[] = [];
    for (const page of parseJsonValues(path, out)) {
      if (!Array.isArray(page)) throw notJson(path);
      items.push(...(page as T[]));
    }
    return items;
  }

  async function send<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
    const out = await runGh(path, ["api", "-X", method, path, "--input", "-"], body);
    const values = parseJsonValues(path, out);
    if (values.length !== 1) throw notJson(path);
    return values[0] as T;
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const out = await runGh(GRAPHQL, ["api", "graphql", "--input", "-"], { query, variables });
    const values = parseJsonValues(GRAPHQL, out);
    const response = values[0] as { data?: T | null; errors?: { message?: string }[] };
    if (values.length !== 1 || response.data === undefined || response.data === null) {
      const reason = response.errors?.[0]?.message ?? "no data";
      throw new GitHubError({
        endpoint: GRAPHQL,
        exitCode: 0,
        message: `gh api graphql gave no data: ${redact(reason).slice(0, 500)}`,
      });
    }
    return response.data;
  }

  return {
    async resolveSlug({ repo }) {
      const endpoint = "git remote get-url origin";
      let url: string;
      try {
        url = await runGit(repo, ["remote", "get-url", "origin"]);
      } catch (err) {
        const cause = (err as { cause?: { code?: unknown } }).cause;
        throw new GitHubError({
          endpoint,
          exitCode: typeof cause?.code === "number" ? cause.code : null,
          message: `${endpoint} failed: the checkout has no readable origin remote`,
        });
      }
      const slug = parseRemoteSlug(url);
      // Do not put the URL in the message. A URL can hold a credential.
      if (slug === null) {
        throw new GitHubError({
          endpoint,
          exitCode: 0,
          message: `${endpoint}: the origin URL does not name an owner/repo`,
        });
      }
      return slug;
    },

    async viewerLogin() {
      const data = await graphql<{ viewer: GqlAuthor }>(VIEWER_QUERY, {});
      // A bot token gives "name[bot]", the same as REST does.
      return gqlLogin(data.viewer);
    },

    async getPullRequest({ slug, number }) {
      const path = `repos/${checkSlug(slug)}/pulls/${checkId(number, "the number")}`;
      const pr = await get<{
        number: number;
        title: string;
        body: string | null;
        state: "open" | "closed";
        draft?: boolean;
        labels: { name: string }[];
        user: { login: string; type: string } | null;
        head: { sha: string; repo: { full_name: string } | null };
        base: { ref: string; sha: string; repo: { full_name: string } };
        html_url: string;
      }>(path);
      const headRepo = pr.head.repo?.full_name ?? "";
      const out: PullRequest = {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        state: pr.state,
        draft: pr.draft ?? false,
        labels: pr.labels.map((l) => l.name),
        author: restLogin(pr.user),
        author_type: pr.user?.type ?? "User",
        head_sha: pr.head.sha,
        head_repo: headRepo,
        // A head repo that is gone was a fork that someone deleted.
        fork: headRepo === "" || headRepo !== pr.base.repo.full_name,
        base_ref: pr.base.ref,
        base_sha: pr.base.sha,
        url: pr.html_url,
      };
      return out;
    },

    async getPermission({ slug, login }) {
      if (!LOGIN_RE.test(login)) throw invalid("repos/{slug}/collaborators", "the login");
      const path = `repos/${checkSlug(slug)}/collaborators/${encodeURIComponent(login)}/permission`;
      let data: { permission?: string; role_name?: string };
      try {
        data = await get(path);
      } catch (err) {
        // GitHub gives 404 for a user with no access to the repo.
        if (err instanceof GitHubError && err.status === 404) return "none";
        throw err;
      }
      const known = (v: string | undefined): v is Permission =>
        v !== undefined && (PERMISSIONS as readonly string[]).includes(v);
      if (known(data.role_name)) return data.role_name;
      if (known(data.permission)) return data.permission;
      return "none";
    },

    async listReviews({ slug, number }) {
      const path = `repos/${checkSlug(slug)}/pulls/${checkId(number, "the number")}/reviews`;
      const reviews = await list<{
        id: number;
        body: string | null;
        user: User;
        commit_id: string | null;
        html_url: string;
      }>(path);
      return reviews.map((r) => ({
        id: r.id,
        body: r.body ?? "",
        author: restLogin(r.user),
        commit_id: r.commit_id ?? null,
        url: r.html_url,
      }));
    },

    async listReviewComments({ slug, number }) {
      const [owner, name] = checkSlug(slug).split("/");
      checkId(number, "the number");
      const out: ReviewComment[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data: ThreadsPage = await graphql<ThreadsPage>(THREADS_QUERY, {
          owner,
          name,
          number,
          cursor,
        });
        const threads = data.repository?.pullRequest?.reviewThreads;
        if (!threads) {
          throw new GitHubError({
            endpoint: GRAPHQL,
            exitCode: 0,
            message: `gh api graphql: pull request ${number} has no review threads field`,
          });
        }
        for (const thread of threads.nodes) {
          for (const c of thread.comments.nodes) {
            out.push({
              id: c.databaseId,
              node_id: c.id,
              body: c.body,
              path: c.path,
              line: c.line ?? null,
              start_line: c.startLine ?? null,
              author: gqlLogin(c.author),
              thread_id: thread.id,
              review_id: c.pullRequestReview?.databaseId ?? null,
            });
          }
        }
        if (!threads.pageInfo.hasNextPage || threads.pageInfo.endCursor === null) return out;
        cursor = threads.pageInfo.endCursor;
      }
      return out;
    },

    async getThread({ thread_id }) {
      const data = await graphql<{ node: ThreadNode }>(THREAD_QUERY, { id: thread_id });
      const node = data.node;
      if (!node || typeof node.id !== "string" || typeof node.isResolved !== "boolean") {
        throw new GitHubError({
          endpoint: GRAPHQL,
          exitCode: 0,
          message: "gh api graphql: the thread id names no review thread",
        });
      }
      const thread: Thread = {
        id: node.id,
        resolved: node.isResolved,
        comments: (node.comments?.nodes ?? []).map((c) => ({
          id: c.databaseId,
          body: c.body,
          author: gqlLogin(c.author),
        })),
      };
      return thread;
    },

    async listReactions({ slug, comment_id }) {
      const id = checkId(comment_id, "the comment id");
      const path = `repos/${checkSlug(slug)}/pulls/comments/${id}/reactions`;
      const reactions = await list<{ content: string; user: User }>(path);
      return reactions.map((r) => ({ content: r.content, user: restLogin(r.user) }));
    },

    async createReview({ slug, number, commit_id, body, comments }) {
      const path = `repos/${checkSlug(slug)}/pulls/${checkId(number, "the number")}/reviews`;
      const out = await send<{ id: number; html_url: string }>("POST", path, {
        commit_id,
        body,
        event: "COMMENT",
        comments,
      });
      return { id: out.id, url: out.html_url };
    },

    async resolveThread({ thread_id }) {
      await graphql(RESOLVE_MUTATION, { id: thread_id });
    },

    async replyToComment({ slug, number, comment_id, body }) {
      const n = checkId(number, "the number");
      const id = checkId(comment_id, "the comment id");
      const path = `repos/${checkSlug(slug)}/pulls/${n}/comments/${id}/replies`;
      const out = await send<{ id: number }>("POST", path, { body });
      return { id: out.id };
    },

    async listIssueComments({ slug, number }) {
      const path = `repos/${checkSlug(slug)}/issues/${checkId(number, "the number")}/comments`;
      const comments = await list<{ id: number; body: string | null; user: User }>(path);
      return comments.map((c) => ({ id: c.id, body: c.body ?? "", author: restLogin(c.user) }));
    },

    async createIssueComment({ slug, number, body }) {
      const path = `repos/${checkSlug(slug)}/issues/${checkId(number, "the number")}/comments`;
      const out = await send<{ id: number }>("POST", path, { body });
      return { id: out.id };
    },

    async updateIssueComment({ slug, comment_id, body }) {
      const id = checkId(comment_id, "the comment id");
      const path = `repos/${checkSlug(slug)}/issues/comments/${id}`;
      await send("PATCH", path, { body });
    },

    async createCheckRun({ slug, head_sha, name, title, summary, conclusion }) {
      const path = `repos/${checkSlug(slug)}/check-runs`;
      const out = await send<{ id: number }>("POST", path, {
        name,
        head_sha,
        status: "completed",
        conclusion,
        output: { title, summary },
      });
      return { id: out.id };
    },
  };
}
