import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Resolve everything relative to the app, regardless of Finder/Explorer's cwd.
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error("Please install Node.js 22.13 or newer (including npm), then launch again.");
  process.exit(1);
}
const require = createRequire(import.meta.url);
try {
  require.resolve("csv-parse");
  require.resolve("stream-json");
} catch {
  console.log("Installing app dependencies (internet access required)...");
  const installed = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/c", "npm ci"], { stdio: "inherit" })
    : spawnSync("npm", ["ci"], { stdio: "inherit" });
  if (installed.error || installed.status !== 0) {
    console.error("Dependency installation failed. Check your connection and that npm is installed.");
    process.exit(1);
  }
}
// The child receives Ctrl+C too; let it finish saving jobs and releasing its lock.
process.on("SIGINT", () => {});
const result = spawnSync(process.execPath, ["server.mjs", "--open"], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? (result.signal === "SIGINT" ? 0 : 1));
