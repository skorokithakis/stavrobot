// Subagents use this marker as their final text when they have nothing to report
// to the main agent. Such turns are not forwarded.
export const NOTHING_TO_REPORT = "NOTHING_TO_REPORT";

// Whether a subagent's final text is forwarded to the main agent. An empty text
// or the marker are deliberate signals that there is nothing to report; any
// other text is forwarded. The queue forwards with this rule and the nudge uses
// it to tell a deliberate silence from a reply written in the final text.
export function shouldForwardSubagentFinalText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") {
    return false;
  }
  return trimmed.toLowerCase() !== NOTHING_TO_REPORT.toLowerCase();
}
