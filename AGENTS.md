# AGENTS

Scope: applies to the entire repository unless overridden in subdirectories.
Last updated: 2026-01-12

Principles
- Keep health endpoints fast and isolated from heavy work; do not relax healthchecks to hide load issues.
- Favor small, surgical changes consistent with existing style; avoid inline comments unless necessary.
- Load Whisper models at startup; never reload per request.

ASR (Python/FastAPI)
- Run uvicorn with multiple workers via `WEB_CONCURRENCY` (default 2) to keep one free for health.
- Limit per-worker transcribes with `MAX_TRANSCRIBE_WORKERS` (default 1) to prevent starvation.
- `/health` must stay lightweight and non-blocking; validate during long transcribes.

Bot (Bun/TypeScript)
- Use existing queue/concurrency patterns; honor `CONCURRENCY`, `MAX_QUEUE`, duration and size limits.
- Preserve ffmpeg flow (OGG/OPUS → WAV 16k mono) unless intentionally improving.

Testing & Ops
- For ASR changes: run a long transcribe while curling `/health`.
- For bot changes: run lint/tests in `bot/` when applicable.
- Do not commit secrets; `.env` remains untracked. Follow env defaults in README.

Docker/Compose
- Keep `WEB_CONCURRENCY` and `MAX_TRANSCRIBE_WORKERS` exposed and documented.
- Healthchecks must remain within current intervals/timeouts; prefer making endpoints responsive over loosening checks.
