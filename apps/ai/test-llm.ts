import { generateChatResponse } from "./src/ollama/client";

async function runTest() {
  console.log("🤖 Sending test prompt to Ollama...");
  try {
    const response = await generateChatResponse(
      "You are a strict code reviewer.",
      "Review this line of code: const x = 10;",
    );
    console.log("\n✅ Success! LLM Response:");
    console.log(response);
  } catch (error) {
    console.error("\n❌ LLM Connection Failed:", error);
  }
}

runTest();
