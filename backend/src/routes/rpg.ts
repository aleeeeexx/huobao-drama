/**
 * 织界玩家接口。续写文本由 script_rewriter 流式输出，经 SSE 推给页面；插画和视频复用 sys_task。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { badRequest, notFound, success } from '../utils/response.js'
import {
  createSession,
  filmSession,
  getSession,
  illustrateSession,
  listSessions,
  listWorlds,
  narrateSession,
} from '../services/rpg/engine.js'

const app = new Hono()

app.get('/worlds', async (c) => {
  return success(c, await listWorlds())
})

app.get('/sessions', async (c) => {
  return success(c, await listSessions())
})

app.post('/sessions', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const session = await createSession(body)
    return success(c, session)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '无法开始这一局')
  }
})

app.get('/sessions/:id', async (c) => {
  const session = await getSession(Number(c.req.param('id')))
  if (!session) return notFound(c, '这局游戏不存在')
  return success(c, session)
})

app.post('/sessions/:id/act', async (c) => {
  const sessionId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  return streamSSE(c, async (stream) => {
    try {
      const turn = await narrateSession(sessionId, body, async (text) => {
        try {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) })
        } catch { /* 玩家关掉页面时仍把这一幕写完 */ }
      })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ turn }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : '这一幕没有写完'
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) })
    }
  })
})

app.post('/sessions/:id/image', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const force = body?.force === true || body?.redraw === true
    return success(c, await illustrateSession(Number(c.req.param('id')), { force }))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '剧情图生成失败')
  }
})

app.post('/sessions/:id/video', async (c) => {
  try {
    return success(c, await filmSession(Number(c.req.param('id'))))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '影像生成失败')
  }
})

export default app
