// The frontmatter of a reviewer file. This schema is not sent to a model,
// but it keeps the same rules: the range checks run in code.
import { z } from "zod";
import { EFFORTS, type Effort } from "../config/models.js";
import { ciEnum, integer } from "./json-schema.js";

export type ReviewerFrontmatter = {
  name: string;
  description: string;
  model: string;
  effort: Effort;
  tools: string[];
  triggers: { paths: string[]; categories: string[]; min_tier: "fast" | "full" };
  passes: number;
  threshold: number;
  trusted: boolean;
};

export const ReviewerFrontmatterSchema: z.ZodType<ReviewerFrontmatter> = z.strictObject({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  effort: ciEnum(EFFORTS as readonly [Effort, ...Effort[]]),
  tools: z.array(z.string()),
  triggers: z.strictObject({
    paths: z.array(z.string()),
    categories: z.array(z.string()),
    min_tier: ciEnum(["fast", "full"] as const),
  }),
  passes: integer().refine((value) => value >= 1, { message: "passes must be 1 or more" }),
  threshold: integer().refine((value) => value >= 0 && value <= 100, {
    message: "threshold must be from 0 to 100",
  }),
  trusted: z.boolean(),
});
