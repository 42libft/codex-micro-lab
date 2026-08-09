import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { WebSocket } from "ws";
import { patchFeatureGate, patchLayoutBundle, patchRendererBundle } from "../src/lab-patch.js";
import { createHash } from "node:crypto";
import { MicroBridge } from "../src/bridge.js";
import { wrapperSource } from "../src/lab-patch.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("Feature Gate patch uses AST call matching and preserves unrelated literals", () => {
  const root = mkdtempSync(join(tmpdir(), "micro-gate-"));
  const file = join(root, "bundle.js");
  writeFileSync(file, [
    "const enabled = featureGate(`3207467860`);",
    "const unrelated = `3207467860`;",
    "const other = featureGate('3207467860');",
  ].join("\n"));
  assert.equal(patchFeatureGate(root, "3207467860", 1), 1);
  const output = readFileSync(file, "utf8");
  assert.match(output, /const enabled = true;/);
  assert.match(output, /const unrelated = `3207467860`;/);
  assert.match(output, /featureGate\('3207467860'\)/);
});

test("Feature Gate patch refuses an unexpected occurrence count", () => {
  const root = mkdtempSync(join(tmpdir(), "micro-gate-count-"));
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "bundle.js"), "const enabled = featureGate(`3207467860`);\n");
  assert.throws(() => patchFeatureGate(root, "3207467860", 2), /Expected 2 Feature Gate calls, found 1/);
});

test("renderer patch is hash- and anchor-guarded", () => {
  const root = mkdtempSync(join(tmpdir(), "micro-renderer-patch-"));
  const file = join(root, "renderer.js");
  const source = "const root = true;export{qt as CodexMicroBridge};//# sourceMappingURL=renderer.js.map";
  writeFileSync(file, source);
  const hash = createHash("sha256").update(source).digest("hex");
  patchRendererBundle(root, "renderer.js", hash);
  assert.match(readFileSync(file, "utf8"), /CODEX_MICRO_LAB_RENDERER_OBSERVER/);
  assert.throws(() => patchRendererBundle(root, "renderer.js", hash), /hash mismatch/);
});

test("Micro settings layout observer is hash- and anchor-guarded", () => {
  const root = mkdtempSync(join(tmpdir(), "micro-layout-patch-"));
  const file = join(root, "settings.js");
  const source = "const state = 1;t[0]===v?w=t[1]:(w=fn(v),t[0]=v,t[1]=w);export{};";
  writeFileSync(file, source);
  const hash = createHash("sha256").update(source).digest("hex");
  patchLayoutBundle(root, "settings.js", hash);
  assert.match(readFileSync(file, "utf8"), /CODEX_MICRO_LAB_LAYOUT_OBSERVER/);
  const patchedHash = createHash("sha256").update(readFileSync(file)).digest("hex");
  assert.throws(() => patchLayoutBundle(root, "settings.js", patchedHash), /already contains/);
});

test("Lab transport wrapper performs descriptor discovery and RPC round trip", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-lab-wrapper-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const controller = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const controllerMessages: Array<Record<string, any>> = [];
  controller.on("message", (data) => controllerMessages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve) => controller.once("open", resolve));
  controller.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const moduleObject = { exports: {} as Record<string, unknown> };
  const realRequire = createRequire(import.meta.url);
  const hostMessages: Array<{ channel: string; message: Record<string, unknown> }> = [];
  const electronMock = {
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, message: Record<string, unknown>) => hostMessages.push({ channel, message }),
        executeJavaScript: async (script: string) => {
          if (script.includes("__CODEX_MICRO_LAB_LAYOUT__")) {
            return {
              agentSource: null,
              actionKeys: { ACT06: "承認", ACT10: "音声入力" },
              analogStick: { up: "新しいチャット", right: "送信", down: null, left: null },
              encoderMode: "reasoning",
              encoder: { left: "推論を浅く", click: null, right: "推論を深く", longPress: null },
              microphoneMode: "push-to-talk",
              separateMicrophoneKeys: false,
            };
          }
          if (script.includes("data-reasoning-slider")) return { displayName: null, current: null, choices: null, available: false };
          return { agentSource: null, actionKeys: {}, analogStick: { up: null, right: null, down: null, left: null }, encoderMode: null, encoder: { left: null, click: null, right: null, longPress: null }, microphoneMode: null, separateMicrophoneKeys: null };
        },
        },
      }],
    },
  };
  class MockCodexMicroService {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) { this.options = options; }
  }
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    process: { env: { ...process.env, CODEX_MICRO_BRIDGE_SOCKET: bridge.socketPath, CODEX_MICRO_RPC_TIMEOUT_MS: "40" } },
    require: (specifier: string) => specifier.endsWith("service-CJETEjOt.js.original.js") ? { CodexMicroService: MockCodexMicroService } : specifier === "electron" ? electronMock : realRequire(specifier),
    console,
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
  });
  vm.runInContext(wrapperSource(), context, { filename: "service-CJETEjOt.js" });
  const Service = moduleObject.exports.CodexMicroService as new (options: Record<string, unknown>) => { options: Record<string, any> };
  const service = new Service({});
  service.options.onDeviceStateChanged?.({ status: "connected", transport: "bluetooth", model: "codex-micro", error: null });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(controllerMessages.some((message) => message.type === "codex.state" && message.snapshot?.status === "connected" && message.snapshot?.transport === "bluetooth"), true);
  assert.equal(controllerMessages.some((message) => message.type === "layout.snapshot" || message.type === "reasoning.snapshot"), false);
  const devices = await service.options.findDevices() as Array<Record<string, unknown>>;
  assert.equal(devices[0]?.devicePid, "33632");
  assert.equal(devices[0]?.deviceType, "codex_micro");
  assert.equal(devices[0]?.connectionType, 1);
  const comm = (service.options.createComm as () => any)();
  const events: Array<Record<string, unknown>> = [];
  comm.onConnectionEvent((event: Record<string, unknown>) => events.push(event));
  await comm.connect();
  const raw = await comm.sendJsonRpcRequest(JSON.stringify({ method: "device.status", params: {}, id: 42 }), 42) as string;
  assert.equal(JSON.parse(raw).id, 42);
  assert.equal(JSON.parse(raw).result.version, "0.4.1-iphone-poc");
  const oldSocket = comm.socket;
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.send(JSON.stringify({ version: 1, type: "input.text", input: { text: "hello from iPhone", eventId: "text-event-1" } }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const hostMessage = hostMessages.find((entry) => entry.channel === "codex_desktop:message-for-view")?.message;
  assert.equal(hostMessage?.type, "codex-micro-insert-composer-text");
  assert.equal(hostMessage?.text, "hello from iPhone");
  await comm.disconnect();
  await comm.connect();
  // Simulate the delayed close callback that URL/Unix transports can deliver
  // after a reconnect. It must not make the new transport look disconnected.
  oldSocket.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.map((event) => event.type), [0, 1, 0]);
  await comm.disconnect();
  assert.deepEqual(events.map((event) => event.type), [0, 1, 0, 1]);
  const timeoutComm = (service.options.createComm as () => any)();
  await timeoutComm.connect();
  timeoutComm.send = () => true;
  await assert.rejects(timeoutComm.sendJsonRpcRequest(JSON.stringify({ method: "device.status", params: {}, id: "timeout" }), "timeout"), /RPC timeout/);
  await timeoutComm.disconnect();
  controller.close();
});
