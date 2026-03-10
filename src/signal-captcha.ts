import http from "http";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";

const SIGNAL_CAPTCHA_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signal captcha</title>
  <style>
    ${getBaseStyles()}
    body { padding: 24px; }
    p {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 12px;
    }
    ol {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 16px;
      padding-left: 20px;
    }
    ol li {
      margin-bottom: 6px;
    }
    a {
      color: var(--color-accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    textarea {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 14px;
      font-family: monospace;
      resize: vertical;
      min-height: 80px;
      transition: all 0.15s ease;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .btn {
      margin-top: 12px;
      padding: 8px 16px;
      border: 1px solid var(--color-accent);
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      background: var(--color-accent);
      color: #fff;
      box-shadow: 0 1px 2px var(--color-shadow);
      transition: all 0.15s ease;
    }
    .btn:hover:not(:disabled) {
      background: var(--color-accent-hover);
      border-color: var(--color-accent-hover);
      box-shadow: 0 2px 4px var(--color-shadow);
      transform: translateY(-1px);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    #status {
      font-size: 13px;
      margin-top: 12px;
      display: block;
    }
    #status.success { color: var(--color-success); }
    #status.error { color: var(--color-error); }
  </style>
</head>
<body>
  <h1>Signal captcha</h1>
  <div class="section">
    <ol>
      <li>Open <a href="https://signalcaptchas.org/challenge/generate.html" target="_blank" rel="noopener noreferrer">signalcaptchas.org</a> and solve the captcha.</li>
      <li>Copy the <code>signalcaptcha://</code> URL shown after solving.</li>
      <li>Paste it below and click Submit.</li>
    </ol>
    <textarea id="captcha-input" placeholder="signalcaptcha://..."></textarea>
    <button class="btn" id="submit-btn" onclick="submitCaptcha()">Submit</button>
    <span id="status"></span>
  </div>

  <script>
    async function submitCaptcha() {
      const input = document.getElementById("captcha-input");
      const btn = document.getElementById("submit-btn");
      const value = input.value.trim();

      if (!value) {
        setStatus("Please paste the signalcaptcha:// URL first.", true);
        return;
      }

      btn.disabled = true;
      setStatus("Submitting...", false);

      try {
        const response = await fetch("/signal/captcha", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ captcha: value }),
        });
        const data = await response.json();
        if (response.ok && data.ok === true) {
          setStatus("Captcha submitted successfully. You can now tell the bot to retry.", false);
          input.value = "";
        } else {
          const message = data.error || "Submission failed. Please try again.";
          setStatus(message, true);
        }
      } catch (error) {
        setStatus("Network error. Please try again.", true);
      } finally {
        btn.disabled = false;
      }
    }

    function setStatus(text, isError) {
      const el = document.getElementById("status");
      el.textContent = text;
      el.className = text ? (isError ? "error" : "success") : "";
    }

    document.getElementById("captcha-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitCaptcha();
      }
    });
  </script>
</body>
</html>`;

export function serveSignalCaptchaPage(response: http.ServerResponse): void {
  log.debug("[stavrobot] serveSignalCaptchaPage: serving captcha page");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(SIGNAL_CAPTCHA_PAGE_HTML);
}

export async function handleSignalCaptchaSubmit(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Request body must be a JSON object" }));
    return;
  }

  const captcha = (parsed as Record<string, unknown>).captcha;
  if (typeof captcha !== "string" || captcha.trim() === "") {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'captcha' must be a non-empty string" }));
    return;
  }

  log.debug("[stavrobot] handleSignalCaptchaSubmit: proxying captcha to signal-bridge");

  const bridgeResponse = await fetch("http://signal-bridge:8081/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ captcha: captcha.trim() }),
  });

  const bridgeText = await bridgeResponse.text();
  log.debug("[stavrobot] handleSignalCaptchaSubmit: bridge response status:", bridgeResponse.status);

  response.writeHead(bridgeResponse.status, { "Content-Type": "application/json" });
  // Forward the bridge response body as-is if it is valid JSON, otherwise wrap it.
  try {
    JSON.parse(bridgeText);
    response.end(bridgeText);
  } catch {
    response.end(JSON.stringify({ error: bridgeText || "Unknown error from signal bridge" }));
  }
}
