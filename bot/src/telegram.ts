import type { Context } from 'grammy'
import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { oggToWav16kMono } from './audio'
import { CURRENT_MODEL_KEY, getEtaForKey, getTimingHintsForKey, recordJob } from './stats'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY ?? '').trim()
const ELEVENLABS_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID ?? 'scribe_v2').trim()
const ELEVENLABS_TAG_AUDIO_EVENTS = parseBool(process.env.ELEVENLABS_TAG_AUDIO_EVENTS, false)
const ELEVENLABS_DIARIZE = parseBool(process.env.ELEVENLABS_DIARIZE, false)
const ELEVENLABS_NUM_SPEAKERS_RAW = (process.env.ELEVENLABS_NUM_SPEAKERS ?? '').trim()
const ELEVENLABS_NUM_SPEAKERS = ELEVENLABS_NUM_SPEAKERS_RAW ? Number(ELEVENLABS_NUM_SPEAKERS_RAW) : undefined
const ELEVENLABS_TIMESTAMPS_GRANULARITY = (process.env.ELEVENLABS_TIMESTAMPS_GRANULARITY ?? 'none').trim()
const MAX_AUDIO_SECONDS_RAW = process.env.MAX_AUDIO_SECONDS
const MAX_AUDIO_SECONDS
  = MAX_AUDIO_SECONDS_RAW && Number(MAX_AUDIO_SECONDS_RAW) > 0
    ? Number(MAX_AUDIO_SECONDS_RAW)
    : undefined
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB ?? '20')
const LANGUAGE_HINT = (process.env.LANGUAGE_HINT ?? '').trim()
const ELEVENLABS_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS ?? '120000')
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = Number(process.env.TELEGRAM_DOWNLOAD_TIMEOUT_MS ?? String(ELEVENLABS_TIMEOUT_MS))
const ELEVENLABS_RETRIES = Number(process.env.ELEVENLABS_RETRIES ?? '2')
const ASR_TIMEOUT_MAX_MS = Number(process.env.ASR_TIMEOUT_MAX_MS ?? '1800000')
const DOWNLOAD_TIMEOUT_MAX_MS = Number(process.env.DOWNLOAD_TIMEOUT_MAX_MS ?? '600000')

const ASR_FALLBACK_MS_PER_AUDIO_SEC = 1200
const ASR_TIMEOUT_MULTIPLIER = 1.8
const ASR_TIMEOUT_BUFFER_MS = 15000
const DOWNLOAD_FALLBACK_MS_PER_MB = 1500
const DOWNLOAD_TIMEOUT_MULTIPLIER = 1.8
const DOWNLOAD_TIMEOUT_BUFFER_MS = 5000

export async function handleAudio(ctx: Context) {
  const message = ctx.message
  if (!message)
    return

  if (!ELEVENLABS_API_KEY)
    throw new Error('Missing ELEVENLABS_API_KEY')

  const voice = message.voice
  const audio = message.audio
  const document = message.document
  const video = message.video
  const videoNote = message.video_note

  const from = ctx.from
  console.warn('interaction', {
    userId: from?.id,
    username: from?.username ?? null,
    name: formatName(from?.first_name, from?.last_name),
    type: voice
      ? 'voice'
      : audio
        ? 'audio'
        : video
          ? 'video'
          : videoNote
            ? 'video_note'
            : document
              ? 'document'
              : 'unknown',
  })

  if (!voice && !audio && !document && !video && !videoNote)
    return

  if (document && !isAudioOrVideoDocument(document.mime_type, document.file_name)) {
    await ctx.reply('Please send a voice message, audio file, or video.')
    return
  }

  const duration
    = voice?.duration ?? audio?.duration ?? video?.duration ?? videoNote?.duration
  if (MAX_AUDIO_SECONDS && duration && duration > MAX_AUDIO_SECONDS) {
    await ctx.reply(`Too long (${duration}s). Max is ${MAX_AUDIO_SECONDS}s.`)
    return
  }

  const fileSize
    = voice?.file_size
      ?? audio?.file_size
      ?? video?.file_size
      ?? videoNote?.file_size
      ?? document?.file_size
      ?? 0
  const sizeMb = fileSize / (1024 * 1024)
  if (sizeMb > MAX_FILE_MB) {
    await ctx.reply(`Too big (${sizeMb.toFixed(1)}MB). Max is ${MAX_FILE_MB}MB.`)
    return
  }

  const fileId
    = voice?.file_id
      ?? audio?.file_id
      ?? video?.file_id
      ?? videoNote?.file_id
      ?? document?.file_id
  if (!fileId)
    return

  let etaMessage: string | null = null
  let timingHints: Awaited<ReturnType<typeof getTimingHintsForKey>> = null
  try {
    timingHints = await getTimingHintsForKey(CURRENT_MODEL_KEY)
    etaMessage = await getEtaForKey(CURRENT_MODEL_KEY, duration)
  }
  catch (error) {
    console.warn('eta lookup failed', error)
  }

  const intro = etaMessage
    ? `Got it! ${etaMessage} Please keep waiting!`
    : 'Got it! Transcribing now...'

  await ctx.reply(intro)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-asr-'))
  const jobStartedAt = Date.now()
  let downloadMs: number | undefined
  let ffmpegMs: number | undefined
  let asrMs: number | undefined

  try {
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path || !TELEGRAM_BOT_TOKEN) {
      throw new Error('Unable to resolve Telegram file URL')
    }

    const fileExtension = path.extname(file.file_path) || '.bin'
    const inputPath = path.join(tmp, `input${fileExtension}`)
    const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`

    console.warn('audio received', {
      type: voice
        ? 'voice'
        : audio
          ? 'audio'
          : video
            ? 'video'
            : videoNote
              ? 'video_note'
              : 'document',
      duration,
      sizeMb: Number(sizeMb.toFixed(2)),
    })

    const downloadTimeoutMs = estimateDownloadTimeoutMs(sizeMb, timingHints)
    const downloadStart = Date.now()
    const res = await fetchWithTimeout(url, downloadTimeoutMs)
    if (!res.ok)
      throw new Error(`download failed: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(inputPath, buf)
    downloadMs = Date.now() - downloadStart

    const ffmpegStart = Date.now()
    const wavPath = await oggToWav16kMono(inputPath, tmp)
    ffmpegMs = Date.now() - ffmpegStart

    const asrTimeoutMs = estimateAsrTimeoutMs(duration, timingHints)
    const asrStart = Date.now()
    const out = await transcribeElevenLabs(wavPath, asrTimeoutMs)
    asrMs = Date.now() - asrStart

    const text = out.text?.trim()

    const totalMs = Date.now() - jobStartedAt

    if (!text) {
      await recordJobSafe({
        success: true,
        totalMs,
        downloadMs,
        fileSizeMb: sizeMb,
        ffmpegMs,
        asrMs,
        audioSec: duration,
      })
      await ctx.reply('No speech detected.')
      return
    }

    await ctx.reply(text)
    await recordJobSafe({
      success: true,
      totalMs,
      downloadMs,
      fileSizeMb: sizeMb,
      ffmpegMs,
      asrMs,
      audioSec: duration,
    })
  }
  catch (error) {
    const totalMs = Date.now() - jobStartedAt
    const errorMessage = error instanceof Error ? error.message : String(error)

    console.error('transcription failed', error)
    await recordJobSafe({
      success: false,
      totalMs,
      downloadMs,
      fileSizeMb: sizeMb,
      ffmpegMs,
      asrMs,
      audioSec: duration,
      errorMessage,
    })
    await ctx.reply('Transcription failed. Please try again later.')
  }
  finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  retries: number,
) {
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs, options)
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`STT failed: ${res.status} ${t}`)
      }
      return res
    }
    catch (error) {
      lastError = error
      if (attempt < retries) {
        await delay(500 * (attempt + 1))
      }
    }
  }

  throw lastError
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options?: RequestInit,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  }
  finally {
    clearTimeout(timer)
  }
}

async function recordJobSafe(update: Parameters<typeof recordJob>[1]) {
  try {
    await recordJob(CURRENT_MODEL_KEY, update)
  }
  catch (error) {
    console.warn('stats update failed', error)
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatName(firstName?: string, lastName?: string) {
  const parts = [firstName, lastName].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

function isAudioOrVideoDocument(mimeType?: string, fileName?: string) {
  if (mimeType) {
    if (
      mimeType.startsWith('audio/')
      || mimeType.startsWith('video/')
      || mimeType === 'application/ogg'
    ) {
      return true
    }
  }

  if (fileName) {
    const lower = fileName.toLowerCase()
    return (
      lower.endsWith('.ogg')
      || lower.endsWith('.opus')
      || lower.endsWith('.mp4')
      || lower.endsWith('.mov')
      || lower.endsWith('.mkv')
      || lower.endsWith('.webm')
    )
  }

  return false
}

async function transcribeElevenLabs(wavPath: string, timeoutMs: number): Promise<{ text: string }> {
  const form = new FormData()
  form.set('model_id', ELEVENLABS_MODEL_ID)

  if (LANGUAGE_HINT)
    form.set('language_code', LANGUAGE_HINT)

  form.set('timestamps_granularity', ELEVENLABS_TIMESTAMPS_GRANULARITY)
  form.set('tag_audio_events', String(ELEVENLABS_TAG_AUDIO_EVENTS))
  form.set('diarize', String(ELEVENLABS_DIARIZE))
  if (Number.isFinite(ELEVENLABS_NUM_SPEAKERS as number))
    form.set('num_speakers', String(ELEVENLABS_NUM_SPEAKERS))

  // Let ElevenLabs detect the input type; we send WAV.
  form.set('file_format', 'other')

  const file = Bun.file(wavPath)
  form.set('file', file, 'audio.wav')

  const res = await fetchWithRetry(
    'https://api.elevenlabs.io/v1/speech-to-text',
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: form,
    },
    timeoutMs,
    ELEVENLABS_RETRIES,
  )

  const data = (await res.json()) as any
  const text = typeof data?.text === 'string' ? data.text : ''
  return { text }
}

function parseBool(value: string | undefined, defaultValue: boolean) {
  if (value === undefined)
    return defaultValue
  const v = value.trim().toLowerCase()
  if (!v)
    return defaultValue
  if (['1', 'true', 'yes', 'y', 'on'].includes(v))
    return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v))
    return false
  return defaultValue
}

function estimateAsrTimeoutMs(
  audioSec: number | undefined,
  hints: Awaited<ReturnType<typeof getTimingHintsForKey>>,
) {
  const fallbackRate = ASR_FALLBACK_MS_PER_AUDIO_SEC
  const learnedRate
    = hints && hints.asrRateJobs > 0 && hints.avgAsrMsPerAudioSec > 0
      ? hints.avgAsrMsPerAudioSec
      : fallbackRate

  if (!audioSec || audioSec <= 0)
    return ELEVENLABS_TIMEOUT_MS

  const estimatedMs
    = (audioSec * learnedRate * ASR_TIMEOUT_MULTIPLIER) + ASR_TIMEOUT_BUFFER_MS

  return clampTimeout(
    Math.max(ELEVENLABS_TIMEOUT_MS, estimatedMs),
    ELEVENLABS_TIMEOUT_MS,
    ASR_TIMEOUT_MAX_MS,
  )
}

function estimateDownloadTimeoutMs(
  fileSizeMb: number,
  hints: Awaited<ReturnType<typeof getTimingHintsForKey>>,
) {
  const fallbackRate = DOWNLOAD_FALLBACK_MS_PER_MB
  const learnedRate
    = hints && hints.downloadRateJobs > 0 && hints.avgDownloadMsPerMb > 0
      ? hints.avgDownloadMsPerMb
      : fallbackRate

  if (!Number.isFinite(fileSizeMb) || fileSizeMb <= 0)
    return TELEGRAM_DOWNLOAD_TIMEOUT_MS

  const estimatedMs
    = (fileSizeMb * learnedRate * DOWNLOAD_TIMEOUT_MULTIPLIER) + DOWNLOAD_TIMEOUT_BUFFER_MS

  return clampTimeout(
    Math.max(TELEGRAM_DOWNLOAD_TIMEOUT_MS, estimatedMs),
    TELEGRAM_DOWNLOAD_TIMEOUT_MS,
    DOWNLOAD_TIMEOUT_MAX_MS,
  )
}

function clampTimeout(value: number, min: number, max: number) {
  const safeMin = Number.isFinite(min) && min > 0 ? min : 120000
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin
  if (!Number.isFinite(value))
    return safeMin
  return Math.min(Math.max(value, safeMin), safeMax)
}
