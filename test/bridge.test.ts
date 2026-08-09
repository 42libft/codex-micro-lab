import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { MicroBridge, connectUnix } from "../src/bridge.js";
import type { BridgeReply } from "../src/types.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

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

test("bridge exposes virtual device only while a controller is connected", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-test-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const replies: BridgeReply[] = [];
  const codex = await connectUnix(bridge.socketPath, (reply) => replies.push(reply));
  codex.send({ version: 1, type: "hello", role: "codex-shim" });
  codex.send({ version: 1, type: "device.list", requestId: "empty" });
  const empty = await waitFor(replies, (reply) => reply.type === "device.list.result" && reply.requestId === "empty") as Extract<BridgeReply, { type: "device.list.result" }>;
  assert.equal(empty.devices.length, 0);
  const controller = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const controllerMessages: BridgeReply[] = [];
  controller.on("message", (data) => controllerMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => controller.once("open", () => resolve()));
  controller.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(controllerMessages, (reply) => reply.type === "hello.ok");
  codex.send({ version: 1, type: "device.list", requestId: "available" });
  const available = await waitFor(replies, (reply) => reply.type === "device.list.result" && reply.requestId === "available") as Extract<BridgeReply, { type: "device.list.result" }>;
  assert.equal(available.devices[0]?.devicePid, "33632");
  assert.equal(available.devices[0]?.deviceType, "codex_micro");
  assert.equal(available.devices[0]?.connectionType, 1);
  codex.send({ version: 1, type: "topology.subscribe" });
  codex.send({ version: 1, type: "rpc.request", requestId: "status", raw: JSON.stringify({ method: "device.status", params: {}, id: 4 }) });
  const status = await waitFor(replies, (reply) => reply.type === "rpc.response" && reply.requestId === "status") as Extract<BridgeReply, { type: "rpc.response" }>;
  assert.equal(JSON.parse(status.raw).result.version, "0.4.1-iphone-poc");
  const statusCount = () => replies.filter((reply) => reply.type === "rpc.response" && reply.requestId === "status").length;
  codex.send({ version: 1, type: "rpc.request", requestId: "status", raw: JSON.stringify({ method: "device.status", params: {}, id: 4 }) });
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (statusCount() >= 2) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 1000) { clearInterval(timer); reject(new Error("duplicate RPC response timed out")); }
    }, 10);
  });
  codex.send({ version: 1, type: "rpc.request", requestId: "lighting", raw: JSON.stringify({ method: "v.oai.rgbcfg", params: { keys: { c: 1 }, ambient: { c: 2 } }, id: 5 }) });
  const lighting = await waitFor(replies, (reply) => reply.type === "rpc.response" && reply.requestId === "lighting") as Extract<BridgeReply, { type: "rpc.response" }>;
  assert.equal(JSON.parse(lighting.raw).result, true);
  assert.deepEqual(bridge.getLighting(), { keys: { c: 1 }, ambient: { c: 2 }, threads: [] });
  controller.send(JSON.stringify({ version: 1, type: "input.hid", input: { key: "AG00", act: 1 } }));
  const input = await waitFor(replies, (reply) => reply.type === "rpc.notification") as Extract<BridgeReply, { type: "rpc.notification" }>;
  assert.deepEqual(JSON.parse(input.raw).params, { k: "AG00", act: 1 });
  controller.send(JSON.stringify({ version: 1, type: "heartbeat", nonce: "n1" }));
  const heartbeat = await waitFor(controllerMessages, (reply) => reply.type === "heartbeat.ok") as Extract<BridgeReply, { type: "heartbeat.ok" }>;
  assert.equal(heartbeat.nonce, "n1");
  controller.close();
  codex.close();
});

test("websocket pairing token is required", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-auth-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const rejected = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const replies: BridgeReply[] = [];
  rejected.on("message", (data) => replies.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => rejected.once("open", resolve));
  rejected.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: "wrong" }));
  const error = await waitFor(replies, (reply) => reply.type === "error");
  assert.match(error.type === "error" ? error.message : "", /Pairing token/);
  rejected.close();
});

test("telemetry is reflected by device.status and heartbeat expiry removes the device", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-expiry-")), "bridge.sock"), port: 0, token: TOKEN, heartbeatTimeoutMs: 40 });
  await bridge.start();
  t.after(() => bridge.stop());
  const replies: BridgeReply[] = [];
  const codex = await connectUnix(bridge.socketPath, (reply) => replies.push(reply));
  const controller = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const controllerMessages: BridgeReply[] = [];
  controller.on("message", (data) => controllerMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => controller.once("open", resolve));
  controller.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(controllerMessages, (reply) => reply.type === "hello.ok");
  controller.send(JSON.stringify({ version: 1, type: "device.telemetry", telemetry: { batteryPercentage: 75, isCharging: true } }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  codex.send({ version: 1, type: "rpc.request", requestId: "telemetry", raw: JSON.stringify({ method: "device.status", params: {}, id: "telemetry" }) });
  const status = await waitFor(replies, (reply) => reply.type === "rpc.response" && reply.requestId === "telemetry") as Extract<BridgeReply, { type: "rpc.response" }>;
  assert.equal(JSON.parse(status.raw).result.battery, 75);
  assert.equal(JSON.parse(status.raw).result.is_charging, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  codex.send({ version: 1, type: "device.list", requestId: "expired" });
  const expired = await waitFor(replies, (reply) => reply.type === "device.list.result" && reply.requestId === "expired") as Extract<BridgeReply, { type: "device.list.result" }>;
  assert.deepEqual(expired.devices, []);
  controller.close();
  codex.close();
});

test("a second iPhone replaces the first active controller", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-single-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const first = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const second = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const firstMessages: BridgeReply[] = [];
  const secondMessages: BridgeReply[] = [];
  first.on("message", (data) => firstMessages.push(JSON.parse(data.toString()) as BridgeReply));
  second.on("message", (data) => secondMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await Promise.all([
    new Promise<void>((resolve) => first.once("open", resolve)),
    new Promise<void>((resolve) => second.once("open", resolve)),
  ]);
  first.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(firstMessages, (reply) => reply.type === "hello.ok");
  second.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(secondMessages, (reply) => reply.type === "hello.ok");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(first.readyState, WebSocket.CLOSED);
  assert.equal(second.readyState, WebSocket.OPEN);
  first.close();
  second.close();
});

test("bridge rejects invalid remote input instead of forwarding it", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-input-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const replies: BridgeReply[] = [];
  socket.on("message", (data) => replies.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(replies, (reply) => reply.type === "hello.ok");
  socket.send("not-json");
  const jsonError = await waitFor(replies, (reply) => reply.type === "error" && /JSON|Unexpected/.test(reply.message));
  assert.equal(jsonError.type, "error");
  socket.send(JSON.stringify({ version: 1, type: "input.hid", input: { key: "AG00", act: 9 } }));
  const error = await waitFor(replies, (reply) => reply.type === "error" && /Invalid HID input/.test(reply.message));
  assert.match(error.type === "error" ? error.message : "", /Invalid HID input/);
  socket.close();
});

test("controller input is unavailable without Codex and local roles cannot spoof it", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-boundary-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());

  const phone = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const phoneMessages: BridgeReply[] = [];
  phone.on("message", (data) => phoneMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => phone.once("open", resolve));
  phone.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(phoneMessages, (reply) => reply.type === "hello.ok");
  phone.send(JSON.stringify({ version: 1, type: "rpc.request", requestId: "forbidden", raw: "{}" }));
  const protectedError = await waitFor(phoneMessages, (reply) => reply.type === "error" && /protected Unix/.test(reply.message));
  assert.match(protectedError.type === "error" ? protectedError.message : "", /protected Unix/);
  phone.send(JSON.stringify({ version: 1, type: "input.hid", input: { key: "AG00", act: 1, eventId: "offline-event" } }));
  const unavailable = await waitFor(phoneMessages, (reply) => reply.type === "input.ack" && reply.ack.eventId === "offline-event") as Extract<BridgeReply, { type: "input.ack" }>;
  assert.equal(unavailable.ack.state, "unavailable");

  const codexReplies: BridgeReply[] = [];
  const codex = await connectUnix(bridge.socketPath, (reply) => codexReplies.push(reply));
  codex.send({ version: 1, type: "hello", role: "codex-shim" });
  codex.send({ version: 1, type: "input.hid", input: { key: "AG00", act: 1 } });
  const spoofError = await waitFor(codexReplies, (reply) => reply.type === "error");
  assert.match(spoofError.type === "error" ? spoofError.message : "", /Only iPhone or web/);

  const rendererReplies: BridgeReply[] = [];
  const renderer = await connectUnix(bridge.socketPath, (reply) => rendererReplies.push(reply));
  renderer.send({ version: 1, type: "hello", role: "codex-renderer" });
  renderer.send({ version: 1, type: "codex.semantic", event: "agent.snapshot", payload: { slot: 0, status: "not-a-status", selected: true, rgb: 1 } as never });
  const stateError = await waitFor(rendererReplies, (reply) => reply.type === "error");
  assert.match(stateError.type === "error" ? stateError.message : "", /Invalid agent snapshot/);

  phone.close(); codex.close(); renderer.close();
});

test("starting a second bridge refuses the live socket instead of disconnecting the first", async (t) => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "micro-bridge-singleton-")), "bridge.sock");
  const first = new MicroBridge({ socketPath, port: 0, token: TOKEN });
  await first.start();
  t.after(() => first.stop());
  const second = new MicroBridge({ socketPath, port: 0, token: "fedcba9876543210fedcba9876543210" });
  await assert.rejects(second.start(), /already running/);
  const codex = await connectUnix(socketPath, () => {});
  codex.send({ version: 1, type: "hello", role: "codex-shim" });
  codex.close();
});

test("closing one overlapping Codex transport does not drop the remaining connection", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-overlap-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const observer = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const observerMessages: BridgeReply[] = [];
  observer.on("message", (data) => observerMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => observer.once("open", resolve));
  observer.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(observerMessages, (reply) => reply.type === "hello.ok");
  const first = await connectUnix(bridge.socketPath, () => {});
  const second = await connectUnix(bridge.socketPath, () => {});
  first.send({ version: 1, type: "hello", role: "codex-shim" });
  second.send({ version: 1, type: "hello", role: "codex-shim" });
  await waitFor(observerMessages, (reply) => reply.type === "codex.state" && reply.snapshot.status === "connected");
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(bridge.isCodexConnected(), true);
  assert.equal(bridge.getCodexState().status, "connected");
  second.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(bridge.getCodexState().status, "not-detected");
  observer.close();
});

test("Unix renderer publishes sanitized semantic state and receives input acknowledgements", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-semantic-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const codexReplies: BridgeReply[] = [];
  const codex = await connectUnix(bridge.socketPath, (reply) => codexReplies.push(reply));
  codex.send({ version: 1, type: "hello", role: "codex-shim" });
  const rendererMessages: BridgeReply[] = [];
  const renderer = await connectUnix(bridge.socketPath, (reply) => rendererMessages.push(reply));
  renderer.send({ version: 1, type: "hello", role: "codex-renderer" });
  await waitFor(rendererMessages, (reply) => reply.type === "hello.ok");
  const phone = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const phoneMessages: BridgeReply[] = [];
  phone.on("message", (data) => phoneMessages.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => phone.once("open", resolve));
  phone.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(phoneMessages, (reply) => reply.type === "hello.ok");
  renderer.send({ version: 1, type: "codex.semantic", event: "agent.snapshot", payload: { slot: 0, title: "private title", status: "working", selected: true, rgb: 16711680, assignmentKind: "skill", threadKey: "private-thread-key" } as never });
  const agent = await waitFor(phoneMessages, (reply) => reply.type === "agent.snapshot") as Extract<BridgeReply, { type: "agent.snapshot" }>;
  assert.deepEqual(agent.snapshot, { slot: 0, status: "working", selected: true, rgb: 16711680 });
  renderer.send({ version: 1, type: "codex.semantic", event: "layout.snapshot", payload: { agentSource: null, actionKeys: { ACT06: "private command" }, analogStick: { up: null, right: null, down: null, left: null }, encoderMode: null, encoder: { left: null, click: null, right: null, longPress: null }, microphoneMode: null, separateMicrophoneKeys: null } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(phoneMessages.some((reply) => (reply as { type: string }).type === "layout.snapshot"), false);
  phone.send(JSON.stringify({ version: 1, type: "input.hid", input: { key: "AG00", act: 1, eventId: "event-1" } }));
  const accepted = await waitFor(phoneMessages, (reply) => reply.type === "input.ack" && reply.ack.eventId === "event-1") as Extract<BridgeReply, { type: "input.ack" }>;
  assert.equal(accepted.ack.state, "bridge-accepted");
  phone.send(JSON.stringify({ version: 1, type: "input.hid", input: { key: "AG00", act: 1, eventId: "event-1" } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(codexReplies.filter((reply) => reply.type === "rpc.notification").length, 1);
  renderer.send({ version: 1, type: "codex.semantic", event: "input.ack", payload: { eventId: "event-1", state: "codex-delivered", inputType: "hid", key: "AG00" } });
  const delivered = await waitFor(phoneMessages, (reply) => reply.type === "input.ack" && reply.ack.state === "codex-delivered") as Extract<BridgeReply, { type: "input.ack" }>;
  assert.equal(delivered.ack.eventId, "event-1");

  phone.close();
  const reconnected = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const replayed: BridgeReply[] = [];
  reconnected.on("message", (data) => replayed.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => reconnected.once("open", resolve));
  reconnected.send(JSON.stringify({ version: 1, type: "hello", role: "iphone", token: TOKEN }));
  await waitFor(replayed, (reply) => reply.type === "hello.ok");
  const replayedAgent = await waitFor(replayed, (reply) => reply.type === "agent.snapshot") as Extract<BridgeReply, { type: "agent.snapshot" }>;
  assert.deepEqual(replayedAgent.snapshot, { slot: 0, status: "working", selected: true, rgb: 16711680 });
  reconnected.close();
  renderer.close(); codex.close();
});

test("renderer WebSocket is rejected even from loopback with the pairing token", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-renderer-reject-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  const renderer = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const replies: BridgeReply[] = [];
  renderer.on("message", (data) => replies.push(JSON.parse(data.toString()) as BridgeReply));
  await new Promise<void>((resolve) => renderer.once("open", resolve));
  renderer.send(JSON.stringify({ version: 1, type: "hello", role: "codex-renderer", token: TOKEN }));
  const error = await waitFor(replies, (reply) => reply.type === "error");
  assert.match(error.type === "error" ? error.message : "", /protected Unix socket/);
  assert.equal(replies.some((reply) => reply.type === "hello.ok"), false);
  renderer.close();
});

test("local transport socket is owner-only", async (t) => {
  const bridge = new MicroBridge({ socketPath: join(mkdtempSync(join(tmpdir(), "micro-bridge-mode-")), "bridge.sock"), port: 0, token: TOKEN });
  await bridge.start();
  t.after(() => bridge.stop());
  assert.equal(statSync(bridge.socketPath).mode & 0o777, 0o600);
});
