import process from 'node:process'
import { Bot } from 'grammy'
import { enqueue } from './queue'
import { getStatsMessage } from './stats'
import { handleAudio } from './telegram'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token)
  throw new Error('Missing TELEGRAM_BOT_TOKEN')

const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY ?? '').trim()
const ELEVENLABS_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID ?? 'scribe_v2').trim()
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? process.env.PORT ?? '3000')

const bot = new Bot(token)

bot.command('start', async (ctx) => {
  await ctx.reply('Hey! 👋 Send me a voice message and I\'ll transcribe it for you.')
})

bot.command('help', async (ctx) => {
  await ctx.reply(
    'Send a voice message, audio file, or video and I\'ll transcribe it.\nCommands: /start, /help, /stats',
  )
})

bot.command('stats', async (ctx) => {
  const message = await getStatsMessage()
  await ctx.reply(message)
})

async function enqueueJob(ctx: Parameters<typeof handleAudio>[0]) {
  const accepted = enqueue(() => handleAudio(ctx))
  if (!accepted) {
    await ctx.reply('I am busy right now. Please try again soon.')
  }
}

bot.on('message:voice', enqueueJob)
bot.on('message:audio', enqueueJob)
bot.on('message:document', enqueueJob)
bot.on('message:video', enqueueJob)
bot.on('message:video_note', enqueueJob)

bot.on('message', async (ctx) => {
  const message = ctx.message
  if (!message)
    return
  if (message.text?.startsWith('/'))
    return

  if (
    message.voice
    || message.audio
    || message.document
    || message.video
    || message.video_note
  ) {
    return
  }

  const from = ctx.from
  console.warn('interaction', {
    userId: from?.id,
    username: from?.username ?? null,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || null,
    type: 'unsupported',
  })

  await ctx.reply('Please send a voice message, audio file, or video.')
})

bot.catch(err => console.error('bot error', err))

async function main() {
  if (!ELEVENLABS_API_KEY)
    throw new Error('Missing ELEVENLABS_API_KEY')

  const server = Bun.serve({
    port: HEALTH_PORT,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'GET')
        return new Response('Method Not Allowed', { status: 405 })

      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          provider: 'elevenlabs',
          model: ELEVENLABS_MODEL_ID,
        })
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  await bot.start()
  console.warn('bot started', { healthPort: server.port })

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function shutdown() {
  console.warn('shutting down bot')
  await bot.stop()
  process.exit(0)
}

void main()
