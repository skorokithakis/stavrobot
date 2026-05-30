import pg from "pg";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { loadAgent } from "./database.js";
import { enqueueMessage } from "./queue.js";
import { log } from "./log.js";
import { toolError, toolSuccess } from "./tool-result.js";

export function createSendAgentMessageTool(pool: pg.Pool, getCurrentAgentId: () => number): AgentTool {
  return {
    name: "send_agent_message",
    label: "Send agent message",
    description: "Send a message to another agent. The message is enqueued and processed asynchronously.",
    parameters: Type.Object({
      agent_id: Type.Number({ description: "The ID of the target agent." }),
      message: Type.String({ description: "The message text to send." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        agent_id: number;
        message: string;
      };

      const { agent_id: agentId, message } = raw;
      const senderAgentId = getCurrentAgentId();

      const targetAgent = await loadAgent(pool, agentId);
      if (targetAgent === null) {
        return toolError(`Error: agent ${agentId} not found.`);
      }

      void enqueueMessage(message, "agent", String(senderAgentId), undefined, agentId);

      const resultMessage = `Message sent to agent ${agentId}.`;
      log.info(`[stavrobot] ${resultMessage}`);
      return toolSuccess(resultMessage);
    },
  };
}
