# Telegram Voice Transcriber Bot (Bun/TS + Whisper)

[![pipeline status](https://gitlab.com/colthreepv/lewhisperrr/badges/main/pipeline.svg)](https://gitlab.com/colthreepv/lewhisperrr/-/pipelines)

A self-hosted Telegram bot that transcribes Telegram voice notes (OGG/OPUS) to text.
Optimized for CPU-only mini-PCs (Ryzen 3300U works fine) and deployable with Docker Compose.

## Architecture

- **Bot (Bun + TypeScript)**: Telegram updates, download audio, queue jobs, reply to chat.
- **ASR service (Python + FastAPI)**: `faster-whisper` for fast CPU transcription.
- **ffmpeg**: converts OGG/OPUS to WAV 16k mono before ASR.

## MVP Features

- Voice message ingestion + transcription
- OGG → WAV conversion via `ffmpeg`
- In-memory job queue with CPU-friendly concurrency
- Safe limits (duration + file size)
- Stats summary via `/stats`
- Docker Compose deployment with cached models

## Phase 1 Hardening (included)

- ASR `/health` check on startup
- ASR request timeout + retry
- Max queue length with “busy” response
- Container healthcheck for ASR

## Supported media

- Voice messages
- Audio files
- Videos (audio extracted via ffmpeg)

## Repo layout

```
.
├─ bot/
│  ├─ src/
│  │  ├─ index.ts
│  │  ├─ queue.ts
│  │  ├─ telegram.ts
│  │  └─ audio.ts
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ Dockerfile
├─ asr/
│  ├─ app.py
│  ├─ requirements.txt
│  └─ Dockerfile
├─ docker-compose.yml
└─ README.md
```

## Environment variables

Create `.env` (not committed):

### Bot
- `TELEGRAM_BOT_TOKEN` — required
- `ASR_URL` — default `http://asr:8000`
- `MAX_AUDIO_SECONDS` — optional; unset = no limit; set seconds to cap
- `MAX_FILE_MB` — default `20`
- `LANGUAGE_HINT` — optional (empty = auto-detect)
- `CONCURRENCY` — default `1`
- `MAX_QUEUE` — default `20`
- `ASR_TIMEOUT_MS` — default `120000`
- `ASR_RETRIES` — default `2`
- `ASR_STARTUP_RETRIES` — default `20`
- `ASR_STARTUP_DELAY_MS` — default `1500`
- `STATS_PATH` — default `/data/stats.json` (persist if volume mounted)

### ASR
- `WHISPER_MODEL` — `base|small|medium|large-v3|large-v3-turbo` (default `small`)
- `DEVICE` — `cpu` (default)
- `COMPUTE_TYPE` — `int8` (default), `float32` (slow)

## Suggested model for Ryzen 3300U

- Start with `small + int8`
- Use `base + int8` if you want faster responses
- Avoid `large` on CPU unless latency doesn’t matter

## Container images

- `registry.gitlab.com/colthreepv/lewhisperrr/bot:latest`
- `registry.gitlab.com/colthreepv/lewhisperrr/asr:latest`

## Deployment

1) Create a Telegram bot with BotFather and get the token.
2) Create `.env` with your config, e.g.:

```env
TELEGRAM_BOT_TOKEN=123:abc
ASR_URL=http://asr:8000
WHISPER_MODEL=small
LANGUAGE_HINT=it
# MAX_AUDIO_SECONDS=7200
MAX_FILE_MB=20
CONCURRENCY=1
MAX_QUEUE=20
ASR_TIMEOUT_MS=120000
ASR_RETRIES=2
ASR_STARTUP_RETRIES=20
ASR_STARTUP_DELAY_MS=1500

DEVICE=cpu
COMPUTE_TYPE=int8
```

3) Run:

```bash
docker compose up -d --build
docker compose logs -f bot
```

Stats are stored at `STATS_PATH` (default `/data/stats.json`). Mount `bot-stats` to persist across restarts.

## Bot commands

- `/start` — welcome message
- `/help` — usage and supported media
- `/stats` — performance summary

## Linting

- `bun run lint` (from `bot/`) uses ESLint + Antfu config.
- `ruff check .` (from `asr/`) uses `asr/pyproject.toml`.

## ASR API

`POST /transcribe`
- Content-Type: `audio/wav` (raw bytes)
- Query params: `language` (optional), `task=transcribe|translate`

Response:
```json
{
  "text": "...",
  "language": "it",
  "duration_sec": 12.3
}
```

## Next upgrades (optional)

- Redis queue for persistence
- Allowlist of chat IDs
- Caching by audio hash
- Admin commands (`/status`, `/setlang`, `/setmodel`)
- Webhook mode behind reverse proxy
- Chunked upload/long-audio plan: `docs/plans/chunked-upload-epic.md`
