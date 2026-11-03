import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { huobaoSqlitePath, OFFICIAL_TEXT_PROVIDERS, readHuobaoTextConfig } from '../huobao-config.mjs'
import { assertNovelModelConfig, completeChat, novelChatUrl, novelModelConfig } from '../llm.mjs'
import { startNovelServer } from '../server.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENV_KEYS = ['AI_NOVEL_BASE_URL', 'AI_NOVEL_API_KEY', 'AI_NOVEL_MODEL', 'SQLITE_PATH', 'HUOBAO_DATA_DIR']

function fill(seed, length) {
  let text = seed
  while (text.length < length) text += seed
  return text.slice(0, length)
}

function fixtureFor(prompt) {
  if (prompt.includes('我的创意如下')) {
    return { plot: fill('雾城的档案被改写，调查员一路追到终局。', 240) }
  }
  if (prompt.includes('提炼要求')) {
    return {
      genre: '悬疑',
      tone: '冷峻',
      target_audience: '成年读者',
      core_idea: '调查员要在公开真相和保护亲友之间做选择。',
    }
  }
  if (prompt.includes('雪花写作法')) {
    return { core_seed: fill('当调查员撞上被改写的档案，必须公开证据，否则全城记忆会被再次覆盖。', 80) }
  }
  if (prompt.includes('专业小说策划人')) {
    return {
      title: '雾城档案',
      subtitle: '被改写的昨日',
      introduction: fill('雾城的公共档案从不出错，直到调查员收到一份不存在的卷宗。', 120),
      summary: fill('调查员追查集体失踪，发现管理机构用记忆修订维持秩序，最后必须做出选择。', 140),
      worldview: fill('近未来港城用中央档案确认身份，修订记忆会留下纸质记录冲突。', 120),
      writing_style: '克制冷峻的调查叙事',
      narrative_pov: '第三人称有限视角',
      era_background: '近未来海港城市',
      tags: ['悬疑', '记忆', '近未来'],
    }
  }
  throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`)
}

function withEnv(values) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) {
    if (value != null) process.env[key] = value
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function createConfigDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT NOT NULL,
      provider TEXT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      settings TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const insert = db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, priority, is_active, settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
  for (const row of rows) {
    const model = Array.isArray(row.model) ? JSON.stringify(row.model) : row.model
    insert.run(
      row.serviceType,
      row.provider,
      row.name,
      row.baseUrl,
      row.apiKey,
      model,
      row.priority ?? 0,
      row.isActive === false ? 0 : 1,
      row.settings ?? null,
    )
  }
  db.close()
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

test('official text providers stay aligned with 织界', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'backend/src/services/ai.ts'), 'utf8')
  const match = source.match(/text:\s*\[([^\]]+)\]/)
  assert.ok(match)
  const providers = [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1])
  assert.deepEqual(providers, OFFICIAL_TEXT_PROVIDERS)
})

test('sqlite path follows SQLITE_PATH, then HUOBAO_DATA_DIR, then the repo data file', () => {
  const restore = withEnv({})
  try {
    assert.equal(huobaoSqlitePath(), path.join(repoRoot, 'data', 'huobao.sqlite3'))
  } finally {
    restore()
  }

  const restoreDataDir = withEnv({ HUOBAO_DATA_DIR: '/tmp/huobao-data' })
  try {
    assert.equal(huobaoSqlitePath(), path.join('/tmp/huobao-data', 'huobao.sqlite3'))
  } finally {
    restoreDataDir()
  }

  const restoreSqlite = withEnv({
    HUOBAO_DATA_DIR: '/tmp/huobao-data',
    SQLITE_PATH: '/tmp/explicit/huobao.sqlite3',
  })
  try {
    assert.equal(huobaoSqlitePath(), '/tmp/explicit/huobao.sqlite3')
  } finally {
    restoreSqlite()
  }
})

test('unset AI_NOVEL_* selects the active official text config and ignores lower, inactive, and non-text rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-'))
  const dbPath = path.join(dir, 'huobao.sqlite3')
  createConfigDb(dbPath, [
    {
      serviceType: 'text',
      provider: 'openai',
      name: 'low',
      baseUrl: 'https://low.example',
      apiKey: 'low-key',
      model: ['low-model'],
      priority: 1,
    },
    {
      serviceType: 'text',
      provider: 'OpenAI',
      name: 'inactive-high',
      baseUrl: 'https://inactive.example',
      apiKey: 'inactive-key',
      model: ['inactive-model'],
      priority: 50,
      isActive: false,
    },
    {
      serviceType: 'text',
      provider: 'custom',
      name: 'unofficial',
      baseUrl: 'https://custom.example',
      apiKey: 'custom-key',
      model: ['custom-model'],
      priority: 80,
    },
    {
      serviceType: 'image',
      provider: 'openai',
      name: 'image',
      baseUrl: 'https://image.example',
      apiKey: 'image-key',
      model: ['image-model'],
      priority: 100,
    },
    {
      serviceType: 'text',
      provider: 'gemini',
      name: 'chosen',
      baseUrl: 'https://text.example/gemini',
      apiKey: 'huobao-text-key',
      model: ['gemini-2.5-pro', 'spare'],
      priority: 9,
      settings: JSON.stringify({ temperature: 0.4 }),
    },
  ])
  const restore = withEnv({ SQLITE_PATH: dbPath })
  try {
    const config = novelModelConfig()
    assert.equal(config.source, 'huobao')
    assert.equal(config.provider, 'gemini')
    assert.equal(config.baseUrl, 'https://text.example/gemini')
    assert.equal(config.apiKey, 'huobao-text-key')
    assert.equal(config.model, 'gemini-2.5-pro')
    assert.equal(config.temperature, 0.4)
    assert.deepEqual(readHuobaoTextConfig(dbPath), {
      id: 5,
      provider: 'gemini',
      baseUrl: 'https://text.example/gemini',
      apiKey: 'huobao-text-key',
      model: 'gemini-2.5-pro',
      temperature: 0.4,
    })
  } finally {
    restore()
  }
})

test('a full AI_NOVEL_* override wins and does not need the 织界 database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-'))
  const dbPath = path.join(dir, 'not-a-database')
  fs.writeFileSync(dbPath, 'not sqlite')
  const restore = withEnv({
    SQLITE_PATH: dbPath,
    AI_NOVEL_BASE_URL: 'https://override.example/v1',
    AI_NOVEL_API_KEY: 'override-key',
    AI_NOVEL_MODEL: 'override-model',
  })
  try {
    const config = novelModelConfig()
    assert.equal(config.source, 'env')
    assert.equal(config.provider, 'openai')
    assert.equal(config.baseUrl, 'https://override.example/v1')
    assert.equal(config.apiKey, 'override-key')
    assert.equal(config.model, 'override-model')
  } finally {
    restore()
  }
})

test('a partial AI_NOVEL_* override fills the remaining fields from 织界', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-'))
  const dbPath = path.join(dir, 'huobao.sqlite3')
  createConfigDb(dbPath, [{
    serviceType: 'text',
    provider: 'openai',
    name: 'text',
    baseUrl: 'https://text.example',
    apiKey: 'huobao-text-key',
    model: ['db-model'],
    priority: 3,
  }])
  const restore = withEnv({
    SQLITE_PATH: dbPath,
    AI_NOVEL_MODEL: 'env-model-only',
  })
  try {
    const config = novelModelConfig()
    assert.equal(config.source, 'huobao')
    assert.equal(config.provider, 'openai')
    assert.equal(config.baseUrl, 'https://text.example')
    assert.equal(config.apiKey, 'huobao-text-key')
    assert.equal(config.model, 'env-model-only')
  } finally {
    restore()
  }
})

test('missing 织界 config and missing AI_NOVEL_* fails with a setup hint', () => {
  const restore = withEnv({ SQLITE_PATH: path.join(os.tmpdir(), `missing-${process.pid}-${Date.now()}.sqlite3`) })
  try {
    const config = novelModelConfig()
    assert.equal(config.source, 'missing')
    assert.equal(config.baseUrl, '')
    assert.equal(config.apiKey, '')
    assert.equal(config.model, '')
    assert.throws(() => assertNovelModelConfig(), /织界设置页启用文本模型/)
    assert.throws(() => assertNovelModelConfig(), /AI_NOVEL_MODEL/)
  } finally {
    restore()
  }
})

test('chat urls follow the 织界 provider prefix', () => {
  assert.equal(
    novelChatUrl({ provider: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm' }),
    'http://127.0.0.1:9/v1/chat/completions',
  )
  assert.equal(
    novelChatUrl({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }),
    'http://127.0.0.1:9/v1/chat/completions',
  )
  assert.equal(
    novelChatUrl({ provider: 'volcengine', baseUrl: 'http://127.0.0.1:9', model: 'doubao' }),
    'http://127.0.0.1:9/api/v3/chat/completions',
  )
  assert.equal(
    novelChatUrl({ provider: 'volcengine', baseUrl: 'http://127.0.0.1:9/api/v3', model: 'doubao' }),
    'http://127.0.0.1:9/api/v3/chat/completions',
  )
  assert.equal(
    novelChatUrl({ provider: 'gemini', baseUrl: 'http://127.0.0.1:9', model: 'gemini-2.5-pro' }),
    'http://127.0.0.1:9/v1beta/models/gemini-2.5-pro:generateContent',
  )
})

test('unset AI_NOVEL_* sends the 织界 openai key, model, and temperature', async () => {
  const seen = []
  const mock = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '织界同一把钥匙' } }] }))
    })
  })
  const address = await listen(mock)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-'))
  const dbPath = path.join(dir, 'huobao.sqlite3')
  createConfigDb(dbPath, [{
    serviceType: 'text',
    provider: 'openai',
    name: 'text',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'huobao-text-key',
    model: ['huobao-text-model'],
    settings: JSON.stringify({ temperature: 0.2 }),
  }])
  const restore = withEnv({ SQLITE_PATH: dbPath })
  try {
    const text = await completeChat('用织界的文本模型写一句')
    assert.equal(text, '织界同一把钥匙')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/v1/chat/completions')
    assert.equal(seen[0].authorization, 'Bearer huobao-text-key')
    assert.equal(seen[0].body.model, 'huobao-text-model')
    assert.equal(seen[0].body.temperature, 0.2)
    assert.equal(seen[0].body.messages[0].content, '用织界的文本模型写一句')
  } finally {
    restore()
    await closeServer(mock)
  }
})

test('unset AI_NOVEL_* calls gemini generateContent with the 织界 key', async () => {
  const seen = []
  const mock = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, apiKey: req.headers['x-goog-api-key'], body: JSON.parse(body) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ thought: true, text: '先想一下' }, { text: '正文在这里' }] } }],
      }))
    })
  })
  const address = await listen(mock)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-'))
  const dbPath = path.join(dir, 'huobao.sqlite3')
  createConfigDb(dbPath, [{
    serviceType: 'text',
    provider: 'gemini',
    name: 'text',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'gemini-from-huobao',
    model: ['gemini-2.5-pro'],
  }])
  const restore = withEnv({ SQLITE_PATH: dbPath })
  try {
    const text = await completeChat('写一段')
    assert.equal(text, '正文在这里')
    assert.equal(seen[0].url, '/v1beta/models/gemini-2.5-pro:generateContent')
    assert.equal(seen[0].apiKey, 'gemini-from-huobao')
    assert.equal(seen[0].body.contents[0].parts[0].text, '写一段')
    assert.equal(seen[0].body.generationConfig.temperature, 0.7)
  } finally {
    restore()
    await closeServer(mock)
  }
})

test('creating a book without AI_NOVEL_* uses the 织界 text config end to end', async () => {
  const seen = []
  const mock = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      seen.push({ url: req.url, authorization: req.headers.authorization, model: parsed.model })
      const prompt = parsed.messages[0].content
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixtureFor(prompt)) } }] }))
    })
  })
  const address = await listen(mock)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-'))
  const configPath = path.join(dir, 'huobao.sqlite3')
  const booksPath = path.join(dir, 'books.sqlite')
  createConfigDb(configPath, [{
    serviceType: 'text',
    provider: 'volcengine',
    name: 'text',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'volc-key-from-huobao',
    model: ['doubao-seed'],
    priority: 4,
  }])
  const restore = withEnv({ SQLITE_PATH: configPath })
  let started
  try {
    started = await startNovelServer({ host: '127.0.0.1', port: 0, dbPath: booksPath })
    const base = `http://127.0.0.1:${started.port}`
    const page = await fetch(base).then(response => response.text())
    assert.match(page, /织界设置页里已启用的文本模型/)

    const created = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_idea: '潮汐把一座档案馆送上了岸', number_of_chapters: 8, words_per_chapter: 2000 }),
    }).then(response => response.json())
    assert.equal(created.ok, true)

    const stream = await fetch(`${base}/api/books/${created.data.id}/direction`, { method: 'POST' })
    const raw = await stream.text()
    assert.match(raw, /event: done/)
    assert.match(raw, /雾城档案/)
    assert.equal(seen.length, 4)
    assert.deepEqual(seen.map(item => item.url), [
      '/api/v3/chat/completions',
      '/api/v3/chat/completions',
      '/api/v3/chat/completions',
      '/api/v3/chat/completions',
    ])
    assert.deepEqual(seen.map(item => item.model), ['doubao-seed', 'doubao-seed', 'doubao-seed', 'doubao-seed'])
    assert.deepEqual(new Set(seen.map(item => item.authorization)), new Set(['Bearer volc-key-from-huobao']))
  } finally {
    restore()
    if (started) {
      await closeServer(started.server)
      started.store.close()
    }
    await closeServer(mock)
  }
})
