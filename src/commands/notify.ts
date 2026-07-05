#!/usr/bin/env node

import { WeChatTransport } from "../wechat/wechat-transport.ts";

type NotifyArgs = {
  help: boolean;
  json: boolean;
  recipientId: string;
  stdin: boolean;
  messageParts: string[];
};

const transport = new WeChatTransport({
  log: (message) => process.stderr.write(`[wechat-notify] ${message}\n`),
  logError: (message) => process.stderr.write(`[wechat-notify] ERROR: ${message}\n`),
});

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    printJson({ ok: false, error: message });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const message = args.stdin
    ? (await readStdin()).trim()
    : args.messageParts.join(" ").trim();

  if (!message) {
    throw new Error("message is required. Pass text arguments or use --stdin.");
  }

  const recipientId = await transport.sendNotification(
    message,
    args.recipientId || undefined,
  );

  if (args.json) {
    printJson({ ok: true, recipientId, chars: Array.from(message).length });
  } else {
    process.stdout.write(`Sent message to ${recipientId}.\n`);
  }
}

function parseArgs(argv: string[]): NotifyArgs {
  const args: NotifyArgs = {
    help: false,
    json: false,
    recipientId: "",
    stdin: false,
    messageParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--stdin") {
      args.stdin = true;
    } else if (arg === "--recipient" || arg === "--recipient-id") {
      args.recipientId = argv[++i]?.trim() ?? "";
      if (!args.recipientId) {
        throw new Error(`${arg} requires a recipient id.`);
      }
    } else if (arg.startsWith("--recipient=")) {
      args.recipientId = arg.slice("--recipient=".length).trim();
    } else if (arg === "--") {
      args.messageParts.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.messageParts.push(arg);
    }
  }

  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  wechat-notify "message"
  echo "message" | wechat-notify --stdin
  wechat-notify --recipient <user@im.wechat> "message"

Sends a proactive plain-text WeChat notification using the bridge account and
cached conversation context. If --recipient is omitted, the most recently active
cached recipient is used.
`);
}
