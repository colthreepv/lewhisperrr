# AGENTS

Scope: applies to the entire repository unless overridden in subdirectories.
Last updated: 2026-01-12

Principles
- Keep health endpoints fast and isolated from heavy work; do not relax healthchecks to hide load issues.
- Favor small, surgical changes consistent with existing style; avoid inline comments unless necessary.
- Keep ElevenLabs requests bounded (queue + concurrency); avoid large in-memory buffering when possible.

Speech-to-Text (ElevenLabs)
- Use `scribe_v2` by default.
- Keep `/health` lightweight and non-blocking; do not call upstream from healthchecks.
- Handle upstream errors/rate limits cleanly and surface a generic user-facing failure message.

Bot (Bun/TypeScript)
- Use existing queue/concurrency patterns; honor `CONCURRENCY`, `MAX_QUEUE`, duration and size limits.
- Preserve ffmpeg flow (OGG/OPUS → WAV 16k mono) unless intentionally improving.

Testing & Ops
- For STT changes: run a long transcribe while curling `/health`.
- For bot changes: run lint/tests in `bot/` when applicable.
- Do not commit secrets; `.env` remains untracked. Follow env defaults in README.

Docker/Compose
- Keep `ELEVENLABS_TIMEOUT_MS`, `ELEVENLABS_RETRIES`, and `HEALTH_PORT` exposed and documented.
- Healthchecks must remain within current intervals/timeouts; prefer making endpoints responsive over loosening checks.
