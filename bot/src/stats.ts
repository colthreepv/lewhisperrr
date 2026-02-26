import { promises as fs } from 'node:fs'
import path from 'node:path'

const STATS_PATH = '/data/stats.json'
const MODEL_NAME = 'scribe_v2'

export interface Stats {
  totalJobs: number
  successJobs: number
  failedJobs: number
  avgTotalMs: number
  avgDownloadMs: number
  avgDownloadMsPerMb: number
  downloadRateJobs: number
  avgFfmpegMs: number
  avgAsrMs: number
  avgAsrMsPerAudioSec: number
  asrRateJobs: number
  lastError: string | null
  lastJobAt: string | null
}

interface StatsFile {
  version: 2
  model: string
  stats: Stats
}

interface LegacyStatsFileV1 {
  version: 1
  models: Record<string, Partial<Stats>>
}

interface JobUpdate {
  success: boolean
  totalMs?: number
  downloadMs?: number
  fileSizeMb?: number
  ffmpegMs?: number
  asrMs?: number
  audioSec?: number
  errorMessage?: string
}

const defaultStats: Stats = {
  totalJobs: 0,
  successJobs: 0,
  failedJobs: 0,
  avgTotalMs: 0,
  avgDownloadMs: 0,
  avgDownloadMsPerMb: 0,
  downloadRateJobs: 0,
  avgFfmpegMs: 0,
  avgAsrMs: 0,
  avgAsrMsPerAudioSec: 0,
  asrRateJobs: 0,
  lastError: null,
  lastJobAt: null,
}

export const CURRENT_MODEL_KEY = `elevenlabs:${MODEL_NAME}`

let cachedStatsFile: StatsFile | null = null

function normalizeStats(input: Partial<Stats> | undefined) {
  return { ...defaultStats, ...(input ?? {}) }
}

function isStats(input: unknown): input is Partial<Stats> {
  return !!input && typeof input === 'object' && 'totalJobs' in input
}

async function loadStatsFile() {
  if (cachedStatsFile)
    return cachedStatsFile

  try {
    const raw = await fs.readFile(STATS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown

    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const withVersion = parsed as { version?: number }

      if (withVersion.version === 2) {
        const v2 = parsed as Partial<StatsFile>
        if (isStats(v2.stats)) {
          cachedStatsFile = {
            version: 2,
            model: typeof v2.model === 'string' && v2.model ? v2.model : CURRENT_MODEL_KEY,
            stats: normalizeStats(v2.stats),
          }
          return cachedStatsFile
        }
      }

      if (withVersion.version === 1 && 'models' in (parsed as any)) {
        const v1 = parsed as LegacyStatsFileV1
        const current = v1.models?.[CURRENT_MODEL_KEY]
        cachedStatsFile = {
          version: 2,
          model: CURRENT_MODEL_KEY,
          stats: normalizeStats(isStats(current) ? current : undefined),
        }
        await saveStatsFile(cachedStatsFile)
        return cachedStatsFile
      }
    }

    if (isStats(parsed)) {
      cachedStatsFile = {
        version: 2,
        model: CURRENT_MODEL_KEY,
        stats: normalizeStats(parsed),
      }
      await saveStatsFile(cachedStatsFile)
      return cachedStatsFile
    }
  }
  catch {
    // ignore and fall through to default
  }

  cachedStatsFile = {
    version: 2,
    model: CURRENT_MODEL_KEY,
    stats: normalizeStats(undefined),
  }
  return cachedStatsFile
}

async function saveStatsFile(statsFile: StatsFile) {
  await fs.mkdir(path.dirname(STATS_PATH), { recursive: true })
  await fs.writeFile(STATS_PATH, JSON.stringify(statsFile, null, 2))
}

function updateAverage(previous: number, count: number, value: number) {
  return previous + (value - previous) / count
}

function clampAudioSeconds(value: number) {
  if (!Number.isFinite(value))
    return null
  if (value <= 0)
    return null
  return value
}

function clampFileSizeMb(value: number) {
  if (!Number.isFinite(value))
    return null
  if (value <= 0)
    return null
  return value
}

export async function recordJob(_modelKey: string, update: JobUpdate) {
  const statsFile = await loadStatsFile()
  const stats = statsFile.stats

  stats.totalJobs += 1
  stats.lastJobAt = new Date().toISOString()

  if (update.success) {
    stats.successJobs += 1
    stats.lastError = null
  }
  else {
    stats.failedJobs += 1
    if (update.errorMessage)
      stats.lastError = update.errorMessage
  }

  if (update.totalMs !== undefined)
    stats.avgTotalMs = updateAverage(stats.avgTotalMs, stats.totalJobs, update.totalMs)

  if (update.downloadMs !== undefined) {
    stats.avgDownloadMs = updateAverage(
      stats.avgDownloadMs,
      stats.totalJobs,
      update.downloadMs,
    )

    if (update.fileSizeMb !== undefined) {
      const fileSizeMb = clampFileSizeMb(update.fileSizeMb)
      if (fileSizeMb !== null) {
        const rateMs = update.downloadMs / fileSizeMb
        stats.downloadRateJobs += 1
        stats.avgDownloadMsPerMb = updateAverage(
          stats.avgDownloadMsPerMb,
          stats.downloadRateJobs,
          rateMs,
        )
      }
    }
  }

  if (update.ffmpegMs !== undefined)
    stats.avgFfmpegMs = updateAverage(stats.avgFfmpegMs, stats.totalJobs, update.ffmpegMs)

  if (update.asrMs !== undefined)
    stats.avgAsrMs = updateAverage(stats.avgAsrMs, stats.totalJobs, update.asrMs)

  if (update.asrMs !== undefined && update.audioSec !== undefined) {
    const audioSec = clampAudioSeconds(update.audioSec)
    if (audioSec !== null) {
      const rateMs = update.asrMs / audioSec
      stats.asrRateJobs += 1
      stats.avgAsrMsPerAudioSec = updateAverage(
        stats.avgAsrMsPerAudioSec,
        stats.asrRateJobs,
        rateMs,
      )
    }
  }

  await saveStatsFile(statsFile)
}

export async function getStatsMessage() {
  const statsFile = await loadStatsFile()
  const stats = statsFile.stats

  if (!stats.totalJobs)
    return 'No transcriptions yet. Send a voice, audio, or video message.'

  const lines = [
    `${stats.totalJobs} total, ${stats.successJobs} ok, ${stats.failedJobs} failed`,
    `Avg: total ${formatMs(stats.avgTotalMs)}, download ${formatMs(stats.avgDownloadMs)} (${formatMs(stats.avgDownloadMsPerMb)}/MB), ffmpeg ${formatMs(stats.avgFfmpegMs)}, asr ${formatMs(stats.avgAsrMs)}, asr/sec ${formatMs(stats.avgAsrMsPerAudioSec)}`,
    `Last job: ${stats.lastJobAt ?? 'n/a'}`,
  ]

  if (stats.lastError)
    lines.push(`Last error: ${stats.lastError}`)

  return lines.join('\n')
}

export async function getEtaForKey(_modelKey: string, audioSec?: number) {
  const statsFile = await loadStatsFile()
  const stats = statsFile.stats

  if (!stats.totalJobs)
    return null

  const safeAudioSec = audioSec ? clampAudioSeconds(audioSec) : null
  if (safeAudioSec && stats.asrRateJobs > 0 && stats.avgAsrMsPerAudioSec > 0) {
    const estimatedMs = stats.avgAsrMsPerAudioSec * safeAudioSec
    return `Estimated time: ${formatMs(estimatedMs)}`
  }

  return `Recent average: ~${formatMs(stats.avgAsrMs)} (${stats.totalJobs} jobs)`
}

export async function getTimingHintsForKey(_modelKey: string) {
  const statsFile = await loadStatsFile()
  const stats = statsFile.stats

  return {
    avgAsrMsPerAudioSec: stats.avgAsrMsPerAudioSec,
    asrRateJobs: stats.asrRateJobs,
    avgDownloadMsPerMb: stats.avgDownloadMsPerMb,
    downloadRateJobs: stats.downloadRateJobs,
  }
}

export function getCurrentModelKey() {
  return CURRENT_MODEL_KEY
}

function formatMs(value: number) {
  if (!Number.isFinite(value) || value <= 0)
    return 'n/a'

  if (value >= 60_000)
    return `${(value / 60_000).toFixed(1)}m`

  return `${(value / 1000).toFixed(1)}s`
}
