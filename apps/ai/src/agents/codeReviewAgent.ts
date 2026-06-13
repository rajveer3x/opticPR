import { z } from "zod";

import { generateChatResponse } from "../ollama/client.js";

const severitySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const codeReviewResultSchema = z
  .object({
    issues: z.array(
      z
        .object({
          severity: severitySchema,
          file: z.string().min(1),
          line: z.number().int().positive(),
          description: z.string().min(1),
          suggestion: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type CodeReviewResult = z.infer<typeof codeReviewResultSchema>;

const systemPrompt = [
  "You are a senior code review agent.",
  "Analyze the provided pull request diff for bugs, logic errors, and code quality issues.",
  "Return only valid JSON matching this exact shape:",
  '{"issues":[{"severity":"LOW|MEDIUM|HIGH|CRITICAL","file":"string","line":1,"description":"string","suggestion":"string"}]}',
  "Use an empty issues array when no issues are found.",
  "Do not include markdown fences or additional text.",
].join("\n");

export async function codeReviewAgent(diff: string): Promise<CodeReviewResult> {
  const response = await generateChatResponse(systemPrompt, diff);
  const parsed: unknown = JSON.parse(response);

  return codeReviewResultSchema.parse(parsed);
}
