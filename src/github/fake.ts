// A fake GitHub client for tests. It keeps one pull request in memory and
// needs no network and no gh.
import {
  GitHubError,
  type GitHubClient,
  type InlineComment,
  type IssueComment,
  type Permission,
  type PullRequest,
  type Reaction,
  type Review,
  type ReviewComment,
  type Thread,
} from "./client.js";

export type FakePullRequestSeed = Partial<PullRequest> & {
  viewer_login?: string;
  permission?: Permission;
  /** The owner/repo that resolveSlug gives. The default comes from the url. */
  slug?: string;
};

export type FakeState = {
  slug: string;
  pr: PullRequest;
  viewer_login: string;
  permission: string;
  reviews: (Review & { comments: InlineComment[] })[];
  review_comments: ReviewComment[];
  threads: Map<string, Thread>;
  reactions: Map<number, Reaction[]>;
  issue_comments: IssueComment[];
  check_runs: {
    id: number;
    head_sha: string;
    name: string;
    title: string;
    summary: string;
    conclusion: string;
  }[];
  replies: { comment_id: number; body: string }[];
};

export interface FakeGitHubClient extends GitHubClient {
  readonly calls: { method: string; input: unknown }[];
  readonly state: FakeState;
  /** Mark a thread resolved, as a person does in the GitHub UI. */
  resolveThreadAsHuman(thread_id: string): void;
  /** Add a reaction to a review comment. */
  react(comment_id: number, content: "-1" | "+1", user: string): void;
  /** Make the next call of "method" throw "error". */
  failNext(method: keyof GitHubClient, error: GitHubError): void;
}

const DEFAULT_PR: PullRequest = {
  number: 1,
  title: "Fake pull request",
  body: "",
  state: "open",
  draft: false,
  labels: [],
  author: "octocat",
  author_type: "User",
  head_sha: "1".repeat(40),
  head_repo: "octo/repo",
  fork: false,
  base_ref: "main",
  base_sha: "2".repeat(40),
  url: "https://github.com/octo/repo/pull/1",
};

function slugFromUrl(url: string): string | null {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return match?.[1] ?? null;
}

function notFound(method: string, what: string): GitHubError {
  return new GitHubError({
    endpoint: `fake:${method}`,
    exitCode: 1,
    message: `fake GitHub: ${what} not found (HTTP 404)`,
  });
}

/** Make a fake client with one pull request, set from "seed". */
export function createFakeGitHubClient(seed: FakePullRequestSeed = {}): FakeGitHubClient {
  const { viewer_login, permission, slug, ...prSeed } = seed;
  const pr: PullRequest = { ...DEFAULT_PR, ...prSeed, labels: [...(prSeed.labels ?? [])] };
  const state: FakeState = {
    slug: slug ?? slugFromUrl(pr.url) ?? "octo/repo",
    pr,
    viewer_login: viewer_login ?? "github-actions[bot]",
    permission: permission ?? "write",
    reviews: [],
    review_comments: [],
    threads: new Map(),
    reactions: new Map(),
    issue_comments: [],
    check_runs: [],
    replies: [],
  };
  const calls: { method: string; input: unknown }[] = [];
  const failures = new Map<keyof GitHubClient, GitHubError[]>();
  let lastId = 1000;
  const nextId = (): number => ++lastId;

  // Record the call. Then throw the queued error for the method, if any.
  function enter(method: keyof GitHubClient, input: unknown): void {
    calls.push({ method, input });
    const error = failures.get(method)?.shift();
    if (error) throw error;
  }

  function thread(method: string, thread_id: string): Thread {
    const found = state.threads.get(thread_id);
    if (!found) throw notFound(method, `thread ${thread_id}`);
    return found;
  }

  function checkPr(method: string, number: number): void {
    if (number !== state.pr.number) throw notFound(method, `pull request ${number}`);
  }

  const copy = <T>(value: T): T => structuredClone(value);

  return {
    calls,
    state,

    async resolveSlug(input) {
      enter("resolveSlug", input);
      return state.slug;
    },

    async viewerLogin() {
      enter("viewerLogin", undefined);
      return state.viewer_login;
    },

    async getPullRequest(input) {
      enter("getPullRequest", input);
      checkPr("getPullRequest", input.number);
      return copy(state.pr);
    },

    async getPermission(input) {
      enter("getPermission", input);
      return state.permission as Permission;
    },

    async listReviews(input) {
      enter("listReviews", input);
      checkPr("listReviews", input.number);
      return state.reviews.map(({ id, body, author, commit_id, url }) => ({
        id,
        body,
        author,
        commit_id,
        url,
      }));
    },

    async listReviewComments(input) {
      enter("listReviewComments", input);
      checkPr("listReviewComments", input.number);
      return copy(state.review_comments);
    },

    async getThread(input) {
      enter("getThread", input);
      return copy(thread("getThread", input.thread_id));
    },

    async listReactions(input) {
      enter("listReactions", input);
      return copy(state.reactions.get(input.comment_id) ?? []);
    },

    async createReview(input) {
      enter("createReview", input);
      checkPr("createReview", input.number);
      const id = nextId();
      const url = `${state.pr.url}#pullrequestreview-${id}`;
      state.reviews.push({
        id,
        body: input.body,
        author: state.viewer_login,
        commit_id: input.commit_id,
        url,
        comments: copy(input.comments),
      });
      // Each inline comment starts its own unresolved thread.
      for (const c of input.comments) {
        const commentId = nextId();
        const threadId = `PRRT_fake_${commentId}`;
        state.review_comments.push({
          id: commentId,
          node_id: `PRRC_fake_${commentId}`,
          body: c.body,
          path: c.path,
          line: c.line,
          start_line: c.start_line ?? null,
          author: state.viewer_login,
          thread_id: threadId,
          review_id: id,
        });
        state.threads.set(threadId, {
          id: threadId,
          resolved: false,
          comments: [{ id: commentId, body: c.body, author: state.viewer_login }],
        });
      }
      return { id, url };
    },

    async resolveThread(input) {
      enter("resolveThread", input);
      thread("resolveThread", input.thread_id).resolved = true;
    },

    async replyToComment(input) {
      enter("replyToComment", input);
      checkPr("replyToComment", input.number);
      const parent = state.review_comments.find((c) => c.id === input.comment_id);
      if (!parent) throw notFound("replyToComment", `review comment ${input.comment_id}`);
      const id = nextId();
      state.review_comments.push({
        ...parent,
        id,
        node_id: `PRRC_fake_${id}`,
        body: input.body,
        author: state.viewer_login,
        review_id: null,
      });
      thread("replyToComment", parent.thread_id).comments.push({
        id,
        body: input.body,
        author: state.viewer_login,
      });
      state.replies.push({ comment_id: input.comment_id, body: input.body });
      return { id };
    },

    async listIssueComments(input) {
      enter("listIssueComments", input);
      checkPr("listIssueComments", input.number);
      return copy(state.issue_comments);
    },

    async createIssueComment(input) {
      enter("createIssueComment", input);
      checkPr("createIssueComment", input.number);
      const id = nextId();
      state.issue_comments.push({ id, body: input.body, author: state.viewer_login });
      return { id };
    },

    async updateIssueComment(input) {
      enter("updateIssueComment", input);
      const comment = state.issue_comments.find((c) => c.id === input.comment_id);
      if (!comment) throw notFound("updateIssueComment", `issue comment ${input.comment_id}`);
      comment.body = input.body;
    },

    async createCheckRun(input) {
      enter("createCheckRun", input);
      const id = nextId();
      const { head_sha, name, title, summary, conclusion } = input;
      state.check_runs.push({ id, head_sha, name, title, summary, conclusion });
      return { id };
    },

    resolveThreadAsHuman(thread_id) {
      thread("resolveThreadAsHuman", thread_id).resolved = true;
    },

    react(comment_id, content, user) {
      const list = state.reactions.get(comment_id) ?? [];
      list.push({ content, user });
      state.reactions.set(comment_id, list);
    },

    failNext(method, error) {
      const queue = failures.get(method) ?? [];
      queue.push(error);
      failures.set(method, queue);
    },
  };
}
