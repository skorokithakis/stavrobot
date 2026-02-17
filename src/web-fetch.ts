import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { WebFetchConfig } from "./config.js";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicResponse {
  content: AnthropicTextBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAndProcess(
  apiKey: string,
  model: string,
  url: string,
  task: string,
): Promise<string> {
  console.log(`[stavrobot] web_fetch fetching URL: ${url}`);

  const fetchResponse = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Stavrobot/1.0)",
    },
  });

  if (!fetchResponse.ok) {
    throw new Error(`HTTP ${fetchResponse.status} fetching ${url}: ${fetchResponse.statusText}`);
  }

  const html = await fetchResponse.text();
  let text = stripHtmlTags(html);

  // Roughly 4 characters per token, and we want to stay well within the context
  // window while leaving room for the system prompt, task, and output tokens.
  const maxCharacters = 400_000;
  if (text.length > maxCharacters) {
    console.log(`[stavrobot] web_fetch truncating page content from ${text.length} to ${maxCharacters} characters`);
    text = text.slice(0, maxCharacters);
  }

  console.log(`[stavrobot] web_fetch fetched ${text.length} characters of text from ${url}`);

  const systemPrompt =
    "You are a web page analysis assistant. You will receive the text content " +
    "of a web page and a task describing what to do with it. Execute the task " +
    "against the page content and return your result. Be precise and thorough.";

  const userMessage = `Task: ${task}\n\nPage URL: ${url}\n\nPage content:\n${text}`;

  console.log(`[stavrobot] web_fetch calling LLM (model: ${model})`);

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
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[stavrobot] web_fetch API error ${response.status}: ${errorText}`);
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as AnthropicResponse;

  console.log(`[stavrobot] web_fetch LLM done (input_tokens: ${result.usage.input_tokens}, output_tokens: ${result.usage.output_tokens})`);

  const textParts = result.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text);

  return textParts.join("");
}

export function createWebFetchTool(webFetchConfig: WebFetchConfig): AgentTool {
  return {
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch a web page and process its content with an LLM. Use this when you " +
      "have a specific URL and need to extract information from it, summarize it, " +
      "or perform any analysis on its content. Provide the URL and a detailed " +
      "task description explaining what you want done with the page content.",
    parameters: Type.Object({
      url: Type.String({
        description: "The URL of the web page to fetch.",
      }),
      task: Type.String({
        description:
          "A detailed description of what to do with the page content. For example: " +
          "'summarize this page', 'extract all product names and prices', " +
          "'find the author and publication date', etc. Be specific about what " +
          "information you need and in what format.",
      }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { url, task } = params as { url: string; task: string };

      console.log(`[stavrobot] web_fetch called: url=${url}, task=${task}`);

      try {
        const result = await fetchAndProcess(webFetchConfig.apiKey, webFetchConfig.model, url, task);

        const truncatedResult = result.length > 500 ? result.slice(0, 500) + "..." : result;
        console.log("[stavrobot] web_fetch result:", truncatedResult);

        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[stavrobot] web_fetch failed:", errorMessage);
        return {
          content: [{ type: "text" as const, text: `Web fetch failed: ${errorMessage}` }],
          details: { result: `Web fetch failed: ${errorMessage}` },
        };
      }
    },
  };
}
