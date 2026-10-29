#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const child = spawn("npx", ["--no-install", "tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("close", (code) => process.exit(code ?? 0));
