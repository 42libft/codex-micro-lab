import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAllowedPairingHost, MicroBridge } from "./bridge.js";
import QRCode from "qrcode";

export interface PairingPayload {
  version: 1;
  token: string;
  hosts: string[];
  port: number;
}

export function createPairingUrl(bridge: MicroBridge, hosts = bridge.getAdvertiseHosts()): string {
  const payload = validatePairingPayload({ version: 1, token: bridge.token, hosts, port: bridge.port });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `codexmicro://pair#${encoded}`;
}

export function parsePairingUrl(value: string): PairingPayload {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Pairing QR is not a valid URL"); }
  if (url.protocol !== "codexmicro:" || url.hostname !== "pair" || url.pathname !== "" || url.search || url.username || url.password || url.port) throw new Error("Only codexmicro://pair QR codes are accepted");
  const fragment = url.hash.slice(1);
  if (!fragment || !/^[A-Za-z0-9_-]+$/.test(fragment)) throw new Error("Pairing QR payload is missing or malformed");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")); } catch { throw new Error("Pairing QR payload is malformed"); }
  return validatePairingPayload(decoded);
}

export async function serveWebController(bridge: MicroBridge, port = 0): Promise<{ port: number; origin: string; close(): Promise<void> }> {
  const html = readFileSync(join(process.cwd(), "web", "index.html"));
  let expectedHost: string | null = null;
  const http = createServer((request, response) => {
    if (expectedHost === null || request.headers.host !== expectedHost) {
      response.writeHead(421, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
      response.end("Loopback Host required");
      return;
    }
    const path = request.url?.split("?")[0];
    if (path === "/pairing.svg") {
      let pairingUrl: string;
      try { pairingUrl = createPairingUrl(bridge); } catch (error) {
        response.writeHead(503, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
        response.end(error instanceof Error ? error.message : "No private LAN address is available");
        return;
      }
      const svg = QRCode.toString(pairingUrl, { type: "svg", margin: 1 });
      void svg.then((value) => { response.writeHead(200, securityHeaders({ "content-type": "image/svg+xml" })); response.end(value); }).catch(() => { response.writeHead(500, securityHeaders()); response.end(); });
      return;
    }
    if (path === "/bootstrap") {
      response.writeHead(200, securityHeaders({ "content-type": "application/json; charset=utf-8" }));
      response.end(JSON.stringify({ version: 1, token: bridge.token, bridgePort: bridge.port }));
      return;
    }
    if (path !== "/") { response.writeHead(404, securityHeaders()); response.end(); return; }
    response.writeHead(200, securityHeaders({ "content-type": "text/html; charset=utf-8" }));
    response.end(html);
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  expectedHost = `127.0.0.1:${actualPort}`;
  const origin = `http://127.0.0.1:${actualPort}`;
  bridge.allowWebControllerOrigin(origin);
  return {
    port: actualPort,
    origin,
    close: () => new Promise((resolve) => {
      bridge.revokeWebControllerOrigin(origin);
      http.close(() => resolve());
    }),
  };
}

function validatePairingPayload(value: unknown): PairingPayload {
  if (!value || typeof value !== "object") throw new Error("Pairing QR payload must be an object");
  const payload = value as Partial<PairingPayload>;
  if (payload.version !== 1) throw new Error("Unsupported pairing QR version");
  if (typeof payload.token !== "string" || !/^[0-9a-f]{32}$/i.test(payload.token)) throw new Error("Pairing token must be exactly 32 hexadecimal characters");
  if (!Number.isInteger(payload.port) || (payload.port as number) < 1024 || (payload.port as number) > 65535) throw new Error("Pairing port is outside the allowed range");
  if (!Array.isArray(payload.hosts) || payload.hosts.length < 1 || payload.hosts.length > 8 || payload.hosts.some((host) => typeof host !== "string" || !isAllowedPairingHost(host))) throw new Error("Pairing hosts must be allowlisted non-global IPv4 addresses");
  return { version: 1, token: payload.token.toLowerCase(), hosts: [...new Set(payload.hosts)], port: payload.port as number };
}

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}
