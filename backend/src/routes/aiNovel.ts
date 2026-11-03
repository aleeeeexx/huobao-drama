import { Hono } from 'hono'
import type { Context } from 'hono'

import {
  AI_NOVEL_MOUNT,
  ensureAiNovelSidecar,
  forwardAiNovelRequest,
} from '../services/ai-novel-sidecar.js'

const app = new Hono()

function statusBody(status: Awaited<ReturnType<typeof ensureAiNovelSidecar>>) {
  return {
    ok: status.running,
    running: status.running,
    mount: `${AI_NOVEL_MOUNT}/`,
    message: status.message,
  }
}

app.get('/status', async (c) => {
  const status = await ensureAiNovelSidecar()
  return c.json(statusBody(status), status.running ? 200 : 503)
})

app.post('/start', async (c) => {
  const status = await ensureAiNovelSidecar()
  return c.json(statusBody(status), status.running ? 200 : 503)
})

export async function proxyAiNovelApp(c: Context) {
  if (c.req.path === AI_NOVEL_MOUNT) return c.redirect(`${AI_NOVEL_MOUNT}/`, 302)
  const status = await ensureAiNovelSidecar()
  if (!status.running) {
    return c.json({ ok: false, message: status.message || '小说模块没有启动' }, 503)
  }
  return forwardAiNovelRequest(c.req.raw, status.port)
}

export default app
