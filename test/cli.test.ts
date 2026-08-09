import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { BridgeReply } from "../src/types.js";

function waitFor<T>(read: () => T | undefined, timeout = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const value = read();
      if (value !== undefined) { clearInterval(timer); resolve(value); }
      else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error("timed out")); }
    }, 20);
  });
}

test("microctl start exposes a usable local controller without printing its bearer token", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "micro-cli-e2e-"));
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "src", "cli.js"), "start"], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_MICRO_LAB_DATA_DIR: dataDir, CODEX_MICRO_BRIDGE_PORT: "0", CODEX_MICRO_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  });

  const origin = await waitFor(() => stdout.match(/Web controller: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1]);
  const bootstrap = await (await fetch(`${origin}bootstrap`)).json() as { token: string; bridgePort: number };
  assert.match(bootstrap.token, /^[0-9a-f]{32}$/);
  assert.equal(stdout.includes(bootstrap.token), false);
  assert.doesNotMatch(stdout, /Pairing token:|\?token=/i);
  assert.equal(statSync(join(dataDir, "pairing-token")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, "bridge-web.json")).mode & 0o777, 0o600);

  const replies: BridgeReply[] = [];
  const controller = new WebSocket(`ws://127.0.0.1:${bootstrap.bridgePort}`, { origin: origin.slice(0, -1) });
  controller.on("message", (data) => replies.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => controller.once("open", resolve));
  controller.send(JSON.stringify({ version: 1, type: "hello", role: "web", token: bootstrap.token }));
  await waitFor(() => replies.find((reply) => reply.type === "hello.ok"));
  controller.close();

  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM" ? resolve() : reject(new Error(`microctl exited ${code}: ${stderr}`)));
  });
});
