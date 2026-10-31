// npm test: the unit suite under a hard memory cap and time limit. On Windows it runs inside a job object
// (scripts/run-capped.ps1), so a runaway test can't take the machine down; elsewhere it runs node --test directly.
// --test-timeout catches tests that hang on a promise; the job catches tests that loop or allocate without end.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 10 GB: a real ceiling for a runaway, well above anything the suite needs, and in line with what Zen itself uses
// with 20+ tabs open (the user's guidance).
const MEMORY_MB = 10240;
const TIMEOUT_SEC = 900;
const files = process.argv.length > 2 ? process.argv.slice(2) : ["test/unit/**/*.test.js"];
const nodeArgs = ["--test", "--test-timeout=120000", ...files];

const result = process.platform === "win32"
  ? spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./run-capped.ps1", import.meta.url)),
    "-MemoryMB", String(MEMORY_MB), "-TimeoutSec", String(TIMEOUT_SEC), "-ArgsJson", JSON.stringify(nodeArgs),
  ], { stdio: "inherit" })
  : spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });

process.exit(result.status ?? 1);
