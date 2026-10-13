// Convert zod schemas to the draft-07 JSON Schema that the SDK takes, and
// hold the schema parts that every schema file shares.
import { z } from "zod";

/**
 * Keywords that no SDK schema may hold. Range, length and count checks run
 * in code. "$ref" shows recursion. "minItems" is checked apart, because a
 * value of 0 or 1 is permitted.
 */
export const FORBIDDEN_SCHEMA_KEYWORDS: readonly string[] = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "minProperties",
  "maxProperties",
  "$ref",
  "$defs",
  "definitions",
];

/**
 * An enum that compares values case-insensitively. Give the values in
 * lower case. The parsed value is in lower case.
 */
export function ciEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(values),
  );
}

/**
 * An integer. zod adds the safe-integer range to "z.int()" in JSON Schema,
 * and the SDK schema must not hold a range. This schema checks the integer
 * in code and gives only "type: integer" in JSON Schema.
 */
export function integer() {
  return z
    .number()
    .refine((value) => Number.isInteger(value), { message: "Expected an integer" })
    .meta({ type: "integer" });
}

type Violation = { path: string; problem: string };

function collectViolations(node: unknown, path: string, out: Violation[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectViolations(item, `${path}/${i}`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
    if (keyword in schema) out.push({ path, problem: `holds ${keyword}` });
  }
  if (typeof schema.minItems === "number" && schema.minItems > 1) {
    out.push({ path, problem: "holds minItems above 1" });
  }
  if (schema.type === "object" && schema.additionalProperties !== false) {
    out.push({ path, problem: "is an object without additionalProperties false" });
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      // The keys of "properties" are field names, not keywords.
      for (const [name, sub] of Object.entries(value)) {
        collectViolations(sub, `${path}/properties/${name}`, out);
      }
    } else if (typeof value === "object") {
      collectViolations(value, `${path}/${key}`, out);
    }
  }
}

/**
 * Convert a zod schema to draft-07 JSON Schema for the SDK "outputFormat".
 * Throw when the result holds a forbidden keyword, or an object that does
 * not set "additionalProperties" to false.
 */
export function toSdkJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<
    string,
    unknown
  >;
  const violations: Violation[] = [];
  collectViolations(json, "#", violations);
  if (violations.length > 0) {
    const lines = violations.map((v) => `${v.path} ${v.problem}`);
    throw new Error(`Schema is not valid for the SDK:\n${lines.join("\n")}`);
  }
  return json;
}
