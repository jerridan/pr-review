// Default path globs for gather. A generated or lock file is removed from
// the diff. A sensitive file sets the tier floor and is not removed.
import picomatch from "picomatch";

export const GENERATED_GLOBS: readonly string[] = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/dist/**",
  "**/build/**",
  "**/*.generated.*",
  "**/__snapshots__/**",
];

export const SENSITIVE_GLOBS: readonly string[] = [
  "**/auth/**",
  "**/*auth*",
  "**/crypto/**",
  "**/*secret*",
  "**/*token*",
  "**/payment*/**",
  "**/billing/**",
  "**/migrations/**",
  ".github/workflows/**",
  ".pr-review/**",
  "**/Dockerfile",
  "**/*.tf",
];

/** The sensitive and generated globs that gather uses. */
export type GatherGlobs = { sensitive: readonly string[]; generated: readonly string[] };

export const DEFAULT_GLOBS: GatherGlobs = {
  sensitive: SENSITIVE_GLOBS,
  generated: GENERATED_GLOBS,
};

/** The default globs with the globs of a repo config added after them. */
export function withRepoGlobs(extra: {
  sensitive_globs: readonly string[];
  generated_globs: readonly string[];
}): GatherGlobs {
  return {
    sensitive: [...SENSITIVE_GLOBS, ...extra.sensitive_globs],
    generated: [...GENERATED_GLOBS, ...extra.generated_globs],
  };
}

// "dot: true" lets "*" and "**" match names that start with a dot, so a
// path such as ".config/auth/x" is not missed.
const matcherCache = new Map<string, (path: string) => boolean>();

function matcherFor(glob: string): (path: string) => boolean {
  let matcher = matcherCache.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, { dot: true });
    matcherCache.set(glob, matcher);
  }
  return matcher;
}

/** Return true when a repo-relative path matches one or more of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((glob) => matcherFor(glob)(normalized));
}
