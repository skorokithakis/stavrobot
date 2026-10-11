import http from "http";
import { describe, expect, it } from "vitest";
import { serveFontFile, serveSharedStylesheet } from "./assets.js";
import { isPublicRoute } from "./index.js";

interface MockResponse {
  statusCode: number | undefined;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Buffer): void;
}

function makeMockResponse(): MockResponse {
  return {
    statusCode: undefined,
    headers: {},
    body: undefined,
    writeHead(status: number, headers?: Record<string, string>): void {
      this.statusCode = status;
      if (headers !== undefined) {
        Object.assign(this.headers, headers);
      }
    },
    end(body?: string | Buffer): void {
      this.body = body;
    },
  };
}

describe("serveSharedStylesheet", (): void => {
  it("serves the shared stylesheet as CSS", (): void => {
    const response = makeMockResponse();

    serveSharedStylesheet(response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/css; charset=utf-8");
    const body = response.body as string;
    expect(body).toContain(".sb-sidebar");
    expect(body).toContain(".sb-tabbar");
    expect(body).toContain(".sb-m-header");
    expect(body).toContain("prefers-color-scheme: dark");
    expect(body).toContain("@media (max-width:768px)");
  });

  it("references the self-hosted latin fonts and drops mockup state hooks", (): void => {
    const response = makeMockResponse();

    serveSharedStylesheet(response as unknown as http.ServerResponse);

    const body = response.body as string;
    expect(body).toContain(
      "url(/assets/fonts/ibm-plex-sans-latin-400-normal.woff2)",
    );
    expect(body).toContain(
      "url(/assets/fonts/ibm-plex-mono-latin-500-normal.woff2)",
    );
    expect(body).not.toContain(".is-hover");
    expect(body).not.toContain(".is-focus");
    expect(body).not.toContain(".sb-tabbar.is-static");
  });
});

describe("serveFontFile", (): void => {
  it("serves a known font file with the woff2 content type", (): void => {
    const response = makeMockResponse();

    serveFontFile(
      response as unknown as http.ServerResponse,
      "ibm-plex-sans-latin-400-normal.woff2",
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("font/woff2");
    const body = response.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body.subarray(0, 4).toString("ascii")).toBe("wOF2");
  });

  it("returns 404 for an unknown font file", (): void => {
    const response = makeMockResponse();

    serveFontFile(
      response as unknown as http.ServerResponse,
      "../../../etc/passwd",
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body as string).error).toBeTruthy();
  });
});

describe("isPublicRoute — assets", (): void => {
  it("requires auth for the stylesheet and fonts", (): void => {
    expect(isPublicRoute("GET", "/assets/sb.css")).toBe(false);
    expect(
      isPublicRoute("GET", "/assets/fonts/ibm-plex-sans-latin-400-normal.woff2"),
    ).toBe(false);
  });
});
