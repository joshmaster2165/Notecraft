// Build the `notecraft` CLI (and MCP server) and put it where Tauri bundles
// sidecar binaries: src-tauri/binaries/notecraft-<target triple>[.exe].
// Usage: node scripts/sidecar.mjs [--target <triple>]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--target");
const target = i >= 0 ? args[i + 1] : process.env.TAURI_ENV_TARGET_TRIPLE || /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
const exe = target.includes("windows") ? ".exe" : "";

execFileSync("cargo", ["build", "-p", "notecraft-cli", "--release", "--target", target], { cwd: root, stdio: "inherit" });
const from = join(root, "..", "target", target, "release", `notecraft${exe}`);
const to = join(root, "src-tauri", "binaries", `notecraft-${target}${exe}`);
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
if (!exe) chmodSync(to, 0o755);
console.log(`sidecar: ${to}`);
