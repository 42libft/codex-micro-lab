import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectElectronFuses } from "../src/lab-patch.js";

test("Electron fuse inspection decodes the sentinel wire", () => {
  const root = mkdtempSync(join(tmpdir(), "micro-fuses-"));
  const framework = join(root, "Contents", "Frameworks", "Codex Framework.framework", "Versions", "1.0");
  mkdirSync(framework, { recursive: true });
  const binary = Buffer.concat([
    Buffer.from("prefix", "ascii"),
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii"),
    Buffer.from([1, 9]),
    Buffer.from("101100011", "ascii"),
  ]);
  writeFileSync(join(framework, "Codex Framework"), binary);
  const result = inspectElectronFuses(root);
  assert.equal(result.available, true);
  assert.equal((result.fuses as Record<string, unknown>).onlyLoadAppFromAsar, false);
  assert.equal((result.fuses as Record<string, unknown>).embeddedAsarIntegrityValidation, false);
});
