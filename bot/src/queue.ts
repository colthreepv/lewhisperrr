const concurrency = 1
const maxQueue = 20

let running = 0
const q: Array<() => Promise<void>> = []

export function enqueue(job: () => Promise<void>) {
  if (maxQueue > 0 && q.length >= maxQueue) {
    return false
  }

  q.push(job)
  pump()
  return true
}

function pump() {
  while (running < concurrency && q.length) {
    const job = q.shift()!
    running++
    job()
      .catch((error) => {
        console.error('job failed', error)
      })
      .finally(() => {
        running--
        pump()
      })
  }
}
