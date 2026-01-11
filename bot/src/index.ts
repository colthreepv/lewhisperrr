import { Bot } from "grammy";
import { enqueue } from "./queue";
import { handleVoice } from "./telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const ASR_URL = process.env.ASR_URL ?? "http://asr:8000";
const ASR_STARTUP_RETRIES = Number(process.env.ASR_STARTUP_RETRIES ?? "20");
const ASR_STARTUP_DELAY_MS = Number(process.env.ASR_STARTUP_DELAY_MS ?? "1500");
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS ?? "120000");

const bot = new Bot(token);

bot.on("message:voice", async (ctx) => {
  const accepted = enqueue(() => handleVoice(ctx));
  if (!accepted) {
    await ctx.reply("I am busy right now. Please try again soon.");
  }
});

bot.catch((err) => console.error("bot error", err));

await waitForAsr();
await bot.start();
console.log("bot started");

const shutdown = async () => {
  console.log("shutting down bot");
  await bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function waitForAsr() {
  for (let attempt = 1; attempt <= ASR_STARTUP_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(`${ASR_URL}/health`, ASR_TIMEOUT_MS);
      if (res.ok) {
        console.log("ASR ready");
        return;
      }
      console.warn(`ASR health failed (${res.status}). Retrying...`);
    } catch (error) {
      console.warn("ASR not ready", error);
    }

    await delay(ASR_STARTUP_DELAY_MS);
  }

  throw new Error("ASR did not become ready in time");
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
