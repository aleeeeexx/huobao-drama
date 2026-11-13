import assert from 'node:assert/strict'
import test from 'node:test'

process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'

const { generateWorldDraft } = await import('../src/services/rpg/world-generation.js')
const { default: routes } = await import('../src/routes/rpg.js')
const { db, schema } = await import('../src/db/index.js')
const { withMockWorldAdaptation } = await import('./helpers/mock-world-adaptation.js')

const concept = '在只能用记忆交易的城市里寻找失踪的姐姐'
const draft = {
  title: '记忆之城',
  genre: '奇幻悬疑',
  tagline: '每一段记忆都有价格，而你要找的人没有留下记忆',
  premise: '你是记忆之城的一名修表匠。这里禁止用金钱交易，付出的记忆无法取回。姐姐失踪后，你在她的店里找到一张写着自己名字的收据，收据上的交易时间却在明天。门外的记忆商人正在敲门。',
}

test('world generation returns a trimmed editable draft with a short completion budget', async () => {
  const result = await generateWorldDraft(`  ${concept}  `, async (prompt, options) => {
    assert.match(prompt, new RegExp(concept))
    assert.match(prompt, /不提前决定玩家行动或写定结局/)
    assert.match(prompt, /简体中文/)
    assert.equal(options?.timeoutMs, 45_000)
    assert.equal(options?.maxTokens, 2048)
    return `\`\`\`json\n${JSON.stringify({ ...draft, title: ` ${draft.title} `, style: 'ignored' })}\n\`\`\``
  })
  assert.deepEqual(result, draft)
})

test('invalid concepts are rejected before calling the text model', async () => {
  let calls = 0
  for (const value of [undefined, null, 42, {}, '', '   ', '字'.repeat(2001)]) {
    await assert.rejects(generateWorldDraft(value, async () => {
      calls += 1
      return JSON.stringify(draft)
    }), /世界创意/)
  }
  assert.equal(calls, 0)
  await generateWorldDraft('字'.repeat(2000), async () => JSON.stringify(draft))
})

test('invalid JSON produces an actionable world generation error', async () => {
  await assert.rejects(generateWorldDraft(concept, async () => '这不是 JSON'), /世界草稿格式有误，请重新生成/)
})

test('missing, non-string and out-of-range draft fields are rejected', async () => {
  for (const [field, limit] of [['title', 40], ['genre', 20], ['tagline', 40], ['premise', 2000]] as const) {
    for (const value of [undefined, '', '  ', 123, {}, '字'.repeat(limit + 1)]) {
      await assert.rejects(
        generateWorldDraft(concept, async () => JSON.stringify({ ...draft, [field]: value })),
        /请重新生成/,
      )
    }
  }
  await assert.rejects(
    generateWorldDraft(concept, async () => JSON.stringify({ ...draft, premise: '字'.repeat(19) })),
    /世界设定/,
  )
  const maximum = { title: '字'.repeat(40), genre: '字'.repeat(20), tagline: '字'.repeat(40), premise: '字'.repeat(2000) }
  assert.deepEqual(await generateWorldDraft(concept, async () => JSON.stringify(maximum)), maximum)
  assert.equal((await generateWorldDraft(concept, async () => JSON.stringify({ ...draft, premise: '字'.repeat(20) }))).premise.length, 20)
})

test('text model failures remain available to the caller', async () => {
  const failure = new Error('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  await assert.rejects(generateWorldDraft(concept, async () => { throw failure }), error => error === failure)
})

function post(body: string) {
  return routes.request('/worlds/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

function savedCounts() {
  return [schema.rpgWorlds, schema.rpgSessions, schema.dramas, schema.episodes, schema.characters, schema.sysTask]
    .map(table => db.select().from(table).all().length)
}

test('world generation API returns a draft without creating a world, session or media task', async () => {
  const before = savedCounts()
  const response = await withMockWorldAdaptation(
    () => post(JSON.stringify({ concept })),
    () => JSON.stringify(draft),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { code: 200, data: draft, message: 'success' })
  assert.deepEqual(savedCounts(), before)
})

test('world generation API handles malformed bodies, invalid drafts and missing models without writing data', async () => {
  const before = savedCounts()
  for (const body of ['{', 'null', '{}', JSON.stringify({ concept: '字'.repeat(2001) })]) {
    const response = await post(body)
    assert.equal(response.status, 400)
    assert.match((await response.json()).message, /世界创意/)
  }
  const response = await withMockWorldAdaptation(
    () => post(JSON.stringify({ concept })),
    () => JSON.stringify({ ...draft, premise: '太短' }),
  )
  assert.equal(response.status, 400)
  assert.match((await response.json()).message, /世界设定.*请重新生成/)
  const noModel = await post(JSON.stringify({ concept }))
  assert.equal(noModel.status, 400)
  assert.match((await noModel.json()).message, /未配置文本模型/)
  assert.deepEqual(savedCounts(), before)
})
