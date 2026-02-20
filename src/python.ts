import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const PYTHON_RUNNER_URL = "http://python-runner:3003/run";

export function createRunPythonTool(): AgentTool {
  return {
    name: "run_python",
    label: "Run Python",
    description:
      "Execute a Python script. The code runs via uv and can use any pip package by " +
      "specifying dependencies. Returns stdout and stderr from the script.",
    parameters: Type.Object({
      code: Type.String({ description: "The Python code to execute." }),
      dependencies: Type.Optional(
        Type.Array(Type.String(), {
          description: "Pip package specifiers (e.g. [\"requests\", \"numpy>=1.24\"]).",
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { code, dependencies = [] } = params as {
        code: string;
        dependencies?: string[];
      };

      console.log(
        `[stavrobot] run_python called: code length=${code.length}, dependencies=${dependencies.length}`,
      );

      let output: string;
      try {
        const response = await fetch(PYTHON_RUNNER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, dependencies }),
          signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          output = `python-runner returned HTTP ${response.status}: ${errorText}`;
          console.error(`[stavrobot] run_python HTTP error: ${response.status}`);
        } else {
          const json: unknown = await response.json();
          if (
            typeof json === "object" &&
            json !== null &&
            "output" in json &&
            typeof (json as Record<string, unknown>).output === "string"
          ) {
            output = (json as Record<string, unknown>).output as string;
            console.log(`[stavrobot] run_python succeeded, output length=${output.length}`);
          } else {
            output = "python-runner returned unexpected response format";
            console.error("[stavrobot] run_python unexpected response format:", json);
          }
        }
      } catch (error) {
        output = `python-runner request failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[stavrobot] run_python fetch error: ${output}`);
      }

      return {
        content: [{ type: "text" as const, text: output }],
        details: { result: output },
      };
    },
  };
}
