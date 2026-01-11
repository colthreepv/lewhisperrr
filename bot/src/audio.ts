import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function oggToWav16kMono(inputOgg: string, outDir: string) {
  const outWav = path.join(outDir, `${path.basename(inputOgg)}.wav`)

  await fs.mkdir(outDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y',
      '-i',
      inputOgg,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      outWav,
    ])

    let stderr = ''
    p.stderr.on('data', d => (stderr += d.toString()))
    p.on('close', (code) => {
      if (code === 0)
        resolve()
      else reject(new Error(`ffmpeg failed (${code}): ${stderr}`))
    })
  })

  return outWav
}
