import "dotenv/config";

import { Ollama } from "ollama";

import { OLLAMA_CONTEXT_WINDOW, OLLAMA_MODELS, OLLAMA_TEMPERATURE } from "./config.js";

const ollamaHost = process.env.OLLAMA_HOST;

if (ollamaHost === undefined || ollamaHost.trim() === "") {
  throw new Error("Missing required environment variable: OLLAMA_HOST");
}

const ollamaClient = new Ollama({
  host: ollamaHost,
});

export async function generateChatResponse(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const response = await ollamaClient.chat({
    model: OLLAMA_MODELS.CODE_REVIEW,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    options: {
      temperature: OLLAMA_TEMPERATURE,
      num_ctx: OLLAMA_CONTEXT_WINDOW,
    },
  });

  return response.message.content;
}
