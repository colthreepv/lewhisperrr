# Telegram Voice Transcriber Bot (Bun/TS + ElevenLabs Scribe v2)

[![pipeline status](https://gitlab.com/colthreepv/lewhisperrr/badges/main/pipeline.svg)](https://gitlab.com/colthreepv/lewhisperrr/-/pipelines)

A self-hosted Telegram bot that transcribes Telegram voice notes (OGG/OPUS) to text.
Uses ElevenLabs Speech-to-Text (Scribe v2) for fast, high-accuracy transcription.

## Architecture

- **Bot (Bun + TypeScript)**: Telegram updates, download audio, queue jobs, call ElevenLabs STT, reply to chat.
- **ffmpeg**: converts audio/video to WAV 16k mono before upload.

## MVP Features

- Voice message ingestion + transcription
- OGG → WAV conversion via `ffmpeg`
- In-memory job queue with CPU-friendly concurrency
- Safe limits (duration + file size)
- Stats summary via `/stats`
- Docker Compose deployment with cached models

## Phase 1 Hardening (included)

- Health endpoint in the bot
- STT request timeout + retry
- Max queue length with “busy” response
- Container healthcheck for the bot

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
├─ docker-compose.yml
└─ README.md
```

## Environment variables

Create `.env` (not committed):

### Bot
- `TELEGRAM_BOT_TOKEN` — required
- `ELEVENLABS_API_KEY` — required
- `ELEVENLABS_MODEL_ID` — default `scribe_v2`
- `ELEVENLABS_TIMESTAMPS_GRANULARITY` — default `none` (`none|word|character`)
- `ELEVENLABS_TAG_AUDIO_EVENTS` — default `false`
- `ELEVENLABS_DIARIZE` — default `false`
- `ELEVENLABS_NUM_SPEAKERS` — optional
- `MAX_AUDIO_SECONDS` — optional; unset = no limit; set seconds to cap
- `MAX_FILE_MB` — default `20`
- `LANGUAGE_HINT` — optional (empty = auto-detect)
- `CONCURRENCY` — default `1`
- `MAX_QUEUE` — default `20`
- `ELEVENLABS_TIMEOUT_MS` — default `120000` (used for Telegram download + ElevenLabs request)
- `ELEVENLABS_RETRIES` — default `2`
- `HEALTH_PORT` — default `3000`
- `STATS_PATH` — default `/data/stats.json` (persist if volume mounted)

## Container images

- `registry.gitlab.com/colthreepv/lewhisperrr/bot:latest`

## Deployment

1) Create a Telegram bot with BotFather and get the token.
2) Create `.env` with your config, e.g.:

```env
TELEGRAM_BOT_TOKEN=123:abc
ELEVENLABS_API_KEY=...your key...
ELEVENLABS_MODEL_ID=scribe_v2
LANGUAGE_HINT=it
# MAX_AUDIO_SECONDS=7200
MAX_FILE_MB=20
CONCURRENCY=1
MAX_QUEUE=20
ELEVENLABS_TIMEOUT_MS=120000
ELEVENLABS_RETRIES=2
HEALTH_PORT=3000
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

## Next upgrades (optional)

- Redis queue for persistence
- Allowlist of chat IDs
- Caching by audio hash
- Admin commands (`/status`, `/setlang`, `/setmodel`)
- Webhook mode behind reverse proxy
- Chunked upload/long-audio plan: `docs/plans/chunked-upload-epic.md`
