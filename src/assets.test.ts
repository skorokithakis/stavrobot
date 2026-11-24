import http from "http";
import { describe, expect, it } from "vitest";
import { serveFontFile } from "./assets.js";
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
