import fs from "fs";
import http from "http";
import { createRequire } from "module";
import { SHARED_STYLES } from "./sb-css.js";
import { log } from "./log.js";

const require = createRequire(import.meta.url);

// The font files are resolved from the installed @fontsource packages so the
// production Docker image only needs the normal dependency install. Only the
// latin subsets and the weights the design uses are shipped.
const FONT_PACKAGE_PATHS: Record<string, string> = {
  "ibm-plex-sans-latin-400-normal.woff2":
    "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
  "ibm-plex-sans-latin-500-normal.woff2":
    "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2",
  "ibm-plex-sans-latin-600-normal.woff2":
    "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
  "ibm-plex-mono-latin-400-normal.woff2":
    "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
  "ibm-plex-mono-latin-500-normal.woff2":
    "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
};

function loadFontFiles(): Map<string, Buffer> {
  const fontFiles = new Map<string, Buffer>();
  for (const [fileName, packagePath] of Object.entries(FONT_PACKAGE_PATHS)) {
    const resolvedPath = require.resolve(packagePath);
    fontFiles.set(fileName, fs.readFileSync(resolvedPath));
    log.debug("[stavrobot] assets: loaded font", fileName);
  }
  return fontFiles;
}

const fontFiles = loadFontFiles();

export function serveSharedStylesheet(response: http.ServerResponse): void {
  log.debug("[stavrobot] assets: serving shared stylesheet");
  response.writeHead(200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  response.end(SHARED_STYLES);
}

export function serveFontFile(response: http.ServerResponse, fileName: string): void {
  const data = fontFiles.get(fileName);
  if (data === undefined) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  log.debug("[stavrobot] assets: serving font", fileName);
  response.writeHead(200, {
    "Content-Type": "font/woff2",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  response.end(data);
}
