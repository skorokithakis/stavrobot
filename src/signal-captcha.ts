import http from "http";
import { log } from "./log.js";
import { renderPageShell } from "./shell.js";
import { internalFetch } from "./internal-fetch.js";

const LOGO_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"></rect><path d="M12 7V4"></path><circle cx="9" cy="13" r="1" fill="currentColor"></circle><circle cx="15" cy="13" r="1" fill="currentColor"></circle></svg>';

const BRAND_HTML = `<div class="sb-brand sb-auth-brand"><div class="sb-logo">${LOGO_SVG}</div>Stavrobot</div>`;

const EXTERNAL_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>';

const WARN_ICON_SMALL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';

function buildCaptchaPageHtml(): string {
  const content = `${BRAND_HTML}
<main class="sb-card sb-card-wide" aria-labelledby="captcha-title">
  <div class="sb-auth-h">
    <span class="sb-label">Signal</span>
    <h1 id="captcha-title">Solve the Signal captcha</h1>
    <p class="sb-muted">Signal asks for a captcha before it links the bot's number.</p>
  </div>
  <form class="sb-auth-pad" id="captcha-form" novalidate>
    <ol class="sb-steps">
      <li>
        <div class="sb-step-stack">
          <span>Open the captcha page. It opens in a new tab.</span>
          <a class="sb-btn sb-btn-secondary" href="https://signalcaptchas.org/challenge/generate.html" target="_blank" rel="noopener noreferrer">signalcaptchas.org${EXTERNAL_ICON}</a>
        </div>
      </li>
      <li>Solve the captcha.</li>
      <li><span class="sb-desktop-only">When you see "Open Signal", right-click that link and copy its address.</span><span class="sb-mobile-only">Long-press "Open Signal" and copy the link.</span></li>
      <li>
        <div class="sb-step-stack">
          <div class="sb-field">
            <label for="captcha-input">Paste the value here</label>
            <textarea id="captcha-input" class="sb-input sb-textarea sb-mono sb-captcha-input" spellcheck="false" placeholder="signalcaptcha://signal-hcaptcha.5fad97ac-7d06-4e44-b18a-b950b20148ff.registration.P1_eyJ0eXAiOiJKV1Qi..."></textarea>
            <span class="sb-hint" id="captcha-hint">It starts with signalcaptcha://</span>
            <span class="sb-field-error" id="captcha-error" hidden>${WARN_ICON_SMALL}Paste the signalcaptcha:// value first.</span>
          </div>
        </div>
      </li>
    </ol>
    <div id="captcha-status" hidden></div>
    <button class="sb-btn sb-btn-primary sb-btn-lg sb-btn-block" id="captcha-submit" type="submit">Submit</button>
  </form>
</main>
<script>
(function () {
  var form = document.getElementById("captcha-form");
  var input = document.getElementById("captcha-input");
  var button = document.getElementById("captcha-submit");
  var status = document.getElementById("captcha-status");
  var hint = document.getElementById("captcha-hint");
  var error = document.getElementById("captcha-error");
  var CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';
  var WARN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function clearFieldError() {
    input.classList.remove("is-invalid");
    input.removeAttribute("aria-invalid");
    error.hidden = true;
    hint.hidden = false;
  }

  function showFieldError() {
    input.classList.add("is-invalid");
    input.setAttribute("aria-invalid", "true");
    error.hidden = false;
    hint.hidden = true;
  }

  function setStatus(html) {
    if (html === null) {
      status.innerHTML = "";
      status.hidden = true;
      return;
    }
    status.innerHTML = html;
    status.hidden = false;
  }

  function submitCaptcha() {
    var value = input.value.trim();
    if (!value) {
      showFieldError();
      input.focus();
      return;
    }
    clearFieldError();
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = '<span class="sb-spinner"></span>Submitting...';
    setStatus('<span class="sb-feedback" role="status">Sending the captcha to Signal</span>');
    fetch("/signal/captcha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captcha: value }),
    }).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, data: data };
      });
    }).then(function (result) {
      if (result.ok && result.data.ok === true) {
        setStatus('<div class="sb-banner is-success" role="status">' + CHECK + "Accepted. Signal is linking the number. You can close this page.</div>");
        input.value = "";
      } else {
        var message = result.data.error || "Submission failed. Please try again.";
        setStatus('<div class="sb-banner is-error" role="alert">' + WARN + escapeHtml(message) + "</div>");
      }
    }).catch(function () {
      setStatus('<div class="sb-banner is-error" role="alert">' + WARN + "Network error. Please try again.</div>");
    }).finally(function () {
      button.disabled = false;
      button.classList.remove("is-loading");
      button.textContent = "Submit";
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submitCaptcha();
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitCaptcha();
    }
  });

  input.addEventListener("input", clearFieldError);
})();
</script>`;

  return renderPageShell({ title: "Signal captcha", content });
}

export function serveSignalCaptchaPage(response: http.ServerResponse): void {
  log.debug("[stavrobot] serveSignalCaptchaPage: serving captcha page");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(buildCaptchaPageHtml());
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

  const bridgeResponse = await internalFetch("http://signal-bridge:8081/challenge", {
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
