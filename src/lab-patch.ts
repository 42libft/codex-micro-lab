import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createPackageWithOptions, extractAll, extractFile, getRawHeader, listPackage } from "@electron/asar";
import * as ts from "typescript";

export const CODEX_APP = "/Applications/ChatGPT.app";
export const EXPECTED = {
  shortVersion: "26.803.41515",
  build: "6321",
  asarSha256: "5f6e773aafd542d3cf09e10b5dca6cabd301d0a155f4b8ce870e3915fc3da25e",
  serviceFile: ".vite/build/service-CJETEjOt.js",
  rendererFile: "webview/assets/codex-micro-bridge-M3pRKStd.js",
  rendererSha256: "2fb26724942972869316d543132abcca49f88099f651d66ad218374615ee2ae7",
  layoutFile: "webview/assets/codex-micro-settings-_7tbpXYh.js",
  layoutSha256: "267966de4119295f9f13780ed25e00b97b3f2b89a09f35172ab69bec49cbb1ee",
  gate: "3207467860",
  gateOccurrences: 7,
};

const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const FUSE_NAMES = [
  "runAsNode",
  "cookieEncryption",
  "nodeOptions",
  "nodeCliInspect",
  "embeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
  "loadBrowserProcessSpecificV8Snapshot",
  "grantFileProtocolExtraPrivileges",
  "wasmTrapHandlers",
] as const;

export interface LabBuildResult {
  appPath: string;
  asarPath: string;
  headerHash: string;
  gateOccurrences: number;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function inspectCodexApp(appPath = CODEX_APP): Record<string, unknown> {
  const plist = join(appPath, "Contents", "Info.plist");
  const resources = join(appPath, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  const unpackedPath = `${asar}.unpacked`;
  const shortVersion = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
  const build = execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
  const asarSha256 = sha256File(asar);
  let serviceFilePresent = false;
  let featureGateOccurrences = 0;
  try {
    extractFile(asar, EXPECTED.serviceFile);
    serviceFilePresent = true;
    // The gate is referenced from more than the transport service in this
    // build, so inspect every JavaScript member of the archive rather than
    // assuming it is colocated with CodexMicroService.
    featureGateOccurrences = countFeatureGate(asar, unpackedPath);
  } catch {
    // Keep inspect useful for unsupported or partially installed builds.
  }
  return {
    appPath,
    shortVersion,
    build,
    asarSha256,
    serviceFile: EXPECTED.serviceFile,
    serviceFilePresent,
    featureGate: EXPECTED.gate,
    featureGateOccurrences,
    electronFuses: inspectElectronFuses(appPath),
    expected: EXPECTED,
    compatible: shortVersion === EXPECTED.shortVersion && build === EXPECTED.build && asarSha256 === EXPECTED.asarSha256 && serviceFilePresent && featureGateOccurrences === EXPECTED.gateOccurrences,
  };
}

function countFeatureGate(asarPath: string, unpackedPath: string): number {
  let count = 0;
  for (const file of listPackage(asarPath, { isPack: false })) {
    if (!file.endsWith(".js")) continue;
    try { count += (extractFile(asarPath, file.replace(/^\//, "")).toString("utf8").match(new RegExp(EXPECTED.gate, "g")) ?? []).length; } catch { /* skip links/unreadable members */ }
  }
  if (existsSync(unpackedPath)) {
    for (const file of walk(unpackedPath)) {
      if (!file.endsWith(".js")) continue;
      try { count += (readFileSync(file, "utf8").match(new RegExp(EXPECTED.gate, "g")) ?? []).length; } catch { /* skip unreadable members */ }
    }
  }
  return count;
}

export function inspectElectronFuses(appPath: string): Record<string, unknown> {
  const executable = join(appPath, "Contents", "MacOS", basename(appPath, ".app"));
  const frameworks = join(appPath, "Contents", "Frameworks");
  const candidates = [executable, ...(existsSync(frameworks) ? walk(frameworks).filter((path) => /Framework$/.test(path) || /Codex Framework$/.test(path)) : [])];
  try {
    for (const candidate of candidates) {
      let binary: Buffer;
      try { binary = readFileSync(candidate); } catch { continue; }
      const sentinelOffset = binary.indexOf(FUSE_SENTINEL);
      if (sentinelOffset < 0) continue;
      const versionOffset = sentinelOffset + FUSE_SENTINEL.length;
      const version = binary[versionOffset];
      const length = binary[versionOffset + 1];
      const wire = binary.subarray(versionOffset + 2, versionOffset + 2 + length).toString("ascii");
      const fuses = Object.fromEntries(FUSE_NAMES.map((name, index) => [name, wire[index] === "0" ? false : wire[index] === "1" ? true : wire[index] === "r" ? "removed" : null]));
      return { available: wire.length === length, sentinelFound: true, executable: candidate, version, length, wire, fuses };
    }
    return { available: false, sentinelFound: false, executable, searched: candidates.length };
  } catch (error) {
    return { available: false, sentinelFound: false, executable, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function buildLabApp(sourceApp = CODEX_APP, destination = join(process.cwd(), "dist", "Codex Micro Lab.app")): Promise<LabBuildResult> {
  const sourceInfo = inspectCodexApp(sourceApp);
  if (sourceInfo.compatible !== true) throw new Error(`Unsupported Codex build. Run inspect and add an explicit compatibility manifest entry before patching.`);
  if (existsSync(destination)) throw new Error(`Destination already exists; remove it explicitly before rebuilding: ${destination}`);
  execFileSync("/bin/cp", ["-a", sourceApp, destination]);
  const resources = join(destination, "Contents", "Resources");
  const asarPath = join(resources, "app.asar");
  const unpackedPath = `${asarPath}.unpacked`;
  const work = mkdtempSync(join(tmpdir(), "codex-micro-lab-"));
  const extracted = join(work, "app");
  const unpackedSource = `${join(sourceApp, "Contents", "Resources", "app.asar")}.unpacked`;
  try {
    extractAll(asarPath, extracted);
    if (existsSync(unpackedSource)) mergeTree(unpackedSource, join(extracted, "__original-unpacked__"));
    const servicePath = join(extracted, EXPECTED.serviceFile);
    if (!existsSync(servicePath)) throw new Error(`Expected service module not found: ${EXPECTED.serviceFile}`);
    renameSync(servicePath, `${servicePath}.original.js`);
    writeFileSync(servicePath, wrapperSource(), "utf8");
    patchRendererBundle(extracted, EXPECTED.rendererFile, EXPECTED.rendererSha256);
    patchLayoutBundle(extracted, EXPECTED.layoutFile, EXPECTED.layoutSha256);
    const gateOccurrences = patchFeatureGate(extracted, EXPECTED.gate, EXPECTED.gateOccurrences);
    const originalUnpacked = join(extracted, "__original-unpacked__");
    if (existsSync(originalUnpacked)) mergeTree(originalUnpacked, extracted);
    const newAsar = join(work, "app.asar");
    await createPackageWithOptions(extracted, newAsar, {
      unpackDir: "node_modules/{@worklouder,better-sqlite3,node-pty,objc-js,node-mac-permissions}",
    });
    rmSync(asarPath, { force: true });
    rmSync(unpackedPath, { recursive: true, force: true });
    cpSync(newAsar, asarPath);
    if (existsSync(`${newAsar}.unpacked`)) cpSync(`${newAsar}.unpacked`, unpackedPath, { recursive: true });
    const headerHash = createHash("sha256").update(getRawHeader(asarPath).headerString).digest("hex");
    const plist = join(destination, "Contents", "Info.plist");
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`, plist]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :ElectronAsarIntegrity:Resources/app.asar:algorithm SHA256", plist]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier com.codexmicrolab.lab", plist]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Codex Micro Lab", plist]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleDisplayName Codex Micro Lab", plist]);
    execFileSync("plutil", ["-replace", "SUEnableAutomaticChecks", "-bool", "false", plist]);
    resignMachCode(destination);
    execFileSync("codesign", ["--verify", "--deep", "--strict", destination], { stdio: "inherit" });
    return { appPath: destination, asarPath, headerHash, gateOccurrences };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function resignMachCode(appPath: string): void {
  const machFiles = walk(appPath).filter((path) => {
    const mode = statSync(path).mode;
    if (!(mode & 0o111) && !path.endsWith(".dylib") && !path.endsWith(".node")) return false;
    try { return /Mach-O/.test(execFileSync("file", [path], { encoding: "utf8" })); } catch { return false; }
  });
  for (const path of machFiles.sort((a, b) => b.length - a.length)) {
    execFileSync("codesign", ["--force", "--sign", "-", path], { stdio: "ignore" });
  }
  const bundles = walkDirectories(appPath).filter((path) => path.endsWith(".framework") || path.endsWith(".app"));
  for (const path of bundles.sort((a, b) => b.length - a.length)) {
    execFileSync("codesign", ["--force", "--sign", "-", path], { stdio: "ignore" });
  }
  execFileSync("codesign", ["--force", "--sign", "-", appPath], { stdio: "ignore" });
}

export function patchFeatureGate(root: string, gate: string, expected: number): number {
  const files = walk(root).filter((path) => path.endsWith(".js"));
  let count = 0;
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const matches: Array<{ start: number; end: number }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length === 1) {
        const argument = node.arguments[0];
        if (ts.isNoSubstitutionTemplateLiteral(argument) && argument.text === gate && ts.isIdentifier(node.expression)) {
          matches.push({ start: node.getStart(source), end: node.end });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    count += matches.length;
    let after = before;
    for (const match of matches.sort((a, b) => b.start - a.start)) after = `${after.slice(0, match.start)}true${after.slice(match.end)}`;
    if (after !== before) writeFileSync(file, after, "utf8");
  }
  if (count !== expected) throw new Error(`Expected ${expected} Feature Gate calls, found ${count}; refusing to produce a fragile patch.`);
  return count;
}

/**
 * Add a small loopback-only observer to the renderer. It exposes semantic
 * state without replacing Codex's own Micro UI and accepts composer text from
 * the iPhone cockpit. Unknown bundles fail closed.
 */
export function patchRendererBundle(root: string, relativeFile: string, expectedSha256: string): void {
  const file = join(root, relativeFile);
  if (!existsSync(file)) throw new Error(`Expected renderer module not found: ${relativeFile}`);
  const before = readFileSync(file, "utf8");
  const actual = createHash("sha256").update(before).digest("hex");
  if (actual !== expectedSha256) throw new Error(`Renderer hash mismatch for ${relativeFile}; refusing to patch unknown Codex build.`);
  const anchor = "export{qt as CodexMicroBridge};";
  if (before.split(anchor).length - 1 !== 1) throw new Error("Renderer patch anchor count mismatch; refusing to patch.");
  if (before.includes("CODEX_MICRO_LAB_RENDERER_OBSERVER")) throw new Error("Renderer already contains the Lab observer.");
  const observer = String.raw`
/* CODEX_MICRO_LAB_RENDERER_OBSERVER: renderer anchor, transport stays in the main process */
(()=>{try{
  /* The Lab service uses Electron's existing message-for-view channel. A
     direct WebSocket from this bundle would be rejected by Codex's CSP. */
  globalThis.__CODEX_MICRO_LAB_RENDERER_READY__="M3pRKStd";
}catch{}}
)();
`;
  const marker = "//# sourceMappingURL=";
  const index = before.indexOf(marker);
  const after = index >= 0 ? before.slice(0, index) + observer + "\n" + before.slice(index) : before + "\n" + observer;
  writeFileSync(file, after, "utf8");
}

/**
 * Expose the normalized Codex Micro layout that the official settings
 * component already has in memory. Reading rendered labels is not sufficient:
 * custom keycaps and skills have no stable text node, and guessing their
 * meaning would make the phone send the wrong action. This exact bundle
 * anchor is guarded by the build manifest, so an updated Codex must be
 * re-analysed instead of receiving a speculative patch.
 */
export function patchLayoutBundle(root: string, relativeFile: string, expectedSha256: string): void {
  const file = join(root, relativeFile);
  if (!existsSync(file)) throw new Error(`Expected Micro settings module not found: ${relativeFile}`);
  const before = readFileSync(file, "utf8");
  const actual = createHash("sha256").update(before).digest("hex");
  if (actual !== expectedSha256) throw new Error(`Micro settings hash mismatch for ${relativeFile}; refusing to patch unknown Codex build.`);
  const anchor = "t[0]===v?w=t[1]:(w=fn(v),t[0]=v,t[1]=w);";
  if (before.split(anchor).length - 1 !== 1) throw new Error("Micro settings layout anchor count mismatch; refusing to patch.");
  if (before.includes("CODEX_MICRO_LAB_LAYOUT_OBSERVER")) throw new Error("Micro settings already contains the Lab layout observer.");
  const observer = "/* CODEX_MICRO_LAB_LAYOUT_OBSERVER: normalized settings state for the loopback semantic bridge */try{globalThis.__CODEX_MICRO_LAB_LAYOUT__=JSON.parse(JSON.stringify(w));}catch{}";
  writeFileSync(file, before.replace(anchor, `${anchor}${observer}`), "utf8");
}

function walk(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function walkDirectories(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(path, ...walkDirectories(path));
    }
  }
  return output;
}

function mergeTree(source: string, destination: string): void {
  mkdirSafe(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) mergeTree(from, to);
    else cpSync(from, to, { recursive: true, dereference: false });
  }
}

function mkdirSafe(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function wrapperSource(): string {
  return String.raw`const net = require("node:net");
const crypto = require("node:crypto");
const original = require("./service-CJETEjOt.js.original.js");

const SOCKET = process.env.CODEX_MICRO_BRIDGE_SOCKET || require("node:path").join(require("node:os").homedir(), "Library", "Application Support", "Codex Micro Lab", "bridge.sock");
const DEVICE = { portPath: "microbridge://codex-micro-lab", devicePid: "33632", connectionType: 1, deviceType: "codex_micro", layoutType: "universal", isUsbConnection: false };

function lineClient(onMessage) {
  const socket = net.createConnection(SOCKET);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => { buffer += chunk; for (;;) { const i = buffer.indexOf("\n"); if (i < 0) break; const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue; try { onMessage(JSON.parse(line)); } catch { /* a peer's malformed/late frame must not crash the Lab service */ } } });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => {
      // Keep a listener for late close errors. A topology poll intentionally
      // closes its short-lived socket after the reply, and Node otherwise
      // reports a second EPIPE as an uncaught event.
      socket.on("error", () => {});
      resolve({ socket, send: (m) => {
        if (socket.destroyed || !socket.writable) return false;
        try { return socket.write(JSON.stringify(m) + "\n"); } catch { return false; }
      } });
    });
    socket.once("error", reject);
  });
}

function appWindows() {
  try {
    const { BrowserWindow } = require("electron");
    return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed());
  } catch { return []; }
}

/* Codex's renderer already subscribes to this host message and inserts text
   into the active composer. Sending it through the existing Electron IPC
   channel avoids the renderer CSP restriction on a new WebSocket. */
function deliverComposerText(text) {
  const windows = appWindows();
  if (windows.length === 0) return false;
  const message = { type: "codex-micro-insert-composer-text", text };
  for (const window of windows) window.webContents.send("codex_desktop:message-for-view", message);
  return true;
}

async function listDevices() {
  const requestId = crypto.randomUUID();
  let client;
  return new Promise(async (resolve, reject) => {
    try {
      client = await lineClient((message) => { if (message.type === "device.list.result" && message.requestId === requestId) { client.socket.end(); resolve(message.devices || []); } });
      client.send({ version: 1, type: "device.list", requestId });
    } catch (error) { reject(error); }
  });
}

function topologyWatcher(callback) { const timer = setInterval(() => listDevices().then(() => callback()).catch(() => callback()), 1000); timer.unref?.(); return { dispose: () => clearInterval(timer) }; }

let semantic;
function handleSemanticMessage(message) {
  if (message.type !== "input.text") return;
  const input = message.input && typeof message.input === "object" ? message.input : {};
  const eventId = typeof input.eventId === "string" ? input.eventId : crypto.randomUUID();
  const text = typeof input.text === "string" ? input.text : "";
  const delivered = text.length > 0 && deliverComposerText(text);
  publishSemantic("input.ack", { eventId, state: delivered ? "codex-delivered" : "unavailable", inputType: "text", ...(delivered ? {} : { reason: text.length === 0 ? "empty-text" : "codex-window-not-ready" }) });
}
async function getSemanticClient() {
  if (semantic) return semantic;
  semantic = await lineClient(handleSemanticMessage);
  const current = semantic;
  current.socket.on("close", () => { if (semantic === current) semantic = null; });
  current.socket.on("error", () => { if (semantic === current) semantic = null; });
  current.send({ version: 1, type: "hello", role: "codex-renderer" });
  return semantic;
}
function publishSemantic(event, payload) { getSemanticClient().then((client) => client.send({ version: 1, type: "codex.semantic", event, payload })).catch(() => {}); }
/* Work Louder's ConnectionEventType is numeric in this Codex build:
   CONNECTED=0, DISCONNECTED=1, ERROR=2. Keep string values for older builds
   and fail closed for unknown values instead of reporting a false connection. */
function normalizeDeviceState(value) {
  const raw = value && typeof value === "object" ? value.status : value;
  if (raw === 0 || raw === "connected" || raw === "CONNECTED") return "connected";
  if (raw === "detected" || raw === "DETECTED") return "detected";
  if (raw === 2 || raw === "error" || raw === "ERROR") return "error";
  return "not-detected";
}
function publishCodexState(value, error = null) {
  const object = value && typeof value === "object" ? value : null;
  const transport = object?.transport === "usb" || object?.transport === "bluetooth" || object?.transport === "unknown" ? object.transport : "unknown";
  const model = object?.model === "codex-micro" || object?.model === "creator-micro-v2" ? object.model : "codex-micro";
  const detail = typeof object?.error === "string" ? object.error : error;
  publishSemantic("codex.state", { status: normalizeDeviceState(value), transport, model, error: detail, lastResponseAt: new Date().toISOString() });
}
function safeAgentStatus(value) { return ["off", "idle", "working", "awaiting-approval", "awaiting-response", "unread", "error"].includes(value) ? value : "idle"; }
const agentRgb = new Map();
function publishAgentSlots(value) {
  const slots = Array.isArray(value) ? value : Array.isArray(value?.slots) ? value.slots : [];
  slots.slice(0, 6).forEach((slot, index) => {
    const id = Number.isInteger(slot?.id) && slot.id >= 0 && slot.id < 6 ? slot.id : index;
    if (typeof slot?.rgb === "number") agentRgb.set(id, slot.rgb);
    publishSemantic("agent.snapshot", { slot: id, status: safeAgentStatus(slot?.status), selected: slot?.selected === true, rgb: typeof slot?.rgb === "number" ? slot.rgb : agentRgb.get(id) ?? null });
  });
}

class BridgeComm {
  constructor() { this.socket = null; this.connected = false; this.listeners = new Set(); this.notify = new Map(); this.pending = new Map(); this.buffer = ""; this.connectionGeneration = 0; }
  onConnectionEvent(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  addNotifyHandler(method, callback) { this.notify.set(method, callback); }
  removeNotifyHandler(method) { this.notify.delete(method); }
  async connect() {
    if (this.connected) return true;
    const client = await lineClient((message) => this.handle(message));
    const generation = ++this.connectionGeneration;
    const socket = client.socket;
    this.socket = socket;
    socket.on("close", () => {
      // A reconnect can overlap the old socket's close event. Only the
      // currently-owned transport may change service state or reject
      // pending requests; otherwise one Lab window can make another look
      // disconnected.
      if (this.socket !== socket || this.connectionGeneration !== generation) return;
      if (this.connected) { this.connected = false; this.emit({ type: 1 }); }
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("bridge disconnected")); }
      this.pending.clear();
      this.socket = null;
    });
    socket.on("error", () => {});
    this.send = client.send;
    this.send({ version: 1, type: "hello", role: "codex-shim" });
    this.connected = true;
    this.emit({ type: 0 });
    return true;
  }
  isConnected() { return this.connected; }
  async disconnect() {
    const socket = this.socket;
    if (!socket) return;
    ++this.connectionGeneration;
    this.connected = false;
    this.socket = null;
    socket.end();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("bridge disconnected")); }
    this.pending.clear();
    this.emit({ type: 1 });
  }
  sendLegacyRpcRequest() { return Promise.reject(new Error("legacy RPC is not implemented by the Codex Micro bridge")); }
  sendJsonRpcRequest(request, id) { if (!this.connected || !this.send) return Promise.reject(new Error("bridge is not connected")); return new Promise((resolve, reject) => { const requestId = crypto.randomUUID(); const timeoutMs = Math.max(25, Number.parseInt(process.env.CODEX_MICRO_RPC_TIMEOUT_MS || "5000", 10) || 5000); const timer = setTimeout(() => { const pending = this.pending.get(requestId); if (!pending) return; this.pending.delete(requestId); pending.reject(new Error("RPC timeout")); }, timeoutMs); this.pending.set(requestId, { resolve, reject, id, timer }); this.send({ version: 1, type: "rpc.request", requestId, raw: request }); }); }
  abortJsonRpcRequest(id) { for (const [key, pending] of this.pending) if (pending.id === id) { clearTimeout(pending.timer); pending.reject(new Error("RPC aborted")); this.pending.delete(key); } return Promise.resolve(); }
  cleanCommQueue() {}
  handle(message) { if (message.type === "rpc.response") { const pending = this.pending.get(message.requestId); if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.resolve(message.raw); } } else if (message.type === "rpc.notification") { let parsed; try { parsed = JSON.parse(message.raw); } catch { return; } const method = parsed.method || parsed.m; const handler = this.notify.get(method); if (handler) handler(parsed.params); } }
  emit(event) { for (const listener of this.listeners) listener(event); }
}

class LabService extends original.CodexMicroService {
  constructor(options) {
    const findDevices = async () => listDevices();
    const originalState = options?.onDeviceStateChanged;
    const wrappedOptions = { ...options, findDevices, watchHidTopology: topologyWatcher, createComm: () => new BridgeComm() };
    wrappedOptions.onDeviceStateChanged = (...args) => { publishCodexState(args[0], args[1] instanceof Error ? args[1].message : null); return originalState?.(...args); };
    super(wrappedOptions);
  }
  async updateLighting(...args) { const result = await super.updateLighting(...args); publishAgentSlots(args[0]); return result; }
}
exports.CodexMicroService = LabService;
`;
}
