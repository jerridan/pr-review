// The GitHub boundary. This interface is the only way the tool reaches the
// GitHub API. The real client is in gh.ts. The fake for tests is in fake.ts.

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  labels: string[];
  author: string;
  author_type: "User" | "Bot" | "Organization" | string;
  head_sha: string;
  head_repo: string;
  fork: boolean;
  base_ref: string;
  base_sha: string;
  url: string;
};

export type Review = {
  id: number;
  body: string;
  author: string;
  commit_id: string | null;
  url: string;
};

export type ReviewComment = {
  id: number;
  node_id: string;
  body: string;
  path: string;
  line: number | null;
  start_line: number | null;
  author: string;
  thread_id: string;
  review_id: number | null;
};

export type Thread = {
  id: string;
  resolved: boolean;
  comments: { id: number; body: string; author: string }[];
};

export type InlineComment = {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
};

export type IssueComment = { id: number; body: string; author: string };

export type Reaction = { content: string; user: string };

/**
 * The operations on GitHub. Each method takes one object and gives typed
 * data. Each failure is a GitHubError.
 */
export interface GitHubClient {
  /** Give the owner/repo of the "origin" remote of the checkout. */
  resolveSlug(input: { repo: string }): Promise<string>;
  /** Give the login of the user that gh is logged in as. */
  viewerLogin(): Promise<string>;
  getPullRequest(input: { slug: string; number: number }): Promise<PullRequest>;
  getPermission(input: { slug: string; login: string }): Promise<Permission>;
  listReviews(input: { slug: string; number: number }): Promise<Review[]>;
  listReviewComments(input: { slug: string; number: number }): Promise<ReviewComment[]>;
  getThread(input: { thread_id: string }): Promise<Thread>;
  listReactions(input: { slug: string; comment_id: number }): Promise<Reaction[]>;
  /** Create a review. The event is always COMMENT. */
  createReview(input: {
    slug: string;
    number: number;
    commit_id: string;
    body: string;
    comments: InlineComment[];
  }): Promise<{ id: number; url: string }>;
  resolveThread(input: { thread_id: string }): Promise<void>;
  replyToComment(input: {
    slug: string;
    number: number;
    comment_id: number;
    body: string;
  }): Promise<{ id: number }>;
  listIssueComments(input: { slug: string; number: number }): Promise<IssueComment[]>;
  createIssueComment(input: {
    slug: string;
    number: number;
    body: string;
  }): Promise<{ id: number }>;
  updateIssueComment(input: { slug: string; comment_id: number; body: string }): Promise<void>;
  createCheckRun(input: {
    slug: string;
    head_sha: string;
    name: string;
    title: string;
    summary: string;
    conclusion: "neutral";
  }): Promise<{ id: number }>;
}

/**
 * A failed GitHub call. It names the endpoint and the exit code of gh. The
 * exit code is null when gh did not run to an exit. The status is the HTTP
 * status that gh reports, or null. The message never holds a token.
 */
export class GitHubError extends Error {
  readonly endpoint: string;
  readonly exitCode: number | null;
  readonly status: number | null;

  constructor(input: {
    endpoint: string;
    exitCode: number | null;
    message: string;
    status?: number | null;
  }) {
    super(input.message);
    this.name = "GitHubError";
    this.endpoint = input.endpoint;
    this.exitCode = input.exitCode;
    this.status = input.status ?? null;
  }
}
