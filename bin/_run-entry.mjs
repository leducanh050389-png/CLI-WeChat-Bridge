#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BIN_DIR, "..");

export function runJsEntry(relativeEntryPath, extraArgs = []) {
  const resolved = resolveRuntimeEntry(relativeEntryPath);
  const child = spawn(
    process.execPath,
    [...resolved.nodeArgs, resolved.entryPath, ...extraArgs, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    },
  );

  child.once("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function resolveRuntimeEntry(relativeEntryPath) {
  const distEntryPath = path.join(PROJECT_DIR, relativeEntryPath);
  const sourceEntryPath = path.join(
    PROJECT_DIR,
    relativeEntryPath.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"),
  );

  if (shouldRunSourceEntry(sourceEntryPath, distEntryPath)) {
    return {
      entryPath: sourceEntryPath,
      nodeArgs: ["--no-warnings", "--experimental-strip-types"],
    };
  }

  return { entryPath: distEntryPath, nodeArgs: [] };
}

function shouldRunSourceEntry(sourceEntryPath, distEntryPath) {
  if (!fs.existsSync(sourceEntryPath)) {
    return false;
  }
  if (!fs.existsSync(distEntryPath)) {
    return true;
  }
  try {
    return fs.statSync(sourceEntryPath).mtimeMs > fs.statSync(distEntryPath).mtimeMs;
  } catch {
    return true;
  }
}
