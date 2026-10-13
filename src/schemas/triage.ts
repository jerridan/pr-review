// The brief that triage returns.
import { z } from "zod";
import { CONFIDENCES } from "./finding.js";
import { ciEnum } from "./json-schema.js";

export const TIERS = ["skip", "fast", "full"] as const;
export type Tier = (typeof TIERS)[number];

export type TriageBrief = {
  tier: "skip" | "fast" | "full";
  reason: string;
  confidence: "low" | "medium" | "high";
  categories: string[];
  hotspots: string[];
  file_notes: { file: string; note: string }[];
  summary: string;
};

export const TriageBriefSchema: z.ZodType<TriageBrief> = z.strictObject({
  tier: ciEnum(TIERS),
  reason: z.string(),
  confidence: ciEnum(CONFIDENCES),
  categories: z.array(z.string()),
  hotspots: z.array(z.string()),
  file_notes: z.array(z.strictObject({ file: z.string(), note: z.string() })),
  summary: z.string(),
});
