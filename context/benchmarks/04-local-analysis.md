# Local analysis demo-machine measurement

Measured on 2026-11-17 (Asia/Kolkata) on an Apple M5 with 16 GiB unified memory, using Ollama 0.31.1 and the pinned qwen2.5-coder:7b Q4_K_M manifest. [Raw results](04-local-analysis.json) include revision identifiers, run IDs and complete candidate outputs.

| Context tokens | Source mode | Inference latency | Peak runner RSS | Loaded model / accelerator | Accepted / rejected |
| --- | --- | --- | --- | --- | --- |
| 4096 | diff-only | 13.94 s | 4.76 GiB | 4.42 GiB | 1 / 0 |
| 4096 | function-context | 11.59 s | 4.44 GiB | 4.42 GiB | 1 / 0 |
| 8192 | diff-only | 13.83 s | 4.93 GiB | 4.64 GiB | 1 / 0 |
| 8192 | function-context | 11.68 s | 4.66 GiB | 4.64 GiB | 1 / 0 |

Each setting retained one static pagination alert, completed enrichment, accepted one exact-evidence proposal and rejected none. All four model outputs repeated the existing static observation with the correct head SHA, path and lines 3–4. They added no new finding, stronger explanation or verification case. Quality was therefore tied on this fixture; evidence acceptance is not an independent measure of model defect discovery.

4096 used about 0.22 GiB less loaded memory than 8192 and remains the default. The five-line fixture fits both source modes; these single samples establish that both paths work, but cannot show a function-context quality advantage or a reliable latency difference. A broader labeled benchmark belongs to the evaluation slice.

The commands ran sequentially with no competing OpticPR reviews. There was one sample per setting, deterministic temperature 0 / seed 0, no explicit cold-cache reset, and a model reload when the context size changed. Inference latency includes model metadata verification and generation, including reload when needed; overall elapsed time is also recorded in JSON. Static checkpoints were reused from the preceding real scanner run. RSS was sampled every 250 ms from the local model runner; loaded/accelerator bytes come from `/api/ps`. On this unified-memory machine these measurements overlap and must not be added together.

Reproduce with `pnpm analysis:scanner:pull`, a running loopback Ollama server with `OLLAMA_NUM_PARALLEL=1`, and `pnpm analysis:benchmark` after migrations/build. The benchmark updates the four configuration-specific runs and overwrites the output JSON.
