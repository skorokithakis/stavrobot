import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function toolError(message: string): AgentToolResult<{ message: string }> {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { message },
  };
}

export function toolSuccess(text: string): AgentToolResult<{ message: string }> {
  return {
    content: [{ type: "text" as const, text }],
    details: { message: text },
  };
}
