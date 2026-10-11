import http from "http";
import { describe, expect, it } from "vitest";
import { serveSignalCaptchaPage } from "./signal-captcha.js";

interface MockResponse {
  writes: string[];
  statusCode: number | undefined;
  writeHead(statusCode: number): void;
  write(chunk: string): boolean;
  end(chunk?: string): void;
}

function makeResponse(): MockResponse {
  return {
    writes: [],
    statusCode: undefined,
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    },
    end(chunk?: string): void {
      if (chunk !== undefined) {
        this.writes.push(chunk);
      }
    },
  };
}

describe("serveSignalCaptchaPage", (): void => {
  it("renders the captcha form inside the shared shell's centered card", (): void => {
    const response = makeResponse();
    serveSignalCaptchaPage(response as unknown as http.ServerResponse);
    const html = response.writes.join("");

    expect(html).toContain('href="/assets/sb.css"');
    expect(html).toContain("sb-centered");
    expect(html).toContain("sb-auth-card");
    expect(html).not.toContain("sb-sidebar");
    expect(html).toContain("Solve the Signal captcha");
    expect(html).toContain("signalcaptchas.org");
    expect(html).toContain('id="captcha-input"');
    expect(html).toContain("sb-captcha-input");
    expect(html).toContain("signalcaptcha://");
    expect(html).toContain('id="captcha-error"');
    expect(html).toContain('id="captcha-status"');
    expect(html).toContain('id="captcha-submit"');
  });

  it("ships both desktop and mobile wording for the copy step", (): void => {
    const response = makeResponse();
    serveSignalCaptchaPage(response as unknown as http.ServerResponse);
    const html = response.writes.join("");

    expect(html).toContain("sb-desktop-only");
    expect(html).toContain("sb-mobile-only");
    expect(html).toContain("right-click");
    expect(html).toContain("Long-press");
  });
});
