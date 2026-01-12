import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const STATS_PATH = process.env.STATS_PATH ?? '/data/stats.json'
const MODEL_NAME = process.env.WHISPER_MODEL ?? 'small'
const COMPUTE_TYPE = process.env.COMPUTE_TYPE ?? 'int8'

export interface Stats {
  totalJobs: number
  successJobs: number
  failedJobs: number
  avgTotalMs: number
  avgDownloadMs: number
  avgFfmpegMs: number
  avgAsrMs: number
  lastError: string | null
  lastJobAt: string | null
}

interface StatsFile {
  version: 1
  models: Record<string, Stats>
}

interface JobUpdate {
  success: boolean
  totalMs?: number
  downloadMs?: number
  ffmpegMs?: number
  asrMs?: number
  errorMessage?: string
}

const defaultStats: Stats = {
  totalJobs: 0,
  successJobs: 0,
  failedJobs: 0,
  avgTotalMs: 0,
  avgDownloadMs: 0,
  avgFfmpegMs: 0,
  avgAsrMs: 0,
  lastError: null,
  lastJobAt: null,
}

const defaultStatsFile: StatsFile = {
  version: 1,
  models: {},
}

export const CURRENT_MODEL_KEY = buildModelKey(MODEL_NAME, COMPUTE_TYPE)

let cachedStatsFile: StatsFile | null = null

function buildModelKey(model: string, computeType: string) {
  return `${model}|${computeType}`
}

function formatModelKey(key: string) {
  const [model, compute] = key.split('|')
  return compute ? `${model} (${compute})` : model
}

function normalizeStats(input: Partial<Stats> | undefined) {
  return { ...defaultStats, ...(input ?? {}) }
}

function isLegacyStats(raw: unknown): raw is Stats {
  return !!raw && typeof raw === 'object' && 'totalJobs' in raw
}

async function loadStatsFile() {
  if (cachedStatsFile)
    return cachedStatsFile

  try {
    const raw = await fs.readFile(STATS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown

    if (parsed && typeof parsed === 'object' && 'models' in parsed) {
      const file = parsed as StatsFile
      const models: Record<string, Stats> = {}
      for (const [key, value] of Object.entries(file.models ?? {})) {
        models[key] = normalizeStats(value as Partial<Stats>)
      }
      cachedStatsFile = { version: 1, models }
      return cachedStatsFile
    }

    if (isLegacyStats(parsed)) {
      cachedStatsFile = {
        version: 1,
        models: { [CURRENT_MODEL_KEY]: normalizeStats(parsed) },
      }
      return cachedStatsFile
    }
  }
  catch {
    // ignore and fall through to default
  }

  cachedStatsFile = { ...defaultStatsFile }
  return cachedStatsFile
}

async function saveStatsFile(statsFile: StatsFile) {
  await fs.mkdir(path.dirname(STATS_PATH), { recursive: true })
  await fs.writeFile(STATS_PATH, JSON.stringify(statsFile, null, 2))
}

function updateAverage(previous: number, count: number, value: number) {
  return previous + (value - previous) / count
}

function ensureModel(statsFile: StatsFile, modelKey: string) {
  if (!statsFile.models[modelKey])
    statsFile.models[modelKey] = normalizeStats(undefined)
}

export async function recordJob(modelKey: string, update: JobUpdate) {
  const statsFile = await loadStatsFile()
  ensureModel(statsFile, modelKey)

  const stats = statsFile.models[modelKey]

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
  }

  if (update.ffmpegMs !== undefined)
    stats.avgFfmpegMs = updateAverage(stats.avgFfmpegMs, stats.totalJobs, update.ffmpegMs)

  if (update.asrMs !== undefined)
    stats.avgAsrMs = updateAverage(stats.avgAsrMs, stats.totalJobs, update.asrMs)

  await saveStatsFile(statsFile)
}

export async function getStatsMessage() {
  const statsFile = await loadStatsFile()
  const entries = Object.entries(statsFile.models).filter(([, stats]) => stats.totalJobs > 0)

  if (!entries.length)
    return 'No transcriptions yet. Send a voice, audio, or video message.'

  const sections = entries.map(([key, stats]) => {
    const lines = [
      `${formatModelKey(key)}: ${stats.totalJobs} total, ${stats.successJobs} ok, ${stats.failedJobs} failed`,
      `Avg: total ${formatMs(stats.avgTotalMs)}, download ${formatMs(stats.avgDownloadMs)}, ffmpeg ${formatMs(stats.avgFfmpegMs)}, asr ${formatMs(stats.avgAsrMs)}`,
      `Last job: ${stats.lastJobAt ?? 'n/a'}`,
    ]

    if (stats.lastError)
      lines.push(`Last error: ${stats.lastError}`)

    return lines.join('\n')
  })

  return sections.join('\n\n')
}

export async function getEtaForKey(modelKey: string) {
  const statsFile = await loadStatsFile()
  const stats = statsFile.models[modelKey]

  if (!stats || stats.totalJobs === 0)
    return null

  return `Recent average for ${formatModelKey(modelKey)}: ~${formatMs(stats.avgTotalMs)} (${stats.totalJobs} jobs)`
}

export function getCurrentModelKey() {
  return CURRENT_MODEL_KEY
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(1)}s`
}
