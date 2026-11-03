/**
 * 织界旁边的小说模块。只监听本机，不挂进织界的 /novel 路由。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { completeChat } from './llm.mjs'
import { defaultDbPath, openStore } from './store.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const indexHtml = fs.readFileSync(path.join(moduleDir, 'public', 'index.html'))

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('请求太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求格式不正确'))
      }
    })
    req.on('error', reject)
  })
}

function bookIdFrom(url) {
  const match = url.pathname.match(/^\/api\/books\/(\d+)(?:\/direction)?$/)
  if (!match) return null
  return Number(match[1])
}

export function createNovelServer({ dbPath = defaultDbPath(), complete = completeChat } = {}) {
  const store = openStore(dbPath)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(indexHtml)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'ai-novel' })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/books') {
        sendJson(res, 200, { ok: true, data: store.list() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/books') {
        const body = await readBody(req)
        sendJson(res, 200, { ok: true, data: store.create(body) })
        return
      }
      const id = bookIdFrom(url)
      if (req.method === 'GET' && id && url.pathname === `/api/books/${id}`) {
        const book = store.get(id)
        if (!book) {
          sendJson(res, 404, { ok: false, message: '这本书不存在' })
          return
        }
        sendJson(res, 200, { ok: true, data: book })
        return
      }
      if (req.method === 'POST' && id && url.pathname === `/api/books/${id}/direction`) {
        const existing = store.get(id)
        if (!existing) {
          sendJson(res, 404, { ok: false, message: '这本书不存在' })
          return
        }
        if (existing.status === 'ready') {
          sendJson(res, 400, { ok: false, message: '故事方向已经生成' })
          return
        }
        if (existing.status === 'running') {
          sendJson(res, 400, { ok: false, message: '正在生成，请稍候' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        const writeEvent = (event, data) => {
          if (res.destroyed) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        try {
          const book = await store.generate(id, (step) => writeEvent('step', step), complete)
          writeEvent('done', { book })
        } catch (error) {
          writeEvent('error', { message: error instanceof Error ? error.message : '故事方向没有生成' })
        } finally {
          if (!res.destroyed) res.end()
        }
        return
      }
      sendJson(res, 404, { ok: false, message: '没有这个地址' })
    } catch (error) {
      if (res.headersSent || res.destroyed) return
      const message = error instanceof Error ? error.message : '请求没有完成'
      const status = message === '这本书不存在' ? 404 : 400
      sendJson(res, status, { ok: false, message })
    }
  })
  return { server, store }
}

export function startNovelServer(options = {}) {
  const host = options.host || '127.0.0.1'
  const port = options.port ?? Number(process.env.AI_NOVEL_PORT || 5681)
  const created = createNovelServer(options)
  return new Promise((resolve, reject) => {
    created.server.once('error', reject)
    created.server.listen(port, host, () => {
      const address = created.server.address()
      resolve({ ...created, host, port: typeof address === 'object' && address ? address.port : port })
    })
  })
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const started = await startNovelServer()
  console.log(`ai-novel listening on http://${started.host}:${started.port}`)
}
