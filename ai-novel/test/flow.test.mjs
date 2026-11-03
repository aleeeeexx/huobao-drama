import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildNodePrompt, loadCreateNovelFlow, runCreateNovelFlow } from '../flow.mjs'
import { startNovelServer } from '../server.mjs'

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

test('create_novel_by_ai uses the vendored prompts and returns the result ports', async () => {
  const flow = loadCreateNovelFlow()
  const expand = flow.nodes.find(node => node.id === 'expand_idea_to_full_novel_story')
  const prompt = buildNodePrompt(expand, { user_idea: '雨夜茶寮' })
  assert.match(prompt, /雨夜茶寮/)
  assert.match(prompt, /请按照以下 JSON 结构返回/)
  assert.equal(prompt.includes('在正式写作前，请先确保你写的是'), false)
  assert.equal(prompt.includes('依据当前角色动力学设定'), false)

  const seen = []
  const document = await runCreateNovelFlow({
    userIdea: '雨夜茶寮里有一张没有署名的茶券',
    numberOfChapters: 12,
    wordsPerChapter: 1800,
  }, async (text) => {
    seen.push(text)
    return JSON.stringify(fixtureFor(text))
  })
  assert.deepEqual(seen.map(text => fixtureFor(text) && true), [true, true, true, true])
  assert.equal(seen[2].includes('约12章'), true)
  assert.equal(seen[2].includes('每章1800字'), true)
  assert.equal(document.title, '雾城档案')
  assert.equal(document.workflow, 'create_novel_by_ai')
  assert.equal(document.number_of_chapters, 12)
  assert.equal(document.core_seed.length >= 30, true)
})

test('the side server creates a book and streams the upstream create flow', async () => {
  const dbPath = path.join(os.tmpdir(), `ai-novel-${process.pid}-${Date.now()}.sqlite`)
  const started = await startNovelServer({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    complete: async (prompt) => JSON.stringify(fixtureFor(prompt)),
  })
  try {
    const base = `http://127.0.0.1:${started.port}`
    const page = await fetch(base)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /起一本书/)

    const empty = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_idea: '  ' }),
    })
    assert.equal(empty.status, 400)

    const createdResponse = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_idea: '潮汐把一座档案馆送上了岸', number_of_chapters: 8, words_per_chapter: 2000 }),
    })
    const created = await createdResponse.json()
    assert.equal(created.ok, true)
    assert.equal(created.data.status, 'draft')

    const stream = await fetch(`${base}/api/books/${created.data.id}/direction`, { method: 'POST' })
    assert.equal(stream.headers.get('content-type')?.includes('text/event-stream'), true)
    const raw = await stream.text()
    assert.match(raw, /event: step/)
    assert.match(raw, /expand_idea_to_full_novel_story/)
    assert.match(raw, /event: done/)
    assert.match(raw, /雾城档案/)

    const saved = await fetch(`${base}/api/books/${created.data.id}`).then(response => response.json())
    assert.equal(saved.data.status, 'ready')
    assert.equal(saved.data.title, '雾城档案')
    assert.equal(saved.data.document.genre, '悬疑')
    assert.equal(saved.data.document.number_of_chapters, 8)
  } finally {
    await new Promise((resolve, reject) => started.server.close(error => error ? reject(error) : resolve()))
    started.store.close()
  }
})

test('a configured chat endpoint can complete one node', async () => {
  const mock = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      assert.equal(parsed.model, 'fixture-model')
      assert.match(parsed.messages[0].content, /潮汐档案馆/)
      const payload = JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ plot: fill('潮汐把档案馆送上岸，故事在审判里结束。', 220) }) } }],
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(payload)
    })
  })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const address = mock.address()
  const previous = {
    base: process.env.AI_NOVEL_BASE_URL,
    key: process.env.AI_NOVEL_API_KEY,
    model: process.env.AI_NOVEL_MODEL,
  }
  process.env.AI_NOVEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`
  process.env.AI_NOVEL_API_KEY = 'test-key'
  process.env.AI_NOVEL_MODEL = 'fixture-model'
  try {
    const { completeChat } = await import('../llm.mjs')
    const text = await completeChat('创意如下：潮汐档案馆')
    const parsed = JSON.parse(text)
    assert.equal(parsed.plot.length >= 200, true)
  } finally {
    for (const [key, value] of Object.entries({
      AI_NOVEL_BASE_URL: previous.base,
      AI_NOVEL_API_KEY: previous.key,
      AI_NOVEL_MODEL: previous.model,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise((resolve, reject) => mock.close(error => error ? reject(error) : resolve()))
  }
})
