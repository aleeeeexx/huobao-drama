import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'

process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.js')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.js')
const { createSession, filmSession, getSession, illustrateSession, narrateSession } = await import('../src/services/rpg/engine.js')
const { runExtraction } = await import('../src/services/extraction.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { scriptTools } = await import('../src/agents/tools/script-tools.js')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.js')
const { extractTools } = await import('../src/agents/tools/extract-tools.js')
const { mastra } = await import('../src/mastra/index.js')
const { createNovelProject } = await import('../src/services/novel/generator.js')
const { appendTurnScreenplay, currentTurnScreenplay, emptyWorldState, sceneIdFromScreenplay } = await import('../src/services/rpg/turn.js')

async function prepareSession(title: string) {
  const session = await createSession({ title, premise: '一位旅人穿过陌生的村庄和森林，追寻一座失落已久的古塔。' })
  assert.ok(session)
  const [row] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, session.id))
  const novel = row.novelState ? JSON.parse(row.novelState) : createNovelProject({ title, topic: '寻找古塔' })
  Object.assign(novel, {
    architectureGenerated: true,
    coreSeed: '寻找古塔',
    worldBuilding: '村庄和古塔',
    fullPlot: '旅人寻找古塔',
    chapterBlueprint: '第1章 - 村庄\n本章简述：出发\n\n第2章 - 古塔\n本章简述：抵达古塔',
    chapters: { '1': '我走过村庄，来到林边。' },
  })
  await db.update(schema.rpgSessions).set({ novelState: JSON.stringify(novel) }).where(eq(schema.rpgSessions.id, session.id))
  return session
}

async function waitForAssets(sessionId: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const session = await getSession(sessionId)
    if (!session?.asset_sync_pending) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('asset sync did not finish')
}

function textConfig() {
  const ts = new Date().toISOString()
  return db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'openai', name: 'test', baseUrl: 'https://example.invalid/v1',
    apiKey: 'test', model: '["test"]', createdAt: ts, updatedAt: ts,
  }).run()
}

test('each turn gets its own screenplay, extraction and storyboard context', async (t) => {
  const session = await prepareSession('多场景续写')
  const config = textConfig()
  const sources: string[] = []
  const extractionInputs: string[] = []
  let storyboardMessage = ''
  let storyboardScript = ''
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const content = prompt.startsWith('下面是刚刚写完') ? '{}' : '我走到古塔门前，推开了铁门。'
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }))
  })
  t.mock.method(mastra, 'getAgent', ((type: string) => ({
    generate: async (messages: any[], options: any) => {
      if (type === 'script_rewriter') {
        const read = await scriptTools.readEpisodeScript.execute!({}, options) as any
        sources.push(read.content)
        const content = sources.length === 1
          ? '## S1 | 外景 · 村庄 | 日\n我离开村庄。\n\n## S2 | 外景 · 林边 | 夜\n我停在林边。'
          : '## S1 | 外景 · 古塔 | 日\n我推开古塔铁门。'
        await scriptTools.saveScript.execute!({ content }, options)
      } else if (type === 'extractor') {
        extractionInputs.push(options.requestContext.get('extractionScript'))
        if (messages[0].content.includes('本次只提取场景')) {
          const scenes = extractionInputs.at(-1)!.includes('古塔')
            ? [{ location: '古塔', time: '日' }]
            : [{ location: '村庄', time: '日' }, { location: '林边', time: '夜' }]
          await extractTools.saveDedupScenes.execute!({ scenes }, options)
        }
      } else if (type === 'storyboard_breaker') {
        storyboardMessage = messages[0].content
        const context = await storyboardTools.readStoryboardContext.execute!({}, options) as any
        storyboardScript = context.script
      }
      return { text: '', toolCalls: [] }
    },
  })) as any)
  try {
    await narrateSession(session.id, { mode: 'opening' }, () => {})
    await waitForAssets(session.id)
    const second = await narrateSession(session.id, { mode: 'free', text: '前往古塔' }, () => {})
    assert.equal(second.scene_id, null)
    await waitForAssets(session.id)
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
    const turns = await db.select().from(schema.rpgTurns).where(eq(schema.rpgTurns.sessionId, session.id))
    assert.equal(sources.length, 2)
    assert.match(sources[1], /古塔/)
    assert.match(episode.scriptContent!, /## S1[^\n]*村庄[\s\S]*## S2[^\n]*林边[\s\S]*## S3[^\n]*古塔/)
    assert.match(turns[1].screenplay!, /^## S3[^\n]*古塔/)
    assert.equal(extractionInputs.length, 6)
    assert.ok(extractionInputs.slice(3).every(input => input.includes('古塔')))
    const scene = (await db.select().from(schema.scenes).where(eq(schema.scenes.id, turns[1].sceneId!)))[0]
    assert.equal(scene.location, '古塔')

    await db.update(schema.episodes).set({
      scriptContent: episode.scriptContent!
        .replace('## S3 | 外景 · 古塔 | 日', '## S3 | 内景 · 古塔门厅 | 深夜')
        .replace('我推开古塔铁门。', '我敲响古塔铁门。'),
    }).where(eq(schema.episodes.id, session.episode_id))
    await assert.rejects(filmSession(session.id, { turnId: turns[1].id }))
    assert.match(storyboardMessage, /## S3 \| 内景 · 古塔门厅 \| 深夜/)
    assert.doesNotMatch(storyboardMessage.split('这一幕剧本：')[1], /林边/)
    assert.match(storyboardScript, /我敲响古塔铁门/)
    assert.match(storyboardScript, /## S3 \| 内景 · 古塔门厅 \| 深夜/)
    assert.doesNotMatch(storyboardScript, /我推开古塔铁门/)
  } finally {
    await waitForAssets(session.id)
    await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid)))
  }
})

test('illustration rebinds a turn after failed scene extraction is retried', async (t) => {
  const session = await prepareSession('场景提取恢复')
  const config = textConfig()
  let failScenes = true
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })))
  t.mock.method(mastra, 'getAgent', ((type: string) => ({ generate: async (messages: any[], options: any) => {
    if (type === 'script_rewriter') {
      await scriptTools.saveScript.execute!({ content: '## S1 | 外景 · 林边 | 夜\n我停在林边。' }, options)
    } else if (type === 'extractor' && messages[0].content.includes('本次只提取场景')) {
      if (failScenes) throw new Error('temporary scene extraction failure')
      await extractTools.saveDedupScenes.execute!({ scenes: [{ location: '林边', time: '夜' }] }, options)
    }
    return { text: '', toolCalls: [] }
  } })) as any)
  try {
    const turn = await narrateSession(session.id, { mode: 'opening' }, () => {})
    await waitForAssets(session.id)
    assert.equal((await getSession(session.id))!.turns[0].scene_id, null)

    const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id })
    await extractTools.saveDedupScenes.execute!({ scenes: [
      { location: '林边', time: '日' },
      { location: '林边附近', time: '夜' },
    ] }, { requestContext } as any)
    await assert.rejects(illustrateSession(session.id, { turnId: turn.id }), /这一幕还没有场景资产/)
    assert.equal((await getSession(session.id))!.turns[0].scene_id, null)

    failScenes = false
    await runExtraction(session.episode_id, session.drama_id, 'scenes')
    // No image model is configured: scene recovery must finish before image submission.
    await assert.rejects(illustrateSession(session.id, { turnId: turn.id }), /未配置图片模型/)
    const recovered = await getSession(session.id)
    const scene = recovered!.assets.scenes.find(item => item.id === recovered!.turns[0].scene_id)
    assert.equal(scene?.location, '林边')
    assert.equal(scene?.time, '夜')
  } finally {
    await waitForAssets(session.id)
    await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid)))
  }
})

test('a failed commit preserves manual script and a retry appends fallback once', async (t) => {
  const session = await prepareSession('失败重试')
  const config = textConfig()
  const manual = '手写前言\n\n## S4 | 内景 · 老屋 | 夜\n这是手写剧本。'
  await db.update(schema.episodes).set({ scriptContent: manual }).where(eq(schema.episodes.id, session.episode_id))
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })))
  t.mock.method(mastra, 'getAgent', ((type: string) => ({ generate: async (_messages: unknown, options: any) => {
    if (type === 'script_rewriter') {
      await scriptTools.saveScript.execute!({ content: '## S1 | 外景 · 错误地点 | 日\n未完成的改写。' }, options)
    }
    throw new Error('mock agent failure')
  } })) as any)
  db.run(sql.raw("CREATE TRIGGER fail_screenplay_turn BEFORE INSERT ON rpg_turns BEGIN SELECT RAISE(ABORT, 'turn failed'); END"))
  try {
    await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /turn failed/)
    let [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
    assert.equal(episode.scriptContent, manual)
    assert.equal((await db.select().from(schema.rpgTurns).where(eq(schema.rpgTurns.sessionId, session.id))).length, 0)
    db.run(sql.raw('DROP TRIGGER fail_screenplay_turn'))
    await narrateSession(session.id, { mode: 'opening' }, () => {})
    await waitForAssets(session.id)
    ;[episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
    assert.ok(episode.scriptContent!.startsWith(manual))
    assert.equal((episode.scriptContent!.match(/## S5\b/g) || []).length, 1)
    assert.match(episode.scriptContent!, /我走过村庄/)
    assert.doesNotMatch(episode.scriptContent!, /未完成的改写/)
  } finally {
    db.run(sql.raw('DROP TRIGGER IF EXISTS fail_screenplay_turn'))
    await waitForAssets(session.id)
    await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid)))
  }
})

test('legacy turns use their narrative for storyboard context instead of guessing a scene number', async (t) => {
  const session = await prepareSession('旧回合分镜')
  const [row] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, session.id))
  const ts = new Date().toISOString()
  await db.update(schema.episodes).set({ scriptContent: '## S2 | 外景 · 旧林边 | 夜\n第一回合的旧场景。' })
    .where(eq(schema.episodes.id, session.episode_id))
  await db.insert(schema.rpgTurns).values({
    sessionId: session.id, turnIndex: 2, narrative: '我来到了新的古塔。', choices: '[]', worldState: row.worldState, createdAt: ts,
  })
  let script = ''
  t.mock.method(mastra, 'getAgent', ((type: string) => ({ generate: async (_messages: unknown, options: any) => {
    if (type === 'storyboard_breaker') {
      script = ((await storyboardTools.readStoryboardContext.execute!({}, options)) as any).script
    }
    return { text: '', toolCalls: [] }
  } })) as any)
  await assert.rejects(filmSession(session.id))
  assert.match(script, /新的古塔/)
  assert.doesNotMatch(script, /第一回合的旧场景/)
})

test('invalid rewrites fall back and ambiguous scene headers are not guessed', () => {
  const state = emptyWorldState()
  const result = appendTurnScreenplay('## S4 | 内景 · 老屋 | 夜\n手写。',
    '## S1 | 外景 · 林边 | 日\n\n## S2 | 外景 · 古塔 | 日', state, '新的正文。', null)
  assert.match(result.screenplay, /^## S5/)
  assert.match(result.screenplay, /新的正文/)
  assert.doesNotMatch(result.screenplay, /林边/)
  const saved = '## S5 | 外景 · 古塔 | 日\n旧内容。'
  assert.match(currentTurnScreenplay(saved.replace('旧内容', '修改后内容'), saved), /修改后内容/)
  assert.equal(currentTurnScreenplay(`${saved}\n${saved}`, saved), '')
  assert.equal(sceneIdFromScreenplay(saved, [
    { id: 1, location: '古塔', time: '夜' },
    { id: 2, location: '古塔附近', time: '日' },
  ]), null)
})

test('turn screenplay follows unique scene numbers after heading edits', () => {
  const saved = '## S3 | 外景 · 古塔 | 日\n旧正文。\n\n## S4 | 内景 · 大厅 | 日\n旧对白。'
  const edited = '## S3 | 内景 · 古塔门厅 | 深夜\n我敲响铁门。\n\n## S4 | 外景 · 庭院 | 清晨\n我走向庭院。'
  const preceding = '## S2 | 外景 · 林边 | 夜\n上一回合。'
  const following = '## S5 | 内景 · 密室 | 日\n下一回合。'
  assert.equal(currentTurnScreenplay(`${preceding}\n\n${edited}\n\n${following}`, saved), edited)
  assert.equal(currentTurnScreenplay(`${edited}\n\n${edited}`, saved), '')
  assert.equal(currentTurnScreenplay(edited.replace('## S4', '## S6'), saved), '')
})

test('studio script tools keep their normal read and save behavior', async () => {
  const session = await prepareSession('制作台改写')
  await db.update(schema.episodes).set({ content: '制作台原文', scriptContent: '旧剧本' }).where(eq(schema.episodes.id, session.episode_id))
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id })
  const read = await scriptTools.readEpisodeScript.execute!({}, { requestContext } as any) as any
  assert.equal(read.content, '制作台原文')
  await scriptTools.saveScript.execute!({ content: '制作台新剧本' }, { requestContext } as any)
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
  assert.equal(episode.scriptContent, '制作台新剧本')
})

test('old turn rows survive the screenplay migration', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec("CREATE TABLE rpg_turns (id INTEGER PRIMARY KEY, session_id INTEGER, turn_index INTEGER, narrative TEXT); INSERT INTO rpg_turns VALUES (1, 1, 1, 'old')")
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)
    assert.deepEqual(sqlite.prepare('SELECT narrative, screenplay FROM rpg_turns').get(), { narrative: 'old', screenplay: null })
  } finally {
    sqlite.close()
  }
})
