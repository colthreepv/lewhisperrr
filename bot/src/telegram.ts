import type { Context } from 'grammy'
import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { oggToWav16kMono } from './audio'
import { recordJob } from './stats'

const ASR_URL = process.env.ASR_URL ?? 'http://asr:8000'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS ?? '180')
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB ?? '20')
const LANGUAGE_HINT = (process.env.LANGUAGE_HINT ?? '').trim()
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS ?? '120000')
const ASR_RETRIES = Number(process.env.ASR_RETRIES ?? '2')

export async function handleAudio(ctx: Context) {
  const message = ctx.message
  if (!message)
    return

  const voice = message.voice
  const audio = message.audio
  const document = message.document
  const video = message.video
  const videoNote = message.video_note

  if (!voice && !audio && !document && !video && !videoNote)
    return

  if (document && !isAudioOrVideoDocument(document.mime_type, document.file_name)) {
    await ctx.reply('Please send a voice message, audio file, or video.')
    return
  }

  const duration
    = voice?.duration ?? audio?.duration ?? video?.duration ?? videoNote?.duration
  if (duration && duration > MAX_AUDIO_SECONDS) {
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

  await ctx.reply('Got it! Transcribing now...')

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

    const downloadStart = Date.now()
    const res = await fetchWithTimeout(url, ASR_TIMEOUT_MS)
    if (!res.ok)
      throw new Error(`download failed: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(inputPath, buf)
    downloadMs = Date.now() - downloadStart

    const ffmpegStart = Date.now()
    const wavPath = await oggToWav16kMono(inputPath, tmp)
    ffmpegMs = Date.now() - ffmpegStart

    const wavBytes = await fs.readFile(wavPath)

    const qp = new URLSearchParams()
    if (LANGUAGE_HINT)
      qp.set('language', LANGUAGE_HINT)

    const asrStart = Date.now()
    const asrRes = await fetchWithRetry(
      `${ASR_URL}/transcribe?${qp.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wavBytes,
      },
      ASR_RETRIES,
    )
    asrMs = Date.now() - asrStart

    const out = (await asrRes.json()) as {
      text: string
      language?: string
      duration_sec?: number
    }
    const text = out.text?.trim()

    const totalMs = Date.now() - jobStartedAt

    if (!text) {
      await recordJobSafe({
        success: true,
        totalMs,
        downloadMs,
        ffmpegMs,
        asrMs,
      })
      await ctx.reply('No speech detected.')
      return
    }

    await ctx.reply(text)
    await recordJobSafe({
      success: true,
      totalMs,
      downloadMs,
      ffmpegMs,
      asrMs,
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
      ffmpegMs,
      asrMs,
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
  retries: number,
) {
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, ASR_TIMEOUT_MS, options)
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`ASR failed: ${res.status} ${t}`)
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

async function recordJobSafe(update: Parameters<typeof recordJob>[0]) {
  try {
    await recordJob(update)
  }
  catch (error) {
    console.warn('stats update failed', error)
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
