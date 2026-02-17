import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { WebSearchConfig } from "./config.js";

interface WebSearchToolUse {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: { query: string };
}

interface WebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string;
}

interface WebSearchToolResult {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: WebSearchResult[] | { type: "web_search_tool_result_error"; error_code: string };
}

interface TextBlock {
  type: "text";
  text: string;
  citations?: Array<{
    type: "web_search_result_location";
    url: string;
    title: string;
    cited_text: string;
  }>;
}

type ContentBlock = WebSearchToolUse | WebSearchToolResult | TextBlock;

interface AnthropicResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Calls the Anthropic Messages API directly with the web search server-side
// tool enabled. Passes the full conversation (system prompt + user query) and
// lets Claude decide when and how often to search. Handles the pause_turn
// continuation loop so multi-search turns complete fully.
async function executeWebSearch(
  apiKey: string,
  model: string,
  query: string,
  maxUses: number,
): Promise<string> {
  const systemPrompt =
    "You are a web research assistant. Search the web to find the information " +
    "requested by the user. Be thorough: perform multiple searches if needed " +
    "to fully answer the query. Return a clear, well-structured summary of " +
    "what you found, citing sources with URLs. Focus on facts and direct " +
    "answers rather than hedging.";

  let messages: Array<{ role: string; content: string | ContentBlock[] }> = [
    { role: "user", content: query },
  ];

  // The API may return pause_turn if the turn is long-running. We feed the
  // response back as-is to let Claude continue until it finishes.
  let continueLoop = true;
  let finalTextParts: string[] = [];
  let iteration = 0;

  while (continueLoop) {
    iteration++;
    console.log(`[stavrobot] web_search API call #${iteration} (model: ${model}, max_uses: ${maxUses})`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: maxUses,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[stavrobot] web_search API error ${response.status}: ${errorText}`);
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as AnthropicResponse;

    const searchQueries: string[] = [];
    finalTextParts = [];
    for (const block of result.content) {
      if (block.type === "text") {
        finalTextParts.push(block.text);
      } else if (block.type === "server_tool_use" && block.name === "web_search") {
        searchQueries.push(block.input.query);
      }
    }

    if (searchQueries.length > 0) {
      console.log(`[stavrobot] web_search queries: ${searchQueries.map((q) => `"${q}"`).join(", ")}`);
    }

    console.log(`[stavrobot] web_search API call #${iteration} done (stop_reason: ${result.stop_reason}, input_tokens: ${result.usage.input_tokens}, output_tokens: ${result.usage.output_tokens})`);

    if (result.stop_reason === "pause_turn") {
      console.log("[stavrobot] web_search pause_turn received, continuing...");
      messages = [
        ...messages,
        { role: "assistant", content: result.content },
        { role: "user", content: "Continue." },
      ];
    } else {
      continueLoop = false;
    }
  }

  return finalTextParts.join("");
}

export function createWebSearchTool(webSearchConfig: WebSearchConfig): AgentTool {
  return {
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for current information. Use this when you need up-to-date " +
      "facts, news, prices, weather, or anything beyond your training data. Provide " +
      "a detailed query describing what information you need and what you want " +
      "returned, the query will be passed to an agent, so add required detail on " +
      "what you want to search for, and what you want returned, as if you're talking " +
      "to a person. No need to be terse, give detail and context. The tool performs " +
      "searches and returns a summarised answer with source URLs.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "A detailed query describing what to search for, written as if you are " +
          "talking to a research assistant. Include context on why you need the " +
          "information, what specific facts or details to look for, and what format " +
          "you want the answer in. Be verbose rather than terse — the more detail " +
          "you provide, the better the results.",
      }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ summary: string }>> => {
      const { query } = params as { query: string };
      const maxUses = 5;

      console.log("[stavrobot] web_search called:", query);

      try {
        const summary = await executeWebSearch(webSearchConfig.apiKey, webSearchConfig.model, query, maxUses);

        const truncatedSummary = summary.length > 500 ? summary.slice(0, 500) + "..." : summary;
        console.log("[stavrobot] web_search result:", truncatedSummary);

        return {
          content: [{ type: "text" as const, text: summary }],
          details: { summary },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[stavrobot] web_search failed:", errorMessage);
        return {
          content: [{ type: "text" as const, text: `Web search failed: ${errorMessage}` }],
          details: { summary: `Web search failed: ${errorMessage}` },
        };
      }
    },
  };
}
