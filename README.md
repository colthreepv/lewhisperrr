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
- Safe limit (file size)
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

Everything else is intentionally fixed in code:
- Model: `scribe_v2`
- Health port: `3000`
- Stats path: `/data/stats.json`
- Queue defaults: concurrency `1`, max queue `20`
- Max input size: `20MB`

## Container images

- `registry.gitlab.com/colthreepv/lewhisperrr/bot:latest`

## Deployment

1) Create a Telegram bot with BotFather and get the token.
2) Create `.env` with your config, e.g.:

```env
TELEGRAM_BOT_TOKEN=123:abc
ELEVENLABS_API_KEY=...your key...
```

3) Run:

```bash
docker compose up -d --build
docker compose logs -f bot
```

Stats are stored at `/data/stats.json`. Mount `bot-stats` to persist across restarts.

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
