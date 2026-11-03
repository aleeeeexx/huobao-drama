/**
 * 小说创作页。写章走火宝小说原稿路径；剧情图和剧情视频复用织界的图片、视频任务。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { badRequest, notFound, success } from '../utils/response.js'
import {
  createNovelBook,
  filmNovelChapter,
  getNovelBook,
  illustrateNovelChapter,
  listNovelBooks,
  writeNovelBookChapter,
} from '../services/novel/play.js'

const app = new Hono()

app.get('/books', async (c) => {
  return success(c, await listNovelBooks())
})

app.post('/books', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const book = await createNovelBook(body)
    return success(c, book)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '这本书没有建起来')
  }
})

app.get('/books/:id', async (c) => {
  const book = await getNovelBook(Number(c.req.param('id')))
  if (!book) return notFound(c, '这本书不存在')
  return success(c, book)
})

app.post('/books/:id/chapters', async (c) => {
  const bookId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  return streamSSE(c, async (stream) => {
    try {
      const book = await writeNovelBookChapter(bookId, body, async (phase) => {
        try {
          await stream.writeSSE({ event: 'phase', data: JSON.stringify({ phase }) })
        } catch { /* 页面关掉时仍把这一章写完 */ }
      })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ book }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : '这一章没有写完'
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) })
    }
  })
})

app.post('/books/:id/chapters/:number/image', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const chapterNumber = Number(c.req.param('number'))
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return badRequest(c, '章节号不正确')
    const force = body?.force === true || body?.redraw === true
    return success(c, await illustrateNovelChapter(Number(c.req.param('id')), chapterNumber, force))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '剧情图生成失败')
  }
})

app.post('/books/:id/chapters/:number/video', async (c) => {
  try {
    const chapterNumber = Number(c.req.param('number'))
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return badRequest(c, '章节号不正确')
    return success(c, await filmNovelChapter(Number(c.req.param('id')), chapterNumber))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '剧情视频生成失败')
  }
})

export default app
