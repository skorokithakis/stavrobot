import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";
import { internalFetch } from "./internal-fetch.js";
import { toolError, toolSuccess } from "./tool-result.js";

const PYTHON_RUNNER_URL = "http://python-runner:3003/run";
const PYTHON_RUNNER_OUTPUT_DIR = path.join(TEMP_ATTACHMENTS_DIR, "python-runner");

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createRunPythonTool(): AgentTool {
  return {
    name: "run_python",
    label: "Run Python",
    description:
      "Execute a Python script. The code runs via uv and can use any pip package by " +
      "specifying dependencies. Returns stdout and stderr from the script. " +
      "Input files can be passed via the `files` parameter as absolute paths under " +
      `/tmp/stavrobot-temp/. They will be available to the script at /tmp/input/<filename>. ` +
      "Output files should be written by the script to /tmp/output/. They will be returned and saved locally.",
    parameters: Type.Object({
      code: Type.String({ description: "The Python code to execute." }),
      dependencies: Type.Optional(
        Type.Array(Type.String(), {
          description: "Pip package specifiers (e.g. [\"requests\", \"numpy>=1.24\"]).",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: `Absolute paths to files under /tmp/stavrobot-temp/ to pass as input. Each file will be available to the script at /tmp/input/<filename>.`,
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { code, dependencies = [], files = [] } = params as {
        code: string;
        dependencies?: string[];
        files?: string[];
      };

      // Validate and encode input files.
      const inputFiles: Array<{ filename: string; data: string }> = [];
      const resolvedTempDir = path.resolve(TEMP_ATTACHMENTS_DIR);
      for (const filePath of files) {
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(resolvedTempDir + path.sep) && resolvedPath !== resolvedTempDir) {
          const errorMessage = `Error: file path is outside the allowed directory (${TEMP_ATTACHMENTS_DIR}): ${filePath}`;
          log.warn(`[stavrobot] run_python path validation failed: ${filePath}`);
          return toolError(errorMessage);
        }
        const data = await fs.readFile(resolvedPath);
        inputFiles.push({ filename: path.basename(resolvedPath), data: data.toString("base64") });
      }

      // Clear the output directory before each run so stale files from previous runs
      // are not mixed with the current run's output.
      await fs.rm(PYTHON_RUNNER_OUTPUT_DIR, { recursive: true, force: true });

      let output: string;
      try {
        const response = await internalFetch(PYTHON_RUNNER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, dependencies, files: inputFiles }),
          signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          output = `python-runner returned HTTP ${response.status}: ${errorText}`;
          log.error(`[stavrobot] run_python HTTP error: ${response.status}`);
        } else {
          const json: unknown = await response.json();
          if (
            typeof json === "object" &&
            json !== null &&
            "output" in json &&
            typeof (json as Record<string, unknown>).output === "string"
          ) {
            output = (json as Record<string, unknown>).output as string;

            // Save output files returned by the python-runner.
            const rawFiles = (json as Record<string, unknown>).files;
            if (Array.isArray(rawFiles) && rawFiles.length > 0) {
              await fs.mkdir(PYTHON_RUNNER_OUTPUT_DIR, { recursive: true });
              const savedPaths: string[] = [];
              for (const rawFile of rawFiles) {
                if (
                  typeof rawFile === "object" &&
                  rawFile !== null &&
                  "filename" in rawFile &&
                  typeof (rawFile as Record<string, unknown>).filename === "string" &&
                  "data" in rawFile &&
                  typeof (rawFile as Record<string, unknown>).data === "string"
                ) {
                  const filename = (rawFile as Record<string, unknown>).filename as string;
                  const data = (rawFile as Record<string, unknown>).data as string;
                  const outPath = path.join(PYTHON_RUNNER_OUTPUT_DIR, filename);
                  const buffer = Buffer.from(data, "base64");
                  await fs.writeFile(outPath, buffer);
                  savedPaths.push(outPath);
                  log.debug(`[stavrobot] run_python saved output file: ${outPath} (${buffer.length} bytes)`);
                }
              }
              if (savedPaths.length > 0) {
                const fileLines = await Promise.all(
                  savedPaths.map(async (savedPath) => {
                    const stat = await fs.stat(savedPath);
                    return `- ${savedPath} (${formatFileSize(stat.size)})`;
                  }),
                );
                output += `\n\nOutput files:\n${fileLines.join("\n")}`;
              }
            }
          } else {
            output = "python-runner returned unexpected response format";
            log.error("[stavrobot] run_python unexpected response format:", json);
          }
        }
      } catch (error) {
        output = `python-runner request failed: ${error instanceof Error ? error.message : String(error)}`;
        log.error(`[stavrobot] run_python fetch error: ${output}`);
      }

      return toolSuccess(output);
    },
  };
}
