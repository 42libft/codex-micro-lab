import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupState, readMicroState, readBackupSnapshot, restoreState, setUiUnlocked } from "../src/state.js";

test("UI state enable and restore are byte-reversible", () => {
  const dir = mkdtempSync(join(tmpdir(), "micro-state-test-"));
  const main = join(dir, "global.json");
  const backup = join(dir, "global.json.bak");
  const original = JSON.stringify({ "electron-persisted-atom-state": { unrelated: 1 } }, null, 2) + "\n";
  const originalBackup = JSON.stringify({ stale: true }) + "\n";
  writeFileSync(main, original, { mode: 0o600 });
  writeFileSync(backup, originalBackup, { mode: 0o640 });
  const snapshotPath = join(dir, "snapshot");
  backupState(snapshotPath, main, backup);
  setUiUnlocked(main, backup);
  assert.equal(readMicroState(readFileSync(main, "utf8"))["codex-micro-has-ever-been-detected"], true);
  restoreState(readBackupSnapshot(snapshotPath), main, backup);
  assert.equal(readFileSync(main, "utf8"), original);
  assert.equal(readFileSync(backup, "utf8"), originalBackup);
  assert.equal(statSync(main).mode & 0o777, 0o600);
  assert.equal(statSync(backup).mode & 0o777, 0o640);
});

test("UI state refuses malformed or unexpected schemas", () => {
  const dir = mkdtempSync(join(tmpdir(), "micro-state-invalid-"));
  const main = join(dir, "global.json");
  writeFileSync(main, "{broken");
  assert.throws(() => setUiUnlocked(main), /JSON/);
  writeFileSync(main, JSON.stringify({ other: {} }));
  assert.throws(() => setUiUnlocked(main), /electron-persisted-atom-state/);
});
