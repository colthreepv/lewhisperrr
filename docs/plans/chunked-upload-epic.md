# Chunked upload / long-audio epic

Purpose: enable safe handling of very long audio/files without a hard duration cap, by chunking and stitching transcripts.

## Current state
- No duration cap enforced by default (env `MAX_AUDIO_SECONDS` opt-in).
- Single-file processing path; assumes manageable duration/size.

## Goals
- Support hours-long audio with server-friendly resource use.
- Provide progress feedback to users while processing.
- Preserve transcript ordering and timestamps.

## Workstreams
1) **Chunking strategy**: split on duration/size; ensure overlap for context; pick default chunk length; handle stereo to mono conversion efficiently.
2) **Assembly**: merge partial transcripts; optionally attach timestamps per chunk; consider punctuation smoothing across boundaries.
3) **Queue/backpressure**: protect ASR throughput; consider Redis/out-of-process queue; tune concurrency per chunk.
4) **User experience**: streaming or incremental replies in Telegram; fallback message when exceeding queue/backoff.
5) **Config & limits**: reintroduce optional caps (duration/size) once chunking exists; expose per-chunk settings.
6) **Observability**: record per-chunk metrics and overall job metrics; surface in `/stats`.
7) **Testing**: add fixtures for long inputs; load-test CPU path with chosen models.

## Open questions
- Target maximum duration/size to support by default?
- Accept slight latency increase for better accuracy (larger overlap) or optimize for speed?
- Need language-aware chunk sizing (e.g., tonal languages)?

## Definition of done
- Long audio (e.g., 2h) completes without OOM on CPU-only host.
- Transcripts ordered correctly with minimal boundary artifacts.
- Metrics and UX updated to reflect chunked processing.
