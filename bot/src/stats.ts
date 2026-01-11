import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const STATS_PATH = process.env.STATS_PATH ?? '/data/stats.json'

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

let cachedStats: Stats | null = null

async function loadStats() {
  if (cachedStats)
    return cachedStats

  try {
    const raw = await fs.readFile(STATS_PATH, 'utf8')
    cachedStats = { ...defaultStats, ...(JSON.parse(raw) as Stats) }
  }
  catch {
    cachedStats = { ...defaultStats }
  }

  return cachedStats
}

async function saveStats(stats: Stats) {
  await fs.mkdir(path.dirname(STATS_PATH), { recursive: true })
  await fs.writeFile(STATS_PATH, JSON.stringify(stats, null, 2))
}

function updateAverage(previous: number, count: number, value: number) {
  return previous + (value - previous) / count
}

export async function recordJob(update: JobUpdate) {
  const stats = await loadStats()

  stats.totalJobs += 1
  stats.lastJobAt = new Date().toISOString()

  if (update.success) {
    stats.successJobs += 1
    stats.lastError = null
  }
  else {
    stats.failedJobs += 1
    if (update.errorMessage) {
      stats.lastError = update.errorMessage
    }
  }

  if (update.totalMs !== undefined) {
    stats.avgTotalMs = updateAverage(stats.avgTotalMs, stats.totalJobs, update.totalMs)
  }

  if (update.downloadMs !== undefined) {
    stats.avgDownloadMs = updateAverage(
      stats.avgDownloadMs,
      stats.totalJobs,
      update.downloadMs,
    )
  }

  if (update.ffmpegMs !== undefined) {
    stats.avgFfmpegMs = updateAverage(stats.avgFfmpegMs, stats.totalJobs, update.ffmpegMs)
  }

  if (update.asrMs !== undefined) {
    stats.avgAsrMs = updateAverage(stats.avgAsrMs, stats.totalJobs, update.asrMs)
  }

  await saveStats(stats)
}

export async function getStatsMessage() {
  const stats = await loadStats()

  if (stats.totalJobs === 0) {
    return 'No transcriptions yet. Send a voice, audio, or video message.'
  }

  const lines = [
    `Jobs: ${stats.totalJobs} total, ${stats.successJobs} ok, ${stats.failedJobs} failed`,
    `Avg times: total ${formatMs(stats.avgTotalMs)}, download ${formatMs(stats.avgDownloadMs)}, ffmpeg ${formatMs(stats.avgFfmpegMs)}, asr ${formatMs(stats.avgAsrMs)}`,
    `Last job: ${stats.lastJobAt ?? 'n/a'}`,
  ]

  if (stats.lastError) {
    lines.push(`Last error: ${stats.lastError}`)
  }

  return lines.join('\n')
}

function formatMs(value: number) {
  return `${(value / 1000).toFixed(1)}s`
}
