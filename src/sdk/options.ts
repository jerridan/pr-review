// Build the SDK options for one query. This module is pure and does not
// import the SDK, so tests can check every option without it.
import { resolveModel, roleConfig } from "../config/models.js";
import { toSdkJsonSchema } from "../schemas/json-schema.js";
import type { QueryRequest } from "./client.js";

export interface RunOptions {
  allowApiKey: boolean;
  env: NodeJS.ProcessEnv;
}

/** Tools that a read-only role can use. */
export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * The permission rules that approve the read-only tools. Each rule has a
 * path specifier, so it approves reads in the head checkout (the cwd)
 * only. A rule with no specifier approves a read of any path.
 */
export const READ_ONLY_RULES: readonly string[] = READ_ONLY_TOOLS.map(readRule);

function readRule(tool: string): string {
  return `${tool}(./**)`;
}

/**
 * Split a reviewer's tool list against the read-only set. "granted" holds
 * the read-only tools that the list names (case-insensitive, in canonical
 * form and order). "ignored" holds every other name: the list can narrow
 * the read-only set, but it cannot widen it. When there is no list
 * (undefined), the full read-only set is granted.
 */
export function narrowReadOnlyTools(tools: readonly string[] | undefined): {
  granted: string[];
  ignored: string[];
} {
  if (tools === undefined) return { granted: [...READ_ONLY_TOOLS], ignored: [] };
  const named = new Set(tools.map((tool) => tool.trim().toLowerCase()));
  const known = new Set(READ_ONLY_TOOLS.map((tool) => tool.toLowerCase()));
  return {
    granted: READ_ONLY_TOOLS.filter((tool) => named.has(tool.toLowerCase())),
    ignored: tools.filter((tool) => !known.has(tool.trim().toLowerCase())),
  };
}

/**
 * Variables that send the subprocess to a credential or an endpoint that
 * is not the subscription login. The run removes them unless the user
 * allows an API key.
 */
export const PROVIDER_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * GitHub tokens. In CI the workflow sets a write-scoped job token for the
 * CLI's own "gh" calls. The SDK does not need it, and a reviewer or a
 * verifier subprocess runs in the PR head checkout. Thus the run always
 * removes these from the SDK env, also when the user allows an API key.
 * The CLI process keeps them.
 */
export const GITHUB_ENV_VARS: readonly string[] = ["GH_TOKEN", "GITHUB_TOKEN"];

/** The tool that a trusted custom reviewer can get. No other query gets it. */
const BASH = "Bash";

/**
 * Tools that no role can use: they write, run commands or reach the
 * network. Only a query that the run grants Bash gets Bash.
 */
export const ALWAYS_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
];

/**
 * Return the exact SDK "Options" object for one query. No query sets
 * "fallbackModel" or a thinking option: effort controls thinking.
 */
export function buildQueryOptions(req: QueryRequest, options: RunOptions): Record<string, unknown> {
  const role = roleConfig(req.role);
  const model = resolveModel(req.overrides?.model ?? role.model);
  const effort = req.overrides?.effort ?? role.effort;
  // A role with no tools gets none. A read-only role gets the read-only
  // tools that the request names, or all of them when it names none, and
  // Bash when the request grants it.
  const readOnly = role.tools === "read-only" ? narrowReadOnlyTools(req.tools).granted : [];
  const bash = role.tools === "read-only" && req.bash === true;

  // The SDK replaces the subprocess environment with "env", so spread the
  // parent environment. An API key, another token or another provider wins
  // over the subscription login, so remove them unless the user allows it.
  // Always remove the GitHub tokens.
  const env: Record<string, string | undefined> = {
    ...options.env,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  for (const name of GITHUB_ENV_VARS) delete env[name];
  if (!options.allowApiKey) {
    for (const name of PROVIDER_ENV_VARS) delete env[name];
  }

  return {
    model,
    effort,
    systemPrompt: req.systemPrompt,
    settingSources: [],
    permissionMode: "dontAsk",
    // "tools" sets which built-in tools exist; "allowedTools" approves them.
    // A granted Bash has the bare rule "Bash", which approves every
    // command. permissionMode stays dontAsk.
    tools: bash ? [...readOnly, BASH] : readOnly,
    allowedTools: bash ? [...readOnly.map(readRule), BASH] : readOnly.map(readRule),
    disallowedTools: [
      ...ALWAYS_DISALLOWED_TOOLS.filter((tool) => !(bash && tool === BASH)),
      ...READ_ONLY_TOOLS.filter((tool) => !readOnly.includes(tool)),
    ],
    outputFormat: { type: "json_schema", schema: toSdkJsonSchema(req.schema) },
    maxTurns: role.maxTurns,
    maxBudgetUsd: role.maxBudgetUsd,
    persistSession: false,
    cwd: req.cwd,
    env,
  };
}
