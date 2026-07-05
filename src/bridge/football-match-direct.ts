import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type FootballMatchDirectResult = {
  handled: boolean;
  command?: "list" | "show";
  messages: string[];
  skillDir?: string;
};

type FootballMatchDirectCommand =
  | { type: "list" }
  | { type: "show"; run: string; model?: string };

export async function handleFootballMatchDirectRequest(params: {
  text: string;
  cwd: string;
  allowBareIndex: boolean;
  maxChars?: number;
}): Promise<FootballMatchDirectResult> {
  const command = parseFootballMatchDirectCommand(params.text, {
    allowBareIndex: params.allowBareIndex,
  });
  if (!command) {
    return { handled: false, messages: [] };
  }

  const skillDir = resolveFootballMatchSkillDir(params.cwd);
  if (!skillDir) {
    return {
      handled: true,
      command: command.type,
      messages: ["找不到 football-match skill 目录，无法读取历史预测文件。"],
    };
  }

  const args = command.type === "list"
    ? ["scripts/list_run_finals.mjs", "--format", "json", "--limit", "20"]
    : [
        "scripts/show_run_final.mjs",
        "--run",
        command.run,
        "--format",
        "json",
        "--max-chars",
        String(params.maxChars && params.maxChars >= 500 ? params.maxChars : 3500),
        ...(command.model ? ["--model", command.model] : []),
      ];

  const result = await runFootballMatchNode(skillDir, args);
  const parsed = parseJsonLoose(result.stdout);
  const messages = extractMessages(parsed);
  if (result.code === 0 && messages.length) {
    return {
      handled: true,
      command: command.type,
      skillDir,
      messages,
    };
  }

  return {
    handled: true,
    command: command.type,
    skillDir,
    messages: [
      `football-match 历史文件脚本失败：${sanitizeScriptError(result.stderr || result.stdout || "empty output")}`,
    ],
  };
}

function parseFootballMatchDirectCommand(
  text: string,
  options: { allowBareIndex: boolean },
): FootballMatchDirectCommand | null {
  const raw = normalizeText(text);
  if (!raw) {
    return null;
  }

  if (isHistoryListRequest(raw)) {
    return { type: "list" };
  }

  const show = raw.match(/^(?:看|查看|发|发送|读|读取|打开)?\s*(?:第\s*)?(\d+)(?:\s*个)?(?:\s*[,，、 ]\s*(.+?))?$/u);
  if (!show) {
    return null;
  }

  const run = show[1] || "";
  const model = normalizeModelSelector(show[2] || "");
  const hasExplicitShowWord = /^(?:看|查看|发|发送|读|读取|打开)|第\s*\d+/u.test(raw);
  if (!model && !hasExplicitShowWord && !options.allowBareIndex) {
    return null;
  }
  return model ? { type: "show", run, model } : { type: "show", run };
}

function isHistoryListRequest(raw: string): boolean {
  return /历史预测|历史预测数据|历史预测记录|预测记录|历史结果|历史文件|列出.*历史|历史.*列表|run\s*列表|final\s*列表|文件列表/u.test(raw);
}

function normalizeText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeModelSelector(value: string): string {
  return String(value || "")
    .replace(/模型|结果|final|文件|原文|完整|的/giu, " ")
    .replace(/[，,。；;：:]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveFootballMatchSkillDir(cwd: string): string {
  const home = os.homedir();
  const candidates = [
    process.env.FOOTBALL_MATCH_SKILL_DIR || "",
    cwd,
    path.join(cwd, "football-match"),
    path.join(home, ".config", "opencode", "skills", "football-match"),
    path.join(home, ".hermes", "skills", "football-match"),
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (isFootballMatchSkillDir(resolved)) {
      return resolved;
    }
  }
  return "";
}

function isFootballMatchSkillDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "scripts", "list_run_finals.mjs")) &&
    fs.existsSync(path.join(dir, "scripts", "show_run_final.mjs"));
}

function runFootballMatchNode(
  skillDir: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.FOOTBALL_MATCH_NODE || process.execPath || "node", args, {
      cwd: skillDir,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}` });
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonLoose(text: string): unknown {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractMessages(parsed: unknown): string[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    return [];
  }
  return parsed.messages
    .map((message) => isRecord(message) && typeof message.content === "string" ? message.content.trim() : "")
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeScriptError(value: string): string {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [hidden-key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
