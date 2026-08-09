import { randomBytes, randomUUID } from "node:crypto";
import { connect as connectSocket, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { handleDeviceRpc, hidNotification, joystickNotification } from "./protocol.js";
import type { AgentSlotSnapshot, BridgeClientRole, BridgeMessage, BridgeReply, CodexStateSnapshot, DeviceTelemetry, HidInput, InputAck, JoystickInput, LightingState, LayoutSnapshot, ReasoningSnapshot, VirtualDeviceDescriptor } from "./types.js";

export const DEFAULT_SOCKET = join(homedir(), "Library", "Application Support", "Codex Micro Lab", "bridge.sock");
export const DEFAULT_PORT = 47831;

interface Client {
  id: string;
  role: BridgeClientRole;
  lastActivity: number;
  send(reply: BridgeReply): void;
  close(): void;
}

interface BridgeOptions {
  socketPath?: string;
  port?: number;
  token?: string;
  tokenPath?: string;
  initialTelemetry?: DeviceTelemetry;
  heartbeatTimeoutMs?: number;
}

export class MicroBridge {
  readonly socketPath: string;
  port: number;
  readonly token: string;
  private readonly clients = new Map<string, Client>();
  private readonly topologySubscribers = new Set<string>();
  private readonly lighting: LightingState = { keys: {}, ambient: {}, threads: [] };
  private readonly agents = new Map<number, AgentSlotSnapshot>();
  private codexState: CodexStateSnapshot = { status: "not-detected", transport: null, model: null, error: null, lastResponseAt: null };
  private readonly recentInputAcks = new Map<string, InputAck>();
  private readonly recentRpcResponses = new Map<string, string>();
  private readonly heartbeatTimeoutMs: number;
  private readonly webControllerOrigins = new Set<string>();
  private telemetry: DeviceTelemetry;
  private unixServer: Server | null = null;
  private webServer: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: BridgeOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET;
    this.port = options.port ?? DEFAULT_PORT;
    this.token = options.token ?? loadOrCreateToken(options.tokenPath);
    if (!PAIRING_TOKEN_PATTERN.test(this.token)) throw new Error("Pairing token must be exactly 32 hexadecimal characters");
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
    this.telemetry = { firmwareVersion: "0.4.1-iphone-poc", ...options.initialTelemetry };
  }

  async start(): Promise<void> {
    mkdirSync(join(this.socketPath, ".."), { recursive: true });
    await removeStaleSocketOrRefuse(this.socketPath);
    this.unixServer = createServer((socket) => this.attachLineClient(socket, "codex-probe"));
    await new Promise<void>((resolve, reject) => {
      this.unixServer!.once("error", reject);
      this.unixServer!.listen(this.socketPath, () => {
        this.unixServer!.off("error", reject);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
    this.webServer = new WebSocketServer({ port: this.port, host: "0.0.0.0", maxPayload: 64 * 1024 });
    this.webServer.on("connection", (ws, request) => this.attachWebClient(ws, request));
    if (this.webServer.address() === null) {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => { this.webServer?.off("error", onError); resolve(); };
        const onError = (error: Error) => { this.webServer?.off("listening", onListening); reject(new Error(`Bridge WebSocket port ${this.port} is already in use or unavailable: ${error.message}`)); };
        this.webServer!.once("listening", onListening);
        this.webServer!.once("error", onError);
      });
    }
    const address = this.webServer.address();
    if (address && typeof address === "object") this.port = address.port;
    const heartbeatInterval = Math.min(5_000, Math.max(100, Math.floor(this.heartbeatTimeoutMs / 2)));
    this.heartbeatTimer = setInterval(() => this.expireInactiveClients(), heartbeatInterval);
    this.heartbeatTimer.unref();
    this.broadcastTopology();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    await new Promise<void>((resolve) => this.webServer?.close(() => resolve()) ?? resolve());
    this.webServer = null;
    await new Promise<void>((resolve) => this.unixServer?.close(() => resolve()) ?? resolve());
    this.unixServer = null;
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch { /* best effort */ }
  }

  getLighting(): LightingState { return structuredClone(this.lighting); }
  getCodexState(): CodexStateSnapshot { return structuredClone(this.codexState); }
  allowWebControllerOrigin(origin: string): void { this.webControllerOrigins.add(origin); }
  revokeWebControllerOrigin(origin: string): void { this.webControllerOrigins.delete(origin); }
  /** Discoverability requires a human controller; phone reachability alone is not Codex connectivity. */
  isAvailable(): boolean { return this.hasController(); }
  /** This is the state the official Codex Micro settings surface observes. */
  isCodexConnected(): boolean { return [...this.clients.values()].some((client) => client.role === "codex-shim"); }

  private hasController(): boolean {
    return [...this.clients.values()].some((client) => client.role === "iphone" || client.role === "web");
  }

  /**
   * Return IPv4 addresses that an iPhone can use to reach the WebSocket
   * listener. Only explicitly non-global IPv4 ranges are eligible for the QR.
   */
  getAdvertiseHosts(): string[] {
    const preferred = new Map<string, number>([["en0", 0], ["en1", 1], ["en2", 2], ["en3", 3]]);
    const addresses: Array<{ name: string; address: string; priority: number }> = [];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== "IPv4" || entry.internal) continue;
        if (/^(lo|utun|awdl|llw|bridge|gif|stf)/i.test(name)) continue;
        if (isAllowedPairingHost(entry.address)) addresses.push({ name, address: entry.address, priority: preferred.get(name) ?? 10 });
      }
    }
    return [...new Map(addresses.sort((a, b) => a.priority - b.priority).map((entry) => [entry.address, entry])).values()].map((entry) => entry.address);
  }

  private attachLineClient(socket: Socket, defaultRole: BridgeClientRole): void {
    let buffer = "";
    let client: Client | null = null;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as BridgeMessage;
          if (!client) {
            let role = defaultRole;
            if (message.type === "hello") {
              if (message.role !== "codex-shim" && message.role !== "codex-renderer" && message.role !== "codex-probe") throw new Error("Unix clients must use the Codex role");
              role = message.role;
            }
            client = this.registerClient(role, (reply) => {
              // A Codex probe can disappear while a topology/RPC reply is in
              // flight. Treat that close as normal instead of surfacing an
              // uncaught EPIPE/ERR_STREAM_WRITE_AFTER_END.
              if (socket.destroyed || !socket.writable) return;
              try { socket.write(`${JSON.stringify(reply)}\n`); } catch { /* peer closed */ }
            }, () => { if (!socket.destroyed) socket.end(); });
          }
          this.handleMessage(client, message);
        } catch (error) {
          if (!socket.destroyed && socket.writable) {
            try { socket.write(`${JSON.stringify({ version: 1, type: "error", message: error instanceof Error ? error.message : String(error) })}\n`); } catch { /* peer closed */ }
          }
        }
      }
    });
    socket.on("close", () => { if (client) this.removeClient(client.id); });
    socket.on("error", () => { if (client) this.removeClient(client.id); });
  }

  private attachWebClient(socket: WebSocket, request: IncomingMessage): void {
    if (!isAllowedWebSocketPeer(request.socket.remoteAddress)) {
      socket.close(1008, "Peer outside allowed network");
      return;
    }
    let client: Client | null = null;
    const authenticationTimer = setTimeout(() => {
      if (!client && socket.readyState === WebSocket.OPEN) socket.close(1008, "Authentication timeout");
    }, 5_000);
    authenticationTimer.unref();
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as BridgeMessage;
        if (!client) {
          if (message.type !== "hello") throw new Error("WebSocket hello is required");
          const role = message.role;
          if (role === "codex-renderer") throw new Error("Renderer clients must use the protected Unix socket");
          if (role !== "iphone" && role !== "web") throw new Error("Only iPhone or web clients may use the WebSocket transport");
          if (role === "web" && (typeof request.headers.origin !== "string" || !this.webControllerOrigins.has(request.headers.origin))) throw new Error("Web controller origin rejected");
          if ((role === "iphone" || role === "web") && message.token !== this.token) throw new Error("Pairing token rejected");
          client = this.registerClient(role, (reply) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try { socket.send(JSON.stringify(reply)); } catch { /* peer closed */ }
          }, () => {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
          });
          clearTimeout(authenticationTimer);
        }
        this.handleMessage(client, message);
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ version: 1, type: "error", message: error instanceof Error ? error.message : String(error) } satisfies BridgeReply), () => {
              if (!client && socket.readyState === WebSocket.OPEN) socket.close(1008, "Policy violation");
            });
          } catch { /* peer closed */ }
        }
      }
    });
    socket.on("close", () => { clearTimeout(authenticationTimer); if (client) this.removeClient(client.id); });
    socket.on("error", () => { clearTimeout(authenticationTimer); if (client) this.removeClient(client.id); });
  }

  private registerClient(role: BridgeClientRole, send: (reply: BridgeReply) => void, close: () => void): Client {
    if (role === "iphone" || role === "web") {
      for (const existing of this.clients.values()) if (existing.role === role) existing.close();
    }
    const client: Client = { id: randomUUID(), role, lastActivity: Date.now(), send, close };
    this.clients.set(client.id, client);
    client.send({ version: 1, type: "hello.ok", sessionId: client.id, role });
    if (role === "iphone" || role === "web") {
      client.send({ version: 1, type: "lighting.snapshot", lighting: this.getLighting() });
      const codexConnected = this.isCodexConnected();
      client.send({ version: 1, type: "connection.state", state: codexConnected ? "available" : "unavailable", ...(codexConnected ? {} : { reason: "codex-lab-not-running" }) });
      client.send({ version: 1, type: "codex.state", snapshot: structuredClone(this.codexState) });
      for (const snapshot of this.agents.values()) client.send({ version: 1, type: "agent.snapshot", snapshot: structuredClone(snapshot) });
      this.broadcastTopology();
    }
    if (role === "codex-shim") {
      this.codexState = { ...this.codexState, status: "connected", transport: "unknown", model: "codex-micro", error: null, lastResponseAt: new Date().toISOString() };
      this.broadcastCodexState();
    }
    return client;
  }

  private removeClient(id: string): void {
    const previous = this.clients.get(id);
    this.clients.delete(id);
    this.topologySubscribers.delete(id);
    if (previous?.role === "iphone" || previous?.role === "web") this.broadcastTopology();
    // A reconnect can briefly overlap with the old transport. Do not let one
    // Lab window closing make another still-connected window look offline.
    if (previous?.role === "codex-shim" && !this.isCodexConnected()) {
      this.codexState = { ...this.codexState, status: "not-detected", error: "codex-lab-not-running", lastResponseAt: new Date().toISOString() };
      this.broadcastCodexState();
    }
  }

  private handleMessage(client: Client, message: BridgeMessage): void {
    if (message.version !== 1) throw new Error("Unsupported bridge protocol version");
    client.lastActivity = Date.now();
    switch (message.type) {
      case "hello":
        if (message.role !== client.role) throw new Error("Client role cannot change after authentication");
        if ((message.role === "iphone" || message.role === "web") && message.token !== this.token) throw new Error("Pairing token rejected");
        return;
      case "device.list":
        if (client.role !== "codex-shim" && client.role !== "codex-probe") throw new Error("Device discovery is available only on the protected Unix transport");
        client.send({ version: 1, type: "device.list.result", requestId: message.requestId, devices: this.isAvailable() ? [this.descriptor()] : [] });
        return;
      case "topology.subscribe":
        if (client.role !== "codex-shim" && client.role !== "codex-probe") throw new Error("Topology subscription is available only on the protected Unix transport");
        this.topologySubscribers.add(client.id);
        client.send({ version: 1, type: "topology.changed", available: this.isAvailable() });
        return;
      case "rpc.request": {
        if (client.role !== "codex-shim" && client.role !== "codex-probe") throw new Error("RPC requests are available only on the protected Unix transport");
        const rpcKey = `${client.id}:${message.requestId}`;
        const cachedResponse = this.recentRpcResponses.get(rpcKey);
        if (cachedResponse !== undefined) {
          client.send({ version: 1, type: "rpc.response", requestId: message.requestId, raw: cachedResponse });
          return;
        }
        const { response } = handleDeviceRpc(message.raw, this.telemetry, (method, params) => {
          if (method === "v.oai.rgbcfg" && params && typeof params === "object") this.lighting.keys = (params as { keys?: Record<string, unknown> }).keys ?? {};
          if (method === "v.oai.rgbcfg" && params && typeof params === "object") this.lighting.ambient = (params as { ambient?: Record<string, unknown> }).ambient ?? {};
          if (method === "v.oai.thstatus" && Array.isArray(params)) {
            this.lighting.threads = params.slice(0, 6).map((thread, slot) => {
              const value = thread && typeof thread === "object" ? thread as { c?: unknown; s?: unknown } : {};
              return { slot, rgb: typeof value.c === "number" ? value.c : null, state: value.s === 1 ? "working" : value.s === 2 ? "awaiting-approval" : "idle" };
            });
            params.slice(0, 6).forEach((thread, slot) => {
              if (!thread || typeof thread !== "object") return;
              const value = thread as { c?: unknown; s?: unknown };
              const rgb = typeof value.c === "number" ? value.c : null;
              const status = value.s === 1 ? "working" : value.s === 2 ? "awaiting-approval" : "idle";
              const snapshot: AgentSlotSnapshot = { slot, status, selected: false, rgb };
              this.agents.set(slot, snapshot);
              this.broadcast({ version: 1, type: "agent.snapshot", snapshot: structuredClone(snapshot) }, "iphone", "web");
            });
          }
          this.broadcast({ version: 1, type: "lighting.snapshot", lighting: this.getLighting() }, "iphone", "web");
        });
        this.remember(this.recentRpcResponses, rpcKey, response);
        client.send({ version: 1, type: "rpc.response", requestId: message.requestId, raw: response });
        return;
      }
      case "input.hid":
        if (client.role !== "iphone" && client.role !== "web") throw new Error("Only iPhone or web clients may send input");
        if (!isHidInput(message.input)) throw new Error("Invalid HID input");
        if (this.replayInputAckIfSeen(client, message.input.eventId)) return;
        this.broadcast({ version: 1, type: "rpc.notification", raw: hidNotification(message.input) }, "codex-shim");
        this.ackInput(client, { eventId: message.input.eventId ?? randomUUID(), state: this.isCodexConnected() ? "bridge-accepted" : "unavailable", inputType: "hid", key: message.input.key, ...(this.isCodexConnected() ? {} : { reason: "codex-lab-not-running" }) });
        return;
      case "input.joystick":
        if (client.role !== "iphone" && client.role !== "web") throw new Error("Only iPhone or web clients may send input");
        if (!isJoystickInput(message.input)) throw new Error("Invalid joystick input");
        if (this.replayInputAckIfSeen(client, message.input.eventId)) return;
        this.broadcast({ version: 1, type: "rpc.notification", raw: joystickNotification(message.input) }, "codex-shim");
        this.ackInput(client, { eventId: message.input.eventId ?? randomUUID(), state: this.isCodexConnected() ? "bridge-accepted" : "unavailable", inputType: "joystick", ...(this.isCodexConnected() ? {} : { reason: "codex-lab-not-running" }) });
        return;
      case "input.text":
        if (client.role !== "iphone" && client.role !== "web") throw new Error("Only iPhone or web clients may send input");
        if (!isTextInput(message.input)) throw new Error("Invalid text input");
        const textEventId = message.input.eventId ?? randomUUID();
        if (this.replayInputAckIfSeen(client, textEventId)) return;
        if (!this.hasRenderer()) {
          this.ackInput(client, { eventId: textEventId, state: "unavailable", inputType: "text", reason: "codex-renderer-not-connected" });
          return;
        }
        this.broadcast({ version: 1, type: "input.text", input: { ...message.input, eventId: textEventId } }, "codex-renderer");
        this.ackInput(client, { eventId: textEventId, state: "bridge-accepted", inputType: "text" });
        return;
      case "device.telemetry":
        if (client.role !== "iphone") throw new Error("Only the iPhone client may publish telemetry");
        this.telemetry = { ...this.telemetry, ...message.telemetry };
        return;
      case "heartbeat":
        client.send({ version: 1, type: "heartbeat.ok", nonce: message.nonce });
        return;
      case "pairing.reset":
        if (client.role !== "iphone") throw new Error("Only the iPhone client can reset pairing");
        return;
      case "codex.semantic":
        if (client.role !== "codex-renderer") throw new Error("Only the local Codex renderer may publish semantic state");
        this.handleSemantic(message.event, message.payload);
        return;
    }
  }

  private hasRenderer(): boolean { return [...this.clients.values()].some((client) => client.role === "codex-renderer"); }

  private ackInput(source: Client, ack: InputAck): void {
    this.remember(this.recentInputAcks, ack.eventId, ack);
    source.send({ version: 1, type: "input.ack", ack });
    for (const client of this.clients.values()) {
      if (client.id !== source.id && (client.role === "iphone" || client.role === "web")) client.send({ version: 1, type: "input.ack", ack });
    }
  }

  private replayInputAckIfSeen(client: Client, eventId: string | undefined): boolean {
    if (!eventId) return false;
    const previous = this.recentInputAcks.get(eventId);
    if (!previous) return false;
    client.send({ version: 1, type: "input.ack", ack: structuredClone(previous) });
    return true;
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > 512) cache.delete(cache.keys().next().value!);
  }

  private handleSemantic(event: "agent.snapshot" | "layout.snapshot" | "reasoning.snapshot" | "codex.state" | "input.ack", payload: unknown): void {
    switch (event) {
      case "agent.snapshot":
        if (!isAgentSnapshot(payload)) throw new Error("Invalid agent snapshot");
        this.agents.set(payload.slot, sanitizeAgentSnapshot(payload));
        this.broadcast({ version: 1, type: "agent.snapshot", snapshot: sanitizeAgentSnapshot(payload) }, "iphone", "web");
        return;
      case "layout.snapshot":
        if (!isLayoutSnapshot(payload)) throw new Error("Invalid layout snapshot");
        // Layout names and command/skill assignments stay on the 0600 Unix
        // transport. They are not required to operate the LAN controller.
        return;
      case "reasoning.snapshot":
        if (!isReasoningSnapshot(payload)) throw new Error("Invalid reasoning snapshot");
        // Reasoning labels and choices are renderer-local metadata.
        return;
      case "codex.state":
        if (!isCodexStateSnapshot(payload)) throw new Error("Invalid Codex state snapshot");
        this.codexState = sanitizeCodexState(this.isCodexConnected() && payload.status === "not-detected"
          ? { ...payload, status: "connected", error: null, lastResponseAt: new Date().toISOString() }
          : payload);
        this.broadcast({ version: 1, type: "codex.state", snapshot: structuredClone(this.codexState) }, "iphone", "web");
        return;
      case "input.ack":
        if (!isInputAck(payload)) throw new Error("Invalid input ack");
        this.remember(this.recentInputAcks, payload.eventId, payload);
        this.broadcast({ version: 1, type: "input.ack", ack: payload }, "iphone", "web");
        return;
    }
  }

  private broadcast(reply: BridgeReply, ...roles: BridgeClientRole[]): void {
    for (const client of this.clients.values()) if (roles.includes(client.role)) client.send(reply);
  }

  private broadcastTopology(): void {
    const available = this.isAvailable();
    for (const id of this.topologySubscribers) this.clients.get(id)?.send({ version: 1, type: "topology.changed", available });
  }

  private broadcastCodexState(): void {
    const connected = this.isCodexConnected();
    this.broadcast({ version: 1, type: "connection.state", state: connected ? "available" : "unavailable", ...(connected ? {} : { reason: "codex-lab-not-running" }) }, "iphone", "web");
    this.broadcast({ version: 1, type: "codex.state", snapshot: structuredClone(this.codexState) }, "iphone", "web");
  }

  private descriptor(): VirtualDeviceDescriptor {
    return { portPath: `microbridge://${this.socketPath}`, devicePid: String(0x8360), connectionType: 1, deviceType: "codex_micro", layoutType: "universal", isUsbConnection: false };
  }

  private expireInactiveClients(): void {
    const deadline = Date.now() - this.heartbeatTimeoutMs;
    for (const client of this.clients.values()) {
      if ((client.role === "iphone" || client.role === "web") && client.lastActivity < deadline) client.close();
    }
  }
}

/**
 * Never unlink a live bridge socket. The previous implementation removed the
 * socket unconditionally, so starting microctl from another Codex thread
 * silently disconnected the already-running Lab instance. A stale socket is
 * removed only after a short connect probe proves that no server owns it.
 */
async function removeStaleSocketOrRefuse(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const live = await new Promise<boolean>((resolve) => {
    const socket = connectSocket(socketPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 500).unref();
  });
  if (live) throw new Error(`A Codex Micro Lab bridge is already running at ${socketPath}; refusing to replace it.`);
  try { unlinkSync(socketPath); } catch (error) { throw new Error(`Unable to remove stale bridge socket ${socketPath}: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function connectUnix(socketPath: string, onReply: (reply: BridgeReply) => void): Promise<{ send(message: BridgeMessage): void; close(): void }> {
  const { connect } = await import("node:net");
  const socket = connect(socketPath);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onReply(JSON.parse(line) as BridgeReply);
    }
  });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return {
    send: (message) => {
      if (socket.destroyed || !socket.writable) return;
      try { socket.write(`${JSON.stringify(message)}\n`); } catch { /* peer closed */ }
    },
    close: () => { if (!socket.destroyed) socket.end(); },
  };
}

function loadOrCreateToken(tokenPath?: string): string {
  const path = tokenPath ?? join(homedir(), "Library", "Application Support", "Codex Micro Lab", "pairing-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (PAIRING_TOKEN_PATTERN.test(existing)) {
      chmodSync(path, 0o600);
      return existing;
    }
  } catch { /* create or rotate */ }
  const token = randomBytes(16).toString("hex");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

const PAIRING_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;

export function isAllowedPairingHost(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [a, b, c, d] = octets.map(Number);
  if ([a, b, c, d].some((part) => part < 0 || part > 255)) return false;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    // The tested Apple Personal Hotspot path uses this non-forwardable
    // service-continuity prefix. Restrict it to /29; the wider /24 includes
    // globally reachable protocol anycast addresses.
    || (a === 192 && b === 0 && c === 0 && d <= 7);
}

export function isAllowedWebSocketPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") return true;
  return isAllowedPairingHost(address.startsWith("::ffff:") ? address.slice(7) : address);
}

function sanitizeAgentSnapshot(value: AgentSlotSnapshot): AgentSlotSnapshot {
  return { slot: value.slot, status: value.status, selected: value.selected, rgb: value.rgb };
}

function sanitizeCodexState(value: CodexStateSnapshot): CodexStateSnapshot {
  return { ...value, error: value.error ? "codex-error" : null };
}

function isHidInput(value: unknown): value is HidInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<HidInput>;
  return typeof input.key === "string" && input.key.length > 0 && (input.act === 0 || input.act === 1 || input.act === 2) && (input.agent === undefined || (Number.isInteger(input.agent) && input.agent >= 0 && input.agent <= 5));
}

function isJoystickInput(value: unknown): value is JoystickInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<JoystickInput>;
  return typeof input.angle === "number" && Number.isFinite(input.angle) && typeof input.distance === "number" && Number.isFinite(input.distance) && input.distance >= 0 && input.distance <= 1;
}

function isTextInput(value: unknown): value is { text: string; eventId?: string } {
  if (!value || typeof value !== "object") return false;
  const input = value as { text?: unknown; eventId?: unknown };
  return typeof input.text === "string" && input.text.trim().length > 0 && (input.eventId === undefined || typeof input.eventId === "string");
}

function isAgentSnapshot(value: unknown): value is AgentSlotSnapshot {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<AgentSlotSnapshot>;
  return Number.isInteger(input.slot) && (input.slot as number) >= 0 && (input.slot as number) <= 5 && ["off", "idle", "working", "awaiting-approval", "awaiting-response", "unread", "error"].includes(input.status ?? "") && typeof input.selected === "boolean" && (input.rgb === null || (typeof input.rgb === "number" && Number.isFinite(input.rgb) && input.rgb >= 0 && input.rgb <= 0xffffff));
}

function isLayoutSnapshot(value: unknown): value is LayoutSnapshot {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<LayoutSnapshot>;
  const directions = input.analogStick;
  const encoder = input.encoder;
  const validNullableString = (item: unknown): item is string | null => item === null || typeof item === "string";
  const validMap = input.actionKeys && typeof input.actionKeys === "object" && !Array.isArray(input.actionKeys) && Object.values(input.actionKeys).every((item) => validNullableString(item));
  return (input.agentSource === null || input.agentSource === "recent" || input.agentSource === "pinned" || input.agentSource === "priority" || input.agentSource === "custom") && !!directions && [directions.up, directions.right, directions.down, directions.left].every(validNullableString) && !!encoder && [encoder.left, encoder.click, encoder.right, encoder.longPress].every(validNullableString) && validMap === true && (input.encoderMode === null || input.encoderMode === "custom" || input.encoderMode === "reasoning" || input.encoderMode === "conversation-scroll" || input.encoderMode === "composer-navigation") && (input.microphoneMode === null || input.microphoneMode === "push-to-talk" || input.microphoneMode === "realtime") && (input.separateMicrophoneKeys === null || typeof input.separateMicrophoneKeys === "boolean");
}

function isReasoningSnapshot(value: unknown): value is ReasoningSnapshot {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<ReasoningSnapshot>;
  return (input.displayName === null || typeof input.displayName === "string") && (input.current === null || (typeof input.current === "number" && Number.isInteger(input.current) && input.current >= 0)) && (input.choices === null || (Array.isArray(input.choices) && input.choices.every((item) => typeof item === "string"))) && typeof input.available === "boolean";
}

function isCodexStateSnapshot(value: unknown): value is CodexStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CodexStateSnapshot>;
  return ["not-detected", "detected", "connected", "error"].includes(input.status ?? "") && (input.transport === null || ["usb", "bluetooth", "unknown"].includes(input.transport ?? "")) && (input.model === null || ["codex-micro", "creator-micro-v2"].includes(input.model ?? "")) && (input.error === null || typeof input.error === "string") && (input.lastResponseAt === null || typeof input.lastResponseAt === "string");
}

function isInputAck(value: unknown): value is InputAck {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<InputAck>;
  return typeof input.eventId === "string" && input.eventId.length > 0 && ["bridge-accepted", "codex-delivered", "confirmed", "unavailable", "failed"].includes(input.state ?? "") && ["hid", "joystick", "text"].includes(input.inputType ?? "") && (input.key === undefined || typeof input.key === "string") && (input.reason === undefined || typeof input.reason === "string");
}
