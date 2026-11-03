import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  aiNovelPort,
  bookDatabasePath,
  ensureAiNovelSidecar,
  forwardAiNovelRequest,
  resolveAiNovelRoot,
  stopAiNovelSidecar,
  upstreamPath,
} from '../src/services/ai-novel-sidecar.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const novelRoot = path.join(repoRoot, 'ai-novel')

test('mount path strips to the ai-novel server path', () => {
  assert.equal(upstreamPath('/ai-novel-app'), '/')
  assert.equal(upstreamPath('/ai-novel-app/'), '/')
  assert.equal(upstreamPath('/ai-novel-app/api/health'), '/api/health')
  assert.equal(upstreamPath('/ai-novel-app/api/books/3/direction'), '/api/books/3/direction')
  assert.equal(upstreamPath('/novel'), null)
  assert.equal(upstreamPath('/api/v1/novel/books'), null)
})

test('port and book database follow the shared env without inventing a url', () => {
  assert.equal(aiNovelPort({}), 5681)
  assert.equal(aiNovelPort({ AI_NOVEL_PORT: '5700' }), 5700)
  assert.equal(aiNovelPort({ AI_NOVEL_PORT: 'nope' }), 5681)
  assert.equal(bookDatabasePath({}), null)
  assert.equal(bookDatabasePath({ AI_NOVEL_DB: '/tmp/books.sqlite' }), '/tmp/books.sqlite')
  assert.equal(
    bookDatabasePath({ HUOBAO_DATA_DIR: '/data/huobao' }),
    path.join('/data/huobao', 'ai-novel', 'books.sqlite'),
  )
})

test('root resolution accepts a directory that contains the server and page', () => {
  assert.equal(resolveAiNovelRoot([novelRoot]), novelRoot)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-missing-'))
  assert.equal(resolveAiNovelRoot([empty, novelRoot]), novelRoot)
  assert.equal(resolveAiNovelRoot([empty]), null)
})

test('proxy forwards the body and streams the upstream response', async () => {
  let seen = ''
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('event: step\ndata: {"n":1}\n\n')
      setTimeout(() => {
        res.write('event: done\ndata: {"n":2}\n\n')
        res.end()
      }, 30)
    })
  })
  const port = await listen(upstream)
  try {
    const response = await forwardAiNovelRequest(new Request('http://127.0.0.1/ai-novel-app/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_idea: '雨夜' }),
    }), port)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(seen, '{"user_idea":"雨夜"}')
    assert.match(await response.text(), /event: done/)
  } finally {
    upstream.close()
  }
})

test('sidecar starts and the same-origin proxy serves health and the page', async () => {
  const database = path.join(os.tmpdir(), `ai-novel-proxy-${process.pid}-${Date.now()}.sqlite`)
  const previous = {
    port: process.env.AI_NOVEL_PORT,
    db: process.env.AI_NOVEL_DB,
    autostart: process.env.AI_NOVEL_AUTOSTART,
    root: process.env.AI_NOVEL_ROOT,
  }
  const port = await freePort()
  process.env.AI_NOVEL_PORT = String(port)
  process.env.AI_NOVEL_DB = database
  delete process.env.AI_NOVEL_AUTOSTART
  delete process.env.AI_NOVEL_ROOT
  try {
    const status = await ensureAiNovelSidecar({ root: novelRoot })
    assert.equal(status.running, true, status.message)
    assert.equal(status.port, port)
    const health = await forwardAiNovelRequest(new Request('http://127.0.0.1/ai-novel-app/api/health'), status.port)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, service: 'ai-novel' })
    const page = await forwardAiNovelRequest(new Request('http://127.0.0.1/ai-novel-app/'), status.port)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /mountPrefix/)
    const missed = await forwardAiNovelRequest(new Request('http://127.0.0.1/novel'), status.port)
    assert.equal(missed.status, 404)
  } finally {
    await stopAiNovelSidecar()
    restoreEnv(previous)
    fs.rmSync(database, { force: true })
  }
})

function restoreEnv(previous: { port?: string, db?: string, autostart?: string, root?: string }) {
  assignEnv('AI_NOVEL_PORT', previous.port)
  assignEnv('AI_NOVEL_DB', previous.db)
  assignEnv('AI_NOVEL_AUTOSTART', previous.autostart)
  assignEnv('AI_NOVEL_ROOT', previous.root)
}

function assignEnv(key: string, value: string | undefined) {
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
    server.on('error', reject)
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}
