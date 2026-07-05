import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type FootballMatchDirectResult = {
  handled: boolean;
  command?: "list" | "show" | "predict";
  messages: string[];
  skillDir?: string;
  handoffPrompt?: string;
};

type FootballMatchDirectCommand =
  | { type: "list" }
  | { type: "show"; run: string; model?: string }
  | { type: "predict"; query: string };

export async function handleFootballMatchDirectRequest(params: {
  text: string;
  cwd: string;
  allowBareIndex: boolean;
  maxChars?: number;
  onProgress?: (message: string) => Promise<void> | void;
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
      messages: [`找不到 football-match skill 目录，无法${command.type === "predict" ? "运行预测流程" : "读取历史预测文件"}。`],
    };
  }

  if (command.type === "predict") {
    return await runFootballMatchPrediction({
      skillDir,
      query: command.query,
      maxChars: params.maxChars,
      onProgress: params.onProgress,
    });
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

async function runFootballMatchPrediction(params: {
  skillDir: string;
  query: string;
  maxChars?: number;
  onProgress?: (message: string) => Promise<void> | void;
}): Promise<FootballMatchDirectResult> {
  const outputFile = path.join("runs", "latest-pipeline.json");
  const pipeline = await runFootballMatchNode(params.skillDir, [
    "scripts/run_pipeline.mjs",
    params.query,
    "--format",
    "json",
    "--stdout-file",
    outputFile,
    "--silent-stdout",
  ], {
    onProgress: params.onProgress,
  });
  const pipelineJsonPath = path.join(params.skillDir, outputFile);

  if (pipeline.code === 0) {
    await params.onProgress?.("预测流程已完成，正在生成最终合并分析");
    return {
      handled: true,
      command: "predict",
      skillDir: params.skillDir,
      messages: [],
      handoffPrompt: buildPredictionHandoffPrompt({
        skillDir: params.skillDir,
        pipelineJsonPath,
      }),
    };
  }

  const rendered = await runFootballMatchNode(params.skillDir, [
    "scripts/render_pipeline_result.mjs",
    "--input",
    outputFile,
    "--format",
    "json",
    "--max-chars",
    String(params.maxChars && params.maxChars >= 500 ? params.maxChars : 3500),
  ]);
  const messages = extractMessages(parseJsonLoose(rendered.stdout));

  if (rendered.code === 0 && messages.length) {
    return {
      handled: true,
      command: "predict",
      skillDir: params.skillDir,
      messages,
    };
  }

  return {
    handled: true,
    command: "predict",
    skillDir: params.skillDir,
    messages: [
      `football-match 预测流程失败：${sanitizeScriptError(rendered.stderr || rendered.stdout || pipeline.stderr || pipeline.stdout || "empty output")}`,
    ],
  };
}

function buildPredictionHandoffPrompt(params: {
  skillDir: string;
  pipelineJsonPath: string;
}): string {
  return [
    "足球预测流程已经由微信桥直连执行完成。现在只做最终展示和第五层合并分析。",
    "",
    "硬性要求：",
    "- 不要重新运行 run_pipeline.mjs。",
    "- 不要重新抓 source，不要重新跑 quant/intel/judge，不要联网搜索，不要使用记忆补充事实。",
    "- 只读取下面这个 pipeline JSON 和其中引用的 final/consensusPrompt：",
    `  ${params.pipelineJsonPath}`,
    "- 如果 JSON 中有 batch.results[]，按每场比赛分别汇总。",
    "- 对每个成功场次，优先使用该场的 consensusPrompt 作为第五层汇总依据；如果缺少 consensusPrompt，则读取 modelFinals[] / externalJudges.results[].finalPath 对应的 final Markdown 原文，只做同向与分歧汇总。",
    "- 第五层只总结各模型同向与分歧，不新增新闻、伤停、盘口事实、比分、概率或投注建议。",
    "- 输出用户可见 Markdown，不要输出 JSON、代码块、runDir、finalPath、stdout、stderr、后台进程文本或 Local OpenCode input。",
    "- 不要把多个比赛揉成一个判断；多场时按比赛分块展示。",
    "",
    "你可以读取文件，但最终只回复合并分析正文。",
  ].join("\n");
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

  if (isFootballMatchPredictionRequest(raw)) {
    return { type: "predict", query: raw };
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

function isFootballMatchPredictionRequest(raw: string): boolean {
  if (/历史预测|历史预测数据|历史预测记录|预测记录|历史结果|历史文件|列表|第\s*\d+\s*个/u.test(raw)) {
    return false;
  }
  const strongPrediction =
    /预测|重新预测|预判|胜平负|比分|亚盘|盘口|让球|大小球|角球|总进球/u.test(raw);
  const weakPrediction = /分析|判断|推荐|看好/u.test(raw);
  const matchScope =
    /世界杯|vs|VS|v\.?|matchId|matchid|\b\d{6,}\b|主队|客队/u.test(raw);
  const footballTopic = /足球/u.test(raw);
  const looseFootballScope = /比赛|球赛|对阵/u.test(raw);
  return (strongPrediction && (matchScope || looseFootballScope || footballTopic)) ||
    (weakPrediction && (matchScope || looseFootballScope));
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
    fs.existsSync(path.join(dir, "scripts", "show_run_final.mjs")) &&
    fs.existsSync(path.join(dir, "scripts", "run_pipeline.mjs")) &&
    fs.existsSync(path.join(dir, "scripts", "render_pipeline_result.mjs"));
}

function runFootballMatchNode(
  skillDir: string,
  args: string[],
  options: {
    onProgress?: (message: string) => Promise<void> | void;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.FOOTBALL_MATCH_NODE || process.execPath || "node", args, {
      cwd: skillDir,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const forwardProgress = createProgressForwarder(options.onProgress);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      forwardProgress(chunk);
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}` });
    });
    child.on("close", (code) => {
      forwardProgress("", true);
      forwardProgress.done().finally(() => resolve({ code, stdout, stderr }));
    });
  });
}

function createProgressForwarder(
  onProgress?: (message: string) => Promise<void> | void,
): ((chunk: string, flush?: boolean) => void) & { done: () => Promise<void> } {
  let buffer = "";
  let queue: Promise<void> = Promise.resolve();
  let lastMessage = "";
  const forward = ((chunk: string, flush = false) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/u);
    const ready = flush ? lines : lines.slice(0, -1);
    buffer = flush ? "" : (lines.at(-1) || "");
    for (const line of ready) {
      for (const message of extractFootballMatchProgressMessages(line)) {
        if (!message || message === lastMessage) {
          continue;
        }
        lastMessage = message;
        if (onProgress) {
          queue = queue.then(async () => {
            await onProgress(message);
          }).catch(() => {});
        }
      }
    }
  }) as ((chunk: string, flush?: boolean) => void) & { done: () => Promise<void> };
  forward.done = () => queue;
  return forward;
}

function extractFootballMatchProgressMessages(text: string): string[] {
  const messages: string[] = [];
  for (const line of String(text || "").split(/\r?\n/u)) {
    const markerIndex = line.indexOf("football-match-progress ");
    if (markerIndex < 0) {
      continue;
    }
    const rawJson = line.slice(markerIndex + "football-match-progress ".length).trim();
    const parsed = parseJsonLoose(rawJson);
    const message = isRecord(parsed) && typeof parsed.message === "string"
      ? parsed.message.replace(/\s+/g, " ").trim()
      : "";
    if (message) {
      messages.push(message.slice(0, 500));
    }
  }
  return messages;
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
