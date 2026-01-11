import type { Context } from "grammy";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { oggToWav16kMono } from "./audio";

const ASR_URL = process.env.ASR_URL ?? "http://asr:8000";
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS ?? "180");
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB ?? "20");
const LANGUAGE_HINT = (process.env.LANGUAGE_HINT ?? "").trim();
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS ?? "120000");
const ASR_RETRIES = Number(process.env.ASR_RETRIES ?? "2");

export async function handleVoice(ctx: Context) {
  const v = ctx.message?.voice;
  if (!v) return;

  if (v.duration && v.duration > MAX_AUDIO_SECONDS) {
    await ctx.reply(`Too long (${v.duration}s). Max is ${MAX_AUDIO_SECONDS}s.`);
    return;
  }

  const sizeMb = (v.file_size ?? 0) / (1024 * 1024);
  if (sizeMb > MAX_FILE_MB) {
    await ctx.reply(`Too big (${sizeMb.toFixed(1)}MB). Max is ${MAX_FILE_MB}MB.`);
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tg-asr-"));
  const oggPath = path.join(tmp, "audio.ogg");

  try {
    const file = await ctx.getFile();
    const url = file.getUrl();

    const res = await fetchWithTimeout(url, ASR_TIMEOUT_MS);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(oggPath, buf);

    const wavPath = await oggToWav16kMono(oggPath, tmp);
    const wavBytes = await fs.readFile(wavPath);

    const qp = new URLSearchParams();
    if (LANGUAGE_HINT) qp.set("language", LANGUAGE_HINT);

    const asrRes = await fetchWithRetry(
      `${ASR_URL}/transcribe?${qp.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wavBytes,
      },
      ASR_RETRIES,
    );

    const out = (await asrRes.json()) as {
      text: string;
      language?: string;
      duration_sec?: number;
    };
    const text = out.text?.trim();

    if (!text) {
      await ctx.reply("No speech detected.");
      return;
    }

    await ctx.reply(text);
  } catch (error) {
    console.error("transcription failed", error);
    await ctx.reply("Transcription failed. Please try again later.");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number,
) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, ASR_TIMEOUT_MS, options);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`ASR failed: ${res.status} ${t}`);
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(500 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options?: RequestInit,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
