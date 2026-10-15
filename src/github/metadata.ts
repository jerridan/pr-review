// Read the pull request of a --pr run through the GitHub boundary.
import type { GitHubClient, PullRequest } from "./client.js";
import { sanitizeGitHubText, type Sanitized } from "./sanitize.js";

export type PrContext = {
  pr: PullRequest;
  slug: string;
  authorWriteAccess: boolean;
  viewerLogin: string;
};

// The login of the GITHUB_TOKEN in GitHub Actions. The GITHUB_TOKEN
// cannot read the viewer, so the run uses this login when the call fails.
const ACTIONS_LOGIN = "github-actions[bot]";

// These permission levels give write access.
const WRITE_LEVELS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/**
 * Read the pull request, its slug, the write access of its author and the
 * login of the viewer. "githubRepo" replaces the slug of the checkout.
 * A pull request from a fork never gets write access, whatever the
 * permission level and the flag. "env" defaults to process.env. The
 * function reads only GITHUB_ACTIONS from it. In GitHub Actions, a failed
 * viewer call gives github-actions[bot].
 */
export async function loadPrContext(
  client: GitHubClient,
  input: {
    repo: string;
    number: number;
    githubRepo?: string;
    authorWriteAccessFlag: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<PrContext> {
  const env = input.env ?? process.env;
  const slug = input.githubRepo ?? (await client.resolveSlug({ repo: input.repo }));
  const pr = await client.getPullRequest({ slug, number: input.number });

  let authorWriteAccess: boolean;
  if (pr.fork) {
    authorWriteAccess = false;
  } else if (input.authorWriteAccessFlag) {
    authorWriteAccess = true;
  } else {
    const level = await client.getPermission({ slug, login: pr.author });
    authorWriteAccess = WRITE_LEVELS.has(level);
  }

  const viewerLogin = env.GITHUB_ACTIONS
    ? await client.viewerLogin().catch(() => ACTIONS_LOGIN)
    : await client.viewerLogin();
  return { pr, slug, authorWriteAccess, viewerLogin };
}

/**
 * The description of a --pr run: the sanitized title, a blank line and
 * the sanitized body. Each flag is true when it is true for either part.
 */
export function prDescription(pr: PullRequest): Sanitized {
  const title = sanitizeGitHubText(pr.title);
  const body = sanitizeGitHubText(pr.body);
  return {
    text: `${title.text}\n\n${body.text}`,
    sanitized: title.sanitized || body.sanitized,
    truncated: title.truncated || body.truncated,
  };
}
