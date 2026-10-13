// Build the SDK options for one query. This module is pure and does not
// import the SDK, so tests can check every option without it.
import { ROLE_DEFAULTS, resolveModel } from "../config/models.js";
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
export const READ_ONLY_RULES: readonly string[] = READ_ONLY_TOOLS.map((tool) => `${tool}(./**)`);

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

/** Tools that no role can use: they write, run commands or reach the network. */
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
  const role = ROLE_DEFAULTS[req.role];
  const model = resolveModel(req.overrides?.model ?? role.model);
  const effort = req.overrides?.effort ?? role.effort;
  const readOnly = role.tools === "read-only";

  // The SDK replaces the subprocess environment with "env", so spread the
  // parent environment. An API key, another token or another provider wins
  // over the subscription login, so remove them unless the user allows it.
  const env: Record<string, string | undefined> = {
    ...options.env,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
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
    tools: readOnly ? [...READ_ONLY_TOOLS] : [],
    allowedTools: readOnly ? [...READ_ONLY_RULES] : [],
    disallowedTools: readOnly
      ? [...ALWAYS_DISALLOWED_TOOLS]
      : [...ALWAYS_DISALLOWED_TOOLS, ...READ_ONLY_TOOLS],
    outputFormat: { type: "json_schema", schema: toSdkJsonSchema(req.schema) },
    maxTurns: role.maxTurns,
    maxBudgetUsd: role.maxBudgetUsd,
    persistSession: false,
    cwd: req.cwd,
    env,
  };
}
