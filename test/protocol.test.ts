import test from "node:test";
import assert from "node:assert/strict";
import { decodeHidFrame, encodeHidPayload, handleDeviceRpc, parseRpcRequest, VENDOR_METHODS } from "../src/protocol.js";

test("Codex Micro HID framing uses report id 6 and channel 2", () => {
  const payload = "x".repeat(140);
  const frames = encodeHidPayload(payload);
  assert.equal(frames.length, 3);
  assert.equal(frames[0][0], 6);
  assert.equal(frames[0][1], 2);
  assert.equal(decodeHidFrame(frames[0]).payload.length, 61);
  assert.equal(decodeHidFrame(frames[2]).payload.length, 18);
  assert.equal(decodeHidFrame(frames[0]).channel, 2);
  const wrongChannel = Buffer.from(frames[0]);
  wrongChannel[1] = 3;
  assert.throws(() => decodeHidFrame(wrongChannel), /Unexpected RPC channel/);
});

test("vendor RPC status and lighting are handled without jsonrpc field", () => {
  const calls: Array<[string, unknown]> = [];
  const result = handleDeviceRpc(JSON.stringify({ method: VENDOR_METHODS.status, params: {}, id: 7 }), { batteryPercentage: 83, isCharging: true }, (method, params) => calls.push([method, params]));
  assert.deepEqual(JSON.parse(result.response), { id: 7, result: { version: "0.4.1-iphone-poc", profile_index: 0, layer_index: 0, battery: 83, is_charging: true } });
  const lighting = handleDeviceRpc(JSON.stringify({ method: VENDOR_METHODS.rgb, params: { keys: { c: 1 } }, id: "a" }), {}, (method, params) => calls.push([method, params]));
  assert.deepEqual(JSON.parse(lighting.response), { id: "a", result: true });
  assert.equal(calls[0][0], VENDOR_METHODS.rgb);
});

test("malformed RPC is rejected", () => {
  assert.throws(() => parseRpcRequest("{}"), /method/);
});

test("unknown RPC methods return the request id and JSON-RPC method error", () => {
  const first = handleDeviceRpc(JSON.stringify({ method: "future.method", params: {}, id: "duplicate-id" }), {}, () => undefined);
  const second = handleDeviceRpc(JSON.stringify({ method: "future.method", params: {}, id: "duplicate-id" }), {}, () => undefined);
  assert.deepEqual(JSON.parse(first.response), { id: "duplicate-id", error: { code: -32601, message: "Method not found: future.method" } });
  assert.deepEqual(JSON.parse(second.response), JSON.parse(first.response));
});

test("device status omits unavailable battery fields", () => {
  const result = handleDeviceRpc(JSON.stringify({ method: VENDOR_METHODS.status, params: {}, id: 9 }), {}, () => undefined);
  assert.deepEqual(JSON.parse(result.response), { id: 9, result: { version: "0.4.1-iphone-poc", profile_index: 0, layer_index: 0 } });
});
