import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { isAllowedWebSocketPeer, MicroBridge } from "../src/bridge.js";
import type { BridgeReply } from "../src/types.js";
import { createPairingUrl, parsePairingUrl, serveWebController } from "../src/web.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PRIVATE_HOSTS = ["192.168.10.2", "169.254.10.20", "10.123.45.67"];

class TestBridge extends MicroBridge {
  override getAdvertiseHosts(): string[] { return PRIVATE_HOSTS; }
}

function waitFor<T>(items: T[], predicate: (item: T) => boolean, timeout = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const item = items.find(predicate);
      if (item) { clearInterval(timer); resolve(item); }
      else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error("timed out")); }
    }, 10);
  });
}

test("pairing QR uses a strict fragment payload with allowlisted hosts", () => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-pairing-test-")), "bridge.sock"), port: 47831, token: TOKEN });
  const value = createPairingUrl(bridge, PRIVATE_HOSTS);
  const parsedUrl = new URL(value);
  assert.equal(parsedUrl.href.startsWith("codexmicro://pair#"), true);
  assert.equal(parsedUrl.search, "");
  assert.equal(value.includes(TOKEN), false);
  assert.deepEqual(parsePairingUrl(value), { version: 1, token: TOKEN, port: 47831, hosts: PRIVATE_HOSTS });
});

test("pairing QR rejects raw tokens, arbitrary URLs, public hosts, and invalid ports", () => {
  assert.throws(() => parsePairingUrl(TOKEN), /valid URL/);
  assert.throws(() => parsePairingUrl("https://example.com/pair"), /Only codexmicro/);
  const encode = (value: unknown) => `codexmicro://pair#${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  assert.throws(() => parsePairingUrl(encode({ version: 1, token: TOKEN, hosts: ["8.8.8.8"], port: 47831 })), /allowlisted non-global/);
  assert.throws(() => parsePairingUrl(encode({ version: 1, token: TOKEN, hosts: ["192.168.1.2"], port: 80 })), /allowed range/);
  assert.throws(() => parsePairingUrl(`codexmicro://pair?token=${TOKEN}`), /Only codexmicro/);
});

test("WebSocket peer allowlist excludes public and unrelated IPv6 addresses", () => {
  assert.equal(isAllowedWebSocketPeer("127.0.0.1"), true);
  assert.equal(isAllowedWebSocketPeer("::ffff:192.168.1.20"), true);
  assert.equal(isAllowedWebSocketPeer("172.20.10.1"), true);
  assert.equal(isAllowedWebSocketPeer("10.123.45.67"), true);
  assert.equal(isAllowedWebSocketPeer("192.0.0.9"), false);
  assert.equal(isAllowedWebSocketPeer("8.8.8.8"), false);
  assert.equal(isAllowedWebSocketPeer("2001:4860:4860::8888"), false);
});

test("web controller bootstraps without URL secrets and authenticates with its exact origin", async (t) => {
  const bridge = new TestBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-web-test-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  const web = await serveWebController(bridge);
  t.after(async () => { await web.close(); await bridge.stop(); });

  const response = await fetch(`${web.origin}/pairing.svg`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /<svg/);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const page = await (await fetch(`${web.origin}/`)).text();
  assert.match(page, /fromPacked/);
  assert.match(page, /ambient-light/);
  assert.match(page, /Micro controller/);
  assert.match(page, /setAttribute\('data-state', 'released'\)/);
  assert.match(page, /押下中/);
  assert.match(page, /setControlsEnabled/);
  assert.equal(page.includes(TOKEN), false);
  assert.doesNotMatch(page, /copy-token|URLSearchParams\(location\.search\)/);

  const bootstrapResponse = await fetch(`${web.origin}/bootstrap`);
  const bootstrap = await bootstrapResponse.json() as { version: number; token: string; bridgePort: number };
  assert.deepEqual(bootstrap, { version: 1, token: TOKEN, bridgePort: bridge.port });
  assert.equal(bootstrapResponse.headers.get("referrer-policy"), "no-referrer");

  const rebound = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const requestWithBadHost = request(`${web.origin}/bootstrap`, { headers: { host: "attacker.example" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    requestWithBadHost.on("error", reject);
    requestWithBadHost.end();
  });
  assert.equal(rebound.status, 421);
  assert.equal(rebound.body.includes(TOKEN), false);

  const messages: BridgeReply[] = [];
  const controller = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: web.origin });
  controller.on("message", (data) => messages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => controller.once("open", resolve));
  controller.send(JSON.stringify({ version: 1, type: "hello", role: "web", token: bootstrap.token }));
  await waitFor(messages, (reply) => reply.type === "hello.ok");
  controller.close();

  const rejectedMessages: BridgeReply[] = [];
  const rejected = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: "https://attacker.example" });
  rejected.on("message", (data) => rejectedMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => rejected.once("open", resolve));
  rejected.send(JSON.stringify({ version: 1, type: "hello", role: "web", token: bootstrap.token }));
  const error = await waitFor(rejectedMessages, (reply) => reply.type === "error");
  assert.match(error.type === "error" ? error.message : "", /origin rejected/);
  assert.equal(rejectedMessages.some((reply) => reply.type === "hello.ok"), false);
  rejected.close();
});
