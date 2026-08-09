import { CODEX_MICRO, type HidInput, type JoystickInput, type RpcRequest, type RpcResponse } from "./types.js";

export const VENDOR_METHODS = {
  status: "device.status",
  version: "sys.version",
  rgb: "v.oai.rgbcfg",
  threads: "v.oai.thstatus",
  hid: "v.oai.hid",
  joystick: "v.oai.rad",
} as const;

export function parseRpcRequest(raw: string): RpcRequest {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("RPC must be an object");
  const candidate = value as Partial<RpcRequest>;
  if (typeof candidate.method !== "string" || candidate.method.length === 0) {
    throw new Error("RPC method is required");
  }
  if (typeof candidate.id !== "string" && typeof candidate.id !== "number") {
    throw new Error("RPC id is required");
  }
  return { method: candidate.method, params: candidate.params, id: candidate.id };
}

export function rpcResult(id: string | number, result: unknown = null): string {
  return JSON.stringify({ id, result });
}

export function rpcError(id: string | number, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } });
}

export function rpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ method, params });
}

export function hidNotification(input: HidInput): string {
  return rpcNotification(VENDOR_METHODS.hid, { k: input.key, act: input.act, ...(input.agent === undefined ? {} : { ag: input.agent }), ...(input.eventId === undefined ? {} : { eid: input.eventId }) });
}

export function joystickNotification(input: JoystickInput): string {
  return rpcNotification(VENDOR_METHODS.joystick, { a: input.angle, d: input.distance, ...(input.eventId === undefined ? {} : { eid: input.eventId }) });
}

export function statusResponse(id: string | number, telemetry: { batteryPercentage?: number; isCharging?: boolean; firmwareVersion?: string }): string {
  return rpcResult(id, {
    version: telemetry.firmwareVersion ?? "0.4.1-iphone-poc",
    profile_index: 0,
    layer_index: 0,
    ...(telemetry.batteryPercentage === undefined ? {} : { battery: telemetry.batteryPercentage }),
    ...(telemetry.isCharging === undefined ? {} : { is_charging: telemetry.isCharging }),
  });
}

export function handleDeviceRpc(raw: string, telemetry: { batteryPercentage?: number; isCharging?: boolean; firmwareVersion?: string }, onLighting: (method: string, params: unknown) => void): { response: string; request: RpcRequest } {
  const request = parseRpcRequest(raw);
  switch (request.method) {
    case VENDOR_METHODS.status:
      return { request, response: statusResponse(request.id, telemetry) };
    case VENDOR_METHODS.version:
      return { request, response: rpcResult(request.id, { version: telemetry.firmwareVersion ?? "0.4.1-iphone-poc" }) };
    case VENDOR_METHODS.rgb:
    case VENDOR_METHODS.threads:
      onLighting(request.method, request.params);
      return { request, response: rpcResult(request.id, true) };
    default:
      return { request, response: rpcError(request.id, -32601, `Method not found: ${request.method}`) };
  }
}

export function encodeHidPayload(payload: string, includeReportId = true): Buffer[] {
  const body = Buffer.from(payload, "utf8");
  const max = 61;
  const frames: Buffer[] = [];
  for (let offset = 0; offset < body.length || (body.length === 0 && offset === 0); offset += max) {
    const chunk = body.subarray(offset, offset + max);
    const frame = Buffer.alloc(includeReportId ? 64 : 63);
    let base = 0;
    if (includeReportId) frame[base++] = CODEX_MICRO.reportId;
    frame[base++] = CODEX_MICRO.rpcChannel;
    frame[base++] = chunk.length;
    chunk.copy(frame, base);
    frames.push(frame);
  }
  return frames;
}

export function decodeHidFrame(frame: Uint8Array, includeReportId = true): { channel: number; payload: string } {
  const minLength = includeReportId ? 3 : 3;
  if (frame.length < minLength) throw new Error("HID frame is too short");
  const reportOffset = includeReportId ? 1 : 0;
  if (includeReportId && frame[0] !== CODEX_MICRO.reportId) throw new Error(`Unexpected report id ${frame[0]}`);
  const channel = frame[reportOffset];
  if (channel !== CODEX_MICRO.rpcChannel) throw new Error(`Unexpected RPC channel ${channel}`);
  const length = frame[reportOffset + 1];
  const start = reportOffset + 2;
  if (length > frame.length - start) throw new Error("HID payload length exceeds frame");
  return { channel, payload: Buffer.from(frame.subarray(start, start + length)).toString("utf8") };
}

export function parseRpcResponse(raw: string): RpcResponse {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("id" in value)) throw new Error("Invalid RPC response");
  return value as RpcResponse;
}
