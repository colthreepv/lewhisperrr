I’ll draft a compact project README (Markdown) with architecture, steps, and ops notes, plus a Bun/TS implementation plan and a docker-compose + Dockerfile setup you can deploy on your mini-PC.


Below is a “software project” Markdown you can drop into `README.md` plus the Docker bits. It’s Bun + TypeScript, long-polling (no webhook drama), `grammy` for Telegram, `faster-whisper` in a sidecar Python service (because **Whisper tooling + performance is way better in Python**). Bun stays your main app, Python is “ASR microservice”.

This design keeps your TS comfort while avoiding the “install CUDA, compile weird deps, cry” path.

---

```markdown
# Telegram Voice Transcriber Bot (Bun/TS + Whisper)

A self-hosted Telegram bot that transcribes Telegram voice notes (OGG/OPUS) to text.
Runs on a mini-PC (CPU-only fine), deployable with Docker Compose.

## Why this architecture

- **Bun/TypeScript** for the bot logic, queueing, Telegram API, state.
- **Python ASR sidecar** using `faster-whisper` (CTranslate2) for:
  - best CPU performance
  - simplest model management
  - mature audio/transcription ecosystem
- `ffmpeg` used to convert Telegram OGG/OPUS → WAV 16k mono.

This keeps your main code in JS/TS while using the best available ASR stack.

---

## Features (MVP)

- Receive Telegram voice messages
- Download audio from Telegram
- Convert to WAV 16k mono
- Send to ASR service → get transcription
- Reply in chat with text
- Basic job queue to avoid CPU thrash
- Configurable model size + language hint
- Safe limits (max audio duration, file size)

---

## Tech stack

- Bot: **Bun + TypeScript**
  - Telegram framework: `grammy`
  - HTTP client: `fetch` (built-in)
  - Queue: simple in-memory worker (MVP)
- ASR: **Python + FastAPI**
  - `faster-whisper`
- Infra:
  - `docker-compose`
  - persistent volume for models cache

---

## Repository layout

```

.
├─ bot/
│  ├─ src/
│  │  ├─ index.ts          # entrypoint
│  │  ├─ queue.ts          # simple worker queue
│  │  ├─ telegram.ts       # handlers
│  │  └─ audio.ts          # ffmpeg conversion helpers
│  ├─ package.json
│  ├─ bun.lockb
│  ├─ tsconfig.json
│  └─ Dockerfile
├─ asr/
│  ├─ app.py               # FastAPI server
│  ├─ requirements.txt
│  └─ Dockerfile
├─ docker-compose.yml
└─ README.md

````

---

## Environment variables

Create `.env` (not committed):

### Bot
- `TELEGRAM_BOT_TOKEN` — required
- `ASR_URL` — default `http://asr:8000`
- `MAX_AUDIO_SECONDS` — default `180` (3 min)
- `MAX_FILE_MB` — default `20`
- `LANGUAGE_HINT` — optional: `it`, `en`, etc (empty = auto-detect)
- `WHISPER_MODEL` — `base|small|medium|large-v3|large-v3-turbo` (default `small`)
- `CONCURRENCY` — bot job workers (default `1` for CPU boxes)

### ASR
- `WHISPER_MODEL` — same as above (compose wires it)
- `DEVICE` — `cpu` (default)
- `COMPUTE_TYPE` — `int8` (default good on CPU), alternatives: `int8_float16`, `float16` (GPU), `float32` (slow)

---

## How it works (flow)

1. Telegram sends voice message update
2. Bot downloads file via Telegram File API (OGG/OPUS)
3. Bot converts to WAV:
   - `ffmpeg -i input.ogg -ac 1 -ar 16000 -f wav output.wav`
4. Bot POSTs WAV bytes to ASR service: `/transcribe`
5. ASR returns JSON `{ text, language, segments? }`
6. Bot replies with text + optional metadata

---

## Model choice guidance (CPU mini-PC)

- Start with **`small` + `int8`** (best tradeoff)
- If CPU is weak: `base + int8`
- If you want higher quality and can tolerate latency: `medium + int8`
- `large-v3(-turbo)` on CPU is usually “eh” unless your CPU is beefy or you don’t care about delay.

---

## Deployment

### 1) Create bot with BotFather
Get `TELEGRAM_BOT_TOKEN`.

### 2) Configure `.env`
Example:

```env
TELEGRAM_BOT_TOKEN=123:abc
ASR_URL=http://asr:8000
WHISPER_MODEL=small
LANGUAGE_HINT=it
MAX_AUDIO_SECONDS=180
MAX_FILE_MB=20
CONCURRENCY=1

DEVICE=cpu
COMPUTE_TYPE=int8
````

### 3) Run

```bash
docker compose up -d --build
docker compose logs -f bot
```

---

## Security / sanity limits (recommended)

* Reject audio > `MAX_AUDIO_SECONDS`
* Reject size > `MAX_FILE_MB`
* Single worker on CPU to prevent meltdown
* Consider chat allowlist (optional) if you expose it widely

---

## Future upgrades

* Add Redis queue for persistence + multiple workers
* Add diarization (speaker separation)
* Add “translate to English” mode (Whisper supports translate)
* Add caching (hash audio → reuse transcription)
* Add admin commands: `/status`, `/setlang`, `/setmodel`
* Add webhook mode behind reverse proxy (Caddy/Traefik)

---

## API contract: ASR service

### `POST /transcribe`

* Content-Type: `audio/wav` (raw bytes) OR `multipart/form-data`
* Query params:

  * `language` (optional)
  * `task` = `transcribe|translate` (default `transcribe`)

Response:

```json
{
  "text": "…",
  "language": "it",
  "duration_sec": 12.3
}
```

````

---

## `docker-compose.yml`

```yaml
services:
  asr:
    build:
      context: ./asr
    environment:
      - WHISPER_MODEL=${WHISPER_MODEL:-small}
      - DEVICE=${DEVICE:-cpu}
      - COMPUTE_TYPE=${COMPUTE_TYPE:-int8}
    volumes:
      - whisper-cache:/root/.cache
    ports:
      - "8000:8000"
    restart: unless-stopped

  bot:
    build:
      context: ./bot
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - ASR_URL=${ASR_URL:-http://asr:8000}
      - WHISPER_MODEL=${WHISPER_MODEL:-small}
      - LANGUAGE_HINT=${LANGUAGE_HINT:-}
      - MAX_AUDIO_SECONDS=${MAX_AUDIO_SECONDS:-180}
      - MAX_FILE_MB=${MAX_FILE_MB:-20}
      - CONCURRENCY=${CONCURRENCY:-1}
    depends_on:
      - asr
    restart: unless-stopped

volumes:
  whisper-cache:
````

---

## `asr/Dockerfile`

```dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

## `asr/requirements.txt`

```txt
fastapi==0.115.0
uvicorn[standard]==0.30.6
faster-whisper==1.0.3
python-multipart==0.0.9
```

## `asr/app.py`

```python
import os
import time
from fastapi import FastAPI, Request, HTTPException
from faster_whisper import WhisperModel

app = FastAPI()

MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")

model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)

@app.get("/health")
def health():
  return {"ok": True, "model": MODEL_NAME, "device": DEVICE, "compute_type": COMPUTE_TYPE}

@app.post("/transcribe")
async def transcribe(request: Request):
  # Expect raw WAV bytes (Content-Type: audio/wav)
  body = await request.body()
  if not body:
    raise HTTPException(status_code=400, detail="empty body")

  # Write to temp file (fast & simple)
  import tempfile
  t0 = time.time()
  with tempfile.NamedTemporaryFile(suffix=".wav") as f:
    f.write(body)
    f.flush()

    segments, info = model.transcribe(
      f.name,
      language=request.query_params.get("language") or None,
      task=request.query_params.get("task") or "transcribe",
      vad_filter=True
    )

    text = "".join([seg.text for seg in segments]).strip()

  return {
    "text": text,
    "language": info.language,
    "duration_sec": round(time.time() - t0, 3)
  }
```

---

## `bot/Dockerfile`

```dockerfile
FROM oven/bun:1.1.45

# ffmpeg for audio conversion
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lockb tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src

CMD ["bun", "run", "start"]
```

## `bot/package.json`

```json
{
  "name": "tg-voice-transcriber",
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts"
  },
  "dependencies": {
    "grammy": "^1.35.0"
  }
}
```

## `bot/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

## `bot/src/index.ts`

```ts
import { Bot } from "grammy";
import { enqueue } from "./queue";
import { handleVoice } from "./telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const bot = new Bot(token);

bot.on("message:voice", (ctx) =>
  enqueue(() => handleVoice(ctx)).catch((e) => {
    console.error("job failed", e);
  })
);

bot.catch((err) => console.error("bot error", err));

await bot.start();
console.log("bot started");
```

## `bot/src/queue.ts`

```ts
const concurrency = Number(process.env.CONCURRENCY ?? "1");
let running = 0;
const q: Array<() => Promise<void>> = [];

export async function enqueue(job: () => Promise<void>) {
  q.push(job);
  pump();
}

async function pump() {
  while (running < concurrency && q.length) {
    const job = q.shift()!;
    running++;
    job()
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}
```

## `bot/src/audio.ts`

```ts
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function oggToWav16kMono(inputOgg: string, outDir: string) {
  const outWav = path.join(outDir, `${path.basename(inputOgg)}.wav`);

  await fs.mkdir(outDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-y",
      "-i", inputOgg,
      "-ac", "1",
      "-ar", "16000",
      "-f", "wav",
      outWav
    ]);

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr}`));
    });
  });

  return outWav;
}
```

## `bot/src/telegram.ts`

```ts
import type { Context } from "grammy";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { oggToWav16kMono } from "./audio";

const ASR_URL = process.env.ASR_URL ?? "http://asr:8000";
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS ?? "180");
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB ?? "20");
const LANGUAGE_HINT = (process.env.LANGUAGE_HINT ?? "").trim();

export async function handleVoice(ctx: Context) {
  const v = ctx.message?.voice;
  if (!v) return;

  if (v.duration && v.duration > MAX_AUDIO_SECONDS) {
    await ctx.reply(`Too long (${v.duration}s). Max is ${MAX_AUDIO_SECONDS}s.`);
    return;
  }

  // Telegram gives size in bytes
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

    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(oggPath, buf);

    const wavPath = await oggToWav16kMono(oggPath, tmp);
    const wavBytes = await fs.readFile(wavPath);

    const qp = new URLSearchParams();
    if (LANGUAGE_HINT) qp.set("language", LANGUAGE_HINT);

    const asrRes = await fetch(`${ASR_URL}/transcribe?${qp.toString()}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wavBytes
    });

    if (!asrRes.ok) {
      const t = await asrRes.text().catch(() => "");
      throw new Error(`ASR failed: ${asrRes.status} ${t}`);
    }

    const out = await asrRes.json() as { text: string; language?: string; duration_sec?: number };
    const text = out.text?.trim();

    if (!text) {
      await ctx.reply("No speech detected.");
      return;
    }

    await ctx.reply(text);
  } finally {
    // best-effort cleanup
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
```

---

### Why not “all in TS”?

You *can* call Whisper from Node, but the reliable + fast CPU path is still overwhelmingly better in Python (`faster-whisper` is a monster). Splitting it into a sidecar keeps TS clean and the ASR swappable.

### Optional upgrade I recommend even for MVP

Persist the queue with Redis so a container restart doesn’t drop jobs. But the above will work fine for personal use.

If you paste your mini-PC CPU model (and whether it’s got any NVIDIA GPU), I’ll tell you the best `WHISPER_MODEL` + `COMPUTE_TYPE` combo and expected latency class.
