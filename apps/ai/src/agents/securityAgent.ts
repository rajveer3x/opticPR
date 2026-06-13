import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { generateChatResponse } from "../ollama/client.js";

const execFileAsync = promisify(execFile);

const severitySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const securityResultSchema = z
  .object({
    alerts: z.array(
      z
        .object({
          severity: severitySchema,
          type: z.string().min(1),
          file: z.string().min(1),
          description: z.string().min(1),
          recommendation: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const semgrepResultSchema = z
  .object({
    check_id: z.string(),
    path: z.string(),
    start: z.object({ line: z.number().int() }).passthrough(),
    end: z.object({ line: z.number().int() }).passthrough(),
    extra: z
      .object({
        message: z.string(),
        severity: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const semgrepOutputSchema = z
  .object({
    results: z.array(semgrepResultSchema),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type SecurityResult = z.infer<typeof securityResultSchema>;

interface DiffFile {
  path: string;
  content: string;
}

function extractChangedFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentPath !== undefined) {
      files.push({
        path: currentPath,
        content: currentLines.join("\n"),
      });
    }

    currentPath = undefined;
    currentLines = [];
  };

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      flush();
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();

      if (path !== "/dev/null") {
        currentPath = path.startsWith("b/") ? path.slice(2) : path;
      }

      continue;
    }

    if (
      currentPath !== undefined &&
      !line.startsWith("@@") &&
      !line.startsWith("--- ") &&
      !line.startsWith("\\ No newline") &&
      (line.startsWith("+") || line.startsWith(" "))
    ) {
      currentLines.push(line.slice(1));
    }
  }

  flush();

  return files;
}

function resolveSafePath(root: string, filePath: string): string {
  const normalizedPath = normalize(filePath).replace(/^([/\\])+/, "");
  const resolvedPath = resolve(root, normalizedPath);
  const relativePath = relative(root, resolvedPath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Invalid diff file path: ${filePath}`);
  }

  return resolvedPath;
}

async function runSemgrep(diff: string): Promise<z.infer<typeof semgrepOutputSchema>> {
  const scanDirectory = await mkdtemp(join(tmpdir(), "opticpr-semgrep-"));

  try {
    const files = extractChangedFiles(diff);

    if (files.length === 0) {
      await writeFile(join(scanDirectory, "changes.patch"), diff, "utf8");
    } else {
      for (const file of files) {
        const targetPath = resolveSafePath(scanDirectory, file.path);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.content, "utf8");
      }
    }

    const { stdout } = await execFileAsync(
      process.env.SEMGREP_PATH ?? "semgrep",
      ["scan", "--config=p/owasp-top-ten", "--json", "--quiet", scanDirectory],
      {
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const output: unknown = JSON.parse(stdout);

    return semgrepOutputSchema.parse(output);
  } finally {
    await rm(scanDirectory, { recursive: true, force: true });
  }
}

const systemPrompt = [
  "You are a senior application security review agent.",
  "Analyze the pull request diff and Semgrep findings for OWASP vulnerabilities and security risks.",
  "Validate Semgrep findings, identify risks Semgrep missed, and avoid duplicate alerts.",
  "Return only valid JSON matching this exact shape:",
  '{"alerts":[{"severity":"LOW|MEDIUM|HIGH|CRITICAL","type":"string","file":"string","description":"string","recommendation":"string"}]}',
  "Use an empty alerts array when no security risks are found.",
  "Do not include markdown fences or additional text.",
].join("\n");

export async function securityAgent(diff: string): Promise<SecurityResult> {
  const semgrepOutput = await runSemgrep(diff);
  const userPrompt = JSON.stringify({
    diff,
    semgrep: semgrepOutput,
  });
  const response = await generateChatResponse(systemPrompt, userPrompt);
  const parsed: unknown = JSON.parse(response);

  return securityResultSchema.parse(parsed);
}
