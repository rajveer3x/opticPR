import { z } from "zod";

import { generateChatResponse } from "../ollama/client.js";

export const summaryResultSchema = z
  .object({
    summary: z.string().min(1),
  })
  .strict();

export type SummaryResult = z.infer<typeof summaryResultSchema>;

const systemPrompt = [
  "You are a pull request summary agent.",
  "Generate a concise markdown summary of the provided pull request diff.",
  "Describe the purpose, key changes, and relevant implementation details.",
  "Return only valid JSON matching this exact shape:",
  '{"summary":"markdown string"}',
  "Do not include markdown fences around the JSON or additional text.",
].join("\n");

export async function summaryAgent(diff: string): Promise<SummaryResult> {
  const response = await generateChatResponse(systemPrompt, diff);
  const parsed: unknown = JSON.parse(response);

  return summaryResultSchema.parse(parsed);
}
