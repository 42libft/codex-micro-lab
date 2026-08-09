import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const GLOBAL_STATE_PATH = join(homedir(), ".codex", ".codex-global-state.json");
export const GLOBAL_STATE_BACKUP_PATH = `${GLOBAL_STATE_PATH}.bak`;

export interface StateSnapshot {
  main: string;
  backup: string | null;
  mainSha256: string;
  backupSha256: string | null;
  mode: number;
  backupMode: number | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readStateSnapshot(mainPath = GLOBAL_STATE_PATH, backupPath = `${mainPath}.bak`): StateSnapshot {
  if (!existsSync(mainPath)) throw new Error(`Global state file not found: ${mainPath}`);
  const main = readFileSync(mainPath, "utf8");
  let backup: string | null = null;
  try { backup = readFileSync(backupPath, "utf8"); } catch { /* optional */ }
  return {
    main,
    backup,
    mainSha256: sha256(main),
    backupSha256: backup === null ? null : sha256(backup),
    mode: statSync(mainPath).mode & 0o777,
    backupMode: backup === null ? null : statSync(backupPath).mode & 0o777,
  };
}

function parseEnvelope(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Global state must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function readMicroState(text = readFileSync(GLOBAL_STATE_PATH, "utf8")): Record<string, unknown> {
  const root = parseEnvelope(text);
  const atomState = root["electron-persisted-atom-state"];
  if (!atomState || typeof atomState !== "object" || Array.isArray(atomState)) return {};
  return atomState as Record<string, unknown>;
}

export function setUiUnlocked(mainPath = GLOBAL_STATE_PATH, backupPath = `${mainPath}.bak`): StateSnapshot {
  const before = readStateSnapshot(mainPath, backupPath);
  const root = parseEnvelope(before.main);
  const atom = root["electron-persisted-atom-state"];
  if (!atom || typeof atom !== "object" || Array.isArray(atom)) throw new Error("electron-persisted-atom-state is missing or invalid");
  const updated = { ...(atom as Record<string, unknown>), "codex-micro-has-ever-been-detected": true, "codex-micro-last-detected-device-model": "codex-micro" };
  root["electron-persisted-atom-state"] = updated;
  const next = `${JSON.stringify(root, null, 2)}\n`;
  writeAtomically(mainPath, next, before.mode);
  return before;
}

export function restoreState(snapshot: StateSnapshot, mainPath = GLOBAL_STATE_PATH, backupPath = `${mainPath}.bak`): void {
  writeAtomically(mainPath, snapshot.main, snapshot.mode);
  if (snapshot.backup === null) {
    try { unlinkSync(backupPath); } catch { /* optional */ }
  } else {
    writeAtomically(backupPath, snapshot.backup, snapshot.backupMode ?? snapshot.mode);
  }
}

export function readBackupSnapshot(destination: string): StateSnapshot {
  const mainPath = join(destination, "global-state.json");
  const backupPath = join(destination, "global-state.json.bak");
  if (!existsSync(mainPath)) throw new Error(`Backup snapshot not found: ${destination}`);
  const main = readFileSync(mainPath, "utf8");
  const backup = existsSync(backupPath) ? readFileSync(backupPath, "utf8") : null;
  return {
    main,
    backup,
    mainSha256: sha256(main),
    backupSha256: backup === null ? null : sha256(backup),
    mode: statSync(mainPath).mode & 0o777,
    backupMode: backup === null ? null : statSync(backupPath).mode & 0o777,
  };
}

export function backupState(destination: string, mainPath = GLOBAL_STATE_PATH, backupPath = `${mainPath}.bak`): string {
  const snapshot = readStateSnapshot(mainPath, backupPath);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "global-state.json"), snapshot.main, { mode: snapshot.mode });
  if (snapshot.backup !== null) writeFileSync(join(destination, "global-state.json.bak"), snapshot.backup, { mode: snapshot.backupMode ?? snapshot.mode });
  writeFileSync(join(destination, "manifest.json"), JSON.stringify({ mainSha256: snapshot.mainSha256, backupSha256: snapshot.backupSha256, mode: snapshot.mode, backupMode: snapshot.backupMode }, null, 2) + "\n");
  return destination;
}

function writeAtomically(target: string, content: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.microctl-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, target);
}
