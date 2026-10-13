// The finding that a reviewer reports. Range checks on the lines run in code.
import { z } from "zod";
import { ciEnum, integer } from "./json-schema.js";

export const CATEGORIES = [
  "bug",
  "security",
  "test",
  "convention",
  "docs",
  "performance",
  "other",
] as const;
export const SEVERITIES = ["blocking", "suggestion", "nit"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export type Finding = {
  file: string;
  start_line: number;
  end_line: number;
  category: "bug" | "security" | "test" | "convention" | "docs" | "performance" | "other";
  severity_estimate: "blocking" | "suggestion" | "nit";
  confidence: "low" | "medium" | "high";
  claim: string;
  evidence: string;
  suggested_fix?: string;
  explanation: string;
  needs_context: boolean;
};

export const severitySchema = () => ciEnum(SEVERITIES);
export const confidenceSchema = () => ciEnum(CONFIDENCES);

/** The fields of a finding, for schemas that extend it. */
export const findingShape = {
  file: z.string(),
  start_line: integer(),
  end_line: integer(),
  category: ciEnum(CATEGORIES),
  severity_estimate: severitySchema(),
  confidence: confidenceSchema(),
  claim: z.string(),
  evidence: z.string(),
  suggested_fix: z.string().optional(),
  explanation: z.string(),
  needs_context: z.boolean(),
};

export const FindingSchema: z.ZodType<Finding> = z.strictObject(findingShape);

export type FindingsOutput = { findings: Finding[] };

export const FindingsOutputSchema: z.ZodType<FindingsOutput> = z.strictObject({
  findings: z.array(FindingSchema),
});
