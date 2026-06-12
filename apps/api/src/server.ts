import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

app.listen(env.PORT, () => {
  process.stdout.write(`API server listening on port ${env.PORT}\n`);
});
