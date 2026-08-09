import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MicroBridge } from "./bridge.js";
import { buildLabApp, CODEX_APP, inspectCodexApp } from "./lab-patch.js";
import { serveWebController } from "./web.js";
import { backupState, readBackupSnapshot, readMicroState, restoreState, setUiUnlocked } from "./state.js";

const LAB_HOME = process.env.CODEX_MICRO_LAB_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Codex Micro Lab");
const BACKUP_HOME = join(LAB_HOME, "state-backups");
const BRIDGE_WEB_RUNTIME = join(LAB_HOME, "bridge-web.json");

async function main(argv: string[]): Promise<void> {
  const [command, subcommand] = argv;
  if (command === "inspect") {
    console.log(JSON.stringify({ codex: inspectCodexApp(), micro: { vendorId: "0x303A", productId: "0x8360", usagePage: "0xFF00", reportId: 6, rpcChannel: 2 } }, null, 2));
    return;
  }
  if (command === "doctor") { doctor(); return; }
  if (command === "ui") { await uiCommand(subcommand); return; }
  if (command === "lab" && subcommand === "build") {
    const result = await buildLabApp();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "lab" && subcommand === "launch") { launchLab(); return; }
  if (command === "qr") { showPairingQr(); return; }
  if (command === "bridge" || command === "start") { await startBridge(command === "start"); return; }
  console.error("Usage: microctl inspect | doctor | ui enable|status|restore | bridge start | start | qr | lab build|launch");
  process.exitCode = 2;
}

function doctor(): void {
  const xcode = captureCommand("xcodebuild", ["-version"]);
  const developerDir = captureCommand("xcode-select", ["-p"]);
  const devices = captureCommand("xcrun", ["xctrace", "list", "devices"]);
  const coreDevices = captureCommand("xcrun", ["devicectl", "list", "devices"]);
  const coreInventory = readCoreDeviceInventory();
  const inspect = (() => { try { return inspectCodexApp(); } catch (error) { return { compatible: false, error: error instanceof Error ? error.message : String(error) }; } })();
  const processList = listProcessCommands();
  const physicalSection = devices.split("== Simulators ==", 1)[0] ?? "";
  const physicalDevices = physicalSection.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("==") && !line.includes("Devices") && !line.includes("MacBook"));
  const coreDeviceMatch = coreDevices.match(/\b([0-9A-F]{8}-[0-9A-F-]{27})\s+(connected|unavailable|offline)\b/i);
  const coreDevice = coreInventory.find((device) => device.identifier === coreDeviceMatch?.[1]) ?? coreInventory.find((device) => device.platform === "iOS");
  const coreDeviceId = coreDevice?.identifier ?? coreDeviceMatch?.[1];
  const coreDeviceState = coreDevice?.state ?? coreDeviceMatch?.[2]?.toLowerCase() ?? null;
  const developerMode = coreDevice?.developerModeStatus
    ? { enabled: coreDevice.developerModeStatus === "enabled", diagnostic: null }
    : coreDeviceId && coreDeviceState === "connected"
    ? (() => {
      const result = captureCommandResult("xcrun", ["devicectl", "device", "info", "apps", "--device", coreDeviceId]);
      return { enabled: result.status === 0, diagnostic: result.status === 0 ? null : "Developer Mode check failed" };
    })()
    : { enabled: null, diagnostic: coreDeviceState ? `CoreDevice state is ${coreDeviceState}` : physicalDevices.length ? "CoreDevice identifier unavailable" : "No physical iPhone detected" };
  console.log(JSON.stringify({
    codex: inspect,
    xcode: { version: xcode.trim() || null, developerDirectory: developerDir.trim() || null },
    devices: { physicalCount: physicalDevices.length, coreDeviceDetected: Boolean(coreDeviceId), coreDeviceState, simulators: devices.includes("== Simulators =="), developerMode },
    bridge: { socketPath: join(LAB_HOME, "bridge.sock"), socketPresent: existsSync(join(LAB_HOME, "bridge.sock")) },
    lab: { appPath: join(process.cwd(), "dist", "Codex Micro Lab.app"), appPresent: existsSync(join(process.cwd(), "dist", "Codex Micro Lab.app")) },
    processes: { regularCodex: processList.some((line) => line.includes("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")), lab: processList.some((line) => line.includes("Codex Micro Lab.app/Contents/MacOS/ChatGPT")) },
  }, null, 2));
}

interface CoreDeviceSummary {
  identifier: string;
  state: string | null;
  platform: string | null;
  developerModeStatus: string | null;
}

function readCoreDeviceInventory(): CoreDeviceSummary[] {
  const directory = mkdtempSync(join(tmpdir(), "codex-micro-lab-doctor-"));
  const outputPath = join(directory, "devices.json");
  try {
    const result = spawnSync("xcrun", ["devicectl", "list", "devices", "--json-output", outputPath], { encoding: "utf8" });
    if (result.status !== 0 || !existsSync(outputPath)) return [];
    const parsed: unknown = JSON.parse(readFileSync(outputPath, "utf8"));
    const devices = parsed && typeof parsed === "object" && "result" in parsed && parsed.result && typeof parsed.result === "object" && "devices" in parsed.result && Array.isArray(parsed.result.devices) ? parsed.result.devices : [];
    return devices.flatMap((item: unknown): CoreDeviceSummary[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as { identifier?: unknown; connectionProperties?: { tunnelState?: unknown }; deviceProperties?: { developerModeStatus?: unknown }; hardwareProperties?: { platform?: unknown } };
      if (typeof value.identifier !== "string") return [];
      return [{
        identifier: value.identifier,
        state: typeof value.connectionProperties?.tunnelState === "string" ? value.connectionProperties.tunnelState : null,
        platform: typeof value.hardwareProperties?.platform === "string" ? value.hardwareProperties.platform : null,
        developerModeStatus: typeof value.deviceProperties?.developerModeStatus === "string" ? value.deviceProperties.developerModeStatus : null,
      }];
    });
  } catch {
    return [];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function captureCommand(command: string, args: string[]): string {
  try { return execFileSync(command, args, { encoding: "utf8" }); } catch { return ""; }
}

function captureCommandResult(command: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function listProcessCommands(): string[] {
  return captureCommand("ps", ["-axo", "command="]).split("\n");
}

async function uiCommand(action: string | undefined): Promise<void> {
  if (action === "status") {
    const state = readMicroState();
    console.log(JSON.stringify({
      hasEverBeenDetected: state["codex-micro-has-ever-been-detected"] === true,
      lastDetectedDeviceModel: state["codex-micro-last-detected-device-model"] ?? null,
      statePath: "~/.codex/.codex-global-state.json",
      backupDirectory: BACKUP_HOME,
    }, null, 2));
    return;
  }
  if (action === "enable") {
    refuseIfCodexRunning();
    mkdirSync(BACKUP_HOME, { recursive: true });
    const backupDir = join(BACKUP_HOME, new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
    backupState(backupDir);
    setUiUnlocked();
    console.log(`Codex Micro UI state enabled. Backup: ${backupDir}`);
    return;
  }
  if (action === "restore") {
    refuseIfCodexRunning();
    const entries = existsSync(BACKUP_HOME) ? readdirSync(BACKUP_HOME).sort() : [];
    const latest = entries.at(-1);
    if (!latest) throw new Error("No microctl UI backup exists");
    const backupDir = join(BACKUP_HOME, latest);
    restoreState(readBackupSnapshot(backupDir));
    console.log(`Codex Micro UI state restored from ${backupDir}`);
    return;
  }
  throw new Error("Usage: microctl ui enable|status|restore");
}

async function startBridge(withWeb: boolean): Promise<void> {
  const bridge = new MicroBridge({ socketPath: join(LAB_HOME, "bridge.sock"), tokenPath: join(LAB_HOME, "pairing-token"), port: bridgePortFromEnvironment() });
  await bridge.start();
  let web: Awaited<ReturnType<typeof serveWebController>> | undefined;
  if (withWeb) {
    web = await serveWebController(bridge);
    const webUrl = `http://127.0.0.1:${web.port}/`;
    writeFileSync(BRIDGE_WEB_RUNTIME, `${JSON.stringify({ webUrl, webPort: web.port, bridgePort: bridge.port })}\n`, { mode: 0o600 });
    console.log(`Web controller: ${webUrl}`);
    console.log(`QR: automatically opened in your browser (run \`microctl qr\` to show it again)`);
    if (process.env.CODEX_MICRO_NO_OPEN !== "1") spawnSync("open", [webUrl], { stdio: "ignore" });
  }
  console.log(`Bridge LAN WebSocket port: ${bridge.port} (trusted local/private network only)`);
  console.log(`Pairing QR: ${bridge.getAdvertiseHosts().length > 0 ? "available in the local Web controller" : "unavailable until an allowlisted non-global IPv4 interface is active"}`);
  console.log(`Bridge socket: ${bridge.socketPath}`);
  await new Promise<void>((resolve) => {
    const stop = async () => {
      await web?.close();
      await bridge.stop();
      if (existsSync(BRIDGE_WEB_RUNTIME)) rmSync(BRIDGE_WEB_RUNTIME, { force: true });
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function bridgePortFromEnvironment(): number | undefined {
  const raw = process.env.CODEX_MICRO_BRIDGE_PORT;
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error("CODEX_MICRO_BRIDGE_PORT must be 0 or an integer from 1024 through 65535");
  return port;
}

function showPairingQr(): void {
  if (!existsSync(BRIDGE_WEB_RUNTIME)) {
    throw new Error("Bridge web controller is not running. Start it with `microctl start` first.");
  }
  let runtime: { webUrl?: unknown };
  try { runtime = JSON.parse(readFileSync(BRIDGE_WEB_RUNTIME, "utf8")) as { webUrl?: unknown }; } catch { throw new Error("Bridge web controller state is invalid; restart `microctl start`."); }
  const webUrl = typeof runtime.webUrl === "string" && runtime.webUrl.startsWith("http://127.0.0.1:") ? runtime.webUrl : null;
  if (!webUrl) throw new Error("Bridge web controller state is invalid; restart `microctl start`.");
  spawnSync("open", [webUrl], { stdio: "ignore" });
  console.log(`Pairing QR opened: ${webUrl}`);
}

function launchLab(): void {
  // The Lab copy uses a separate user-data directory, but running it beside
  // the signed-in Codex can still contend for account storage and device UI.
  // Keep the launch boundary explicit and require the regular app to be quit.
  refuseIfCodexRunning();
  const app = join(process.cwd(), "dist", "Codex Micro Lab.app", "Contents", "MacOS", "ChatGPT");
  if (!existsSync(app)) throw new Error("Lab app does not exist; run `microctl lab build` first");
  const bridgeSocket = join(LAB_HOME, "bridge.sock");
  if (!existsSync(bridgeSocket)) throw new Error("Bridge socket is missing; start `microctl start` before launching the Lab copy.");
  const userDataDir = join(LAB_HOME, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  const child = spawn(app, [`--user-data-dir=${userDataDir}`], {
    env: { ...process.env, CODEX_MICRO_BRIDGE_SOCKET: bridgeSocket },
    stdio: "inherit",
    detached: false,
  });
  child.once("exit", (code, signal) => { if (code !== 0) console.error(`Lab exited: ${code ?? signal}`); });
}

function refuseIfLabRunning(): void {
  if (listProcessCommands().some((line) => line.includes("Codex Micro Lab.app/Contents/MacOS/ChatGPT"))) {
    throw new Error("A Codex Micro Lab instance is already running.");
  }
}

function refuseIfCodexRunning(): void {
  if (listProcessCommands().some((line) => line.includes("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT") || line.includes("Codex Micro Lab.app/Contents/MacOS/ChatGPT"))) {
    throw new Error("Close Codex before changing Micro state or launching the Lab copy.");
  }
}

main(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
