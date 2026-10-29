import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendChapterBlueprint,
  architectureIncomplete,
  blueprintChunkSize,
  chapterPreviousExcerpt,
  cleanResponse,
  createNovelProject,
  exportNovelToMarkdown,
  exportNovelToText,
  finalizeChapter,
  generateArchitecture,
  generateChapterBlueprint,
  generateChapterDraft,
  NOVEL_BLUEPRINT_RECENT_LIMIT,
  NOVEL_CHAPTER_EXCERPT_CHARS,
  NOVEL_DEFAULT_CHAPTER_COUNT,
  NOVEL_DEFAULT_WORD_NUMBER,
  NOVEL_MAX_TOKENS,
  NOVEL_SETTINGS_MAX_TOKENS,
  parseChapterBlueprint,
  produceNovelChapter,
  type NovelProject,
} from '../src/services/novel/generator.ts'
import { chapterPrompts } from '../src/services/novel/chapter.ts'
import { PLAY_NOVEL_CHAPTER_CHARS } from '../src/services/rpg/turn.ts'

const BLUEPRINT = [
  '第1章 - 雨夜回城',
  '本章定位：开端',
  '核心作用：把主角放回茶寮',
  '情感强度：平缓',
  '伏笔操作：埋设(茶券)',
  '情节张力：★☆☆☆☆',
  '本章简述：记者在雨里看见茶寮亮灯',
  '',
  '第2章 - 推门',
  '本章定位：推进',
  '核心作用：写下推门的后果',
  '情感强度：渐进',
  '伏笔操作：强化(无署名的信)',
  '情节张力：★★☆☆☆',
  '本章简述：掌柜认出茶券',
].join('\n')

function project(overrides: Partial<NovelProject> = {}): NovelProject {
  return {
    ...createNovelProject({
      title: '雾隐茶寮',
      topic: '雨夜的茶寮。你是刚回来的记者。',
      genre: '悬疑',
      wordNumber: PLAY_NOVEL_CHAPTER_CHARS,
      userGuidance: '正文使用第一人称「我」。',
    }),
    chapterBlueprint: BLUEPRINT,
    chapters: { '1': '甲'.repeat(1000) + '灯花爆了一下。我站在门外。' },
    globalSummary: '记者回到了江城。',
    characterState: '记者：手里有半张茶券',
    architectureGenerated: true,
    blueprintGenerated: true,
    coreSeed: '一句话核心',
    characterDynamics: '记者和掌柜',
    worldBuilding: '江城雨夜',
    plotArchitecture: '三幕',
    ...overrides,
  }
}

test('novel project uses the original chapter count and word number', () => {
  const created = createNovelProject({ title: '雾隐茶寮', topic: '雨夜' })
  assert.equal(created.numberOfChapters, NOVEL_DEFAULT_CHAPTER_COUNT)
  assert.equal(created.wordNumber, NOVEL_DEFAULT_WORD_NUMBER)
  assert.equal(NOVEL_DEFAULT_WORD_NUMBER, PLAY_NOVEL_CHAPTER_CHARS)
  assert.equal(created.chapters && Object.keys(created.chapters).length, 0)
})

test('continuation attaches by the original next-chapter draft, not a screenplay rewrite', async () => {
  const prompts: string[] = []
  const draft = await generateChapterDraft(project(), 2, async (prompt) => {
    prompts.push(prompt)
    return '灯还没灭。我推开了门。'
  })
  assert.equal(draft, '灯还没灭。我推开了门。')
  const prompt = prompts[0]
  assert.match(prompt, /前章结尾段/)
  assert.match(prompt, /前文摘要/)
  assert.match(prompt, /角色状态/)
  assert.match(prompt, /灯花爆了一下/)
  assert.match(prompt, new RegExp(String(PLAY_NOVEL_CHAPTER_CHARS)))
  assert.match(prompt, /仅返回章节正文文本/)
  assert.match(prompt, /不使用分章节小标题/)
  assert.doesNotMatch(prompt, /read_episode_script|save_script|30-60|角色名：（表情）/)
  const previous = project().chapters['1']
  assert.equal(chapterPreviousExcerpt(previous).length, NOVEL_CHAPTER_EXCERPT_CHARS)
  assert.equal(prompt.includes(chapterPreviousExcerpt(previous)), true)
  assert.equal(prompt.includes(previous), false)

  const openingPrompts: string[] = []
  await generateChapterDraft(project({ chapters: {} }), 1, async (prompt) => {
    openingPrompts.push(prompt)
    return '雨还在下。'
  })
  assert.match(openingPrompts[0], /即将创作：第 1 章/)
  assert.doesNotMatch(openingPrompts[0], /前章结尾段/)
  assert.match(chapterPrompts.firstDraft({ wordNumber: 3000, chapterNumber: 1 }), /字数要求3000字/)
})

test('architecture, blueprint chunk, finalize, and manuscript export follow the novel flow', async () => {
  const steps: string[] = []
  const empty = createNovelProject({
    title: '雾隐茶寮',
    topic: '雨夜的茶寮',
    genre: '悬疑',
    userGuidance: '正文使用第一人称「我」。',
  })
  const built = await generateArchitecture(empty, async (prompt) => {
    steps.push(prompt)
    return `结果:${steps.length}`
  })
  assert.equal(built.architectureGenerated, true)
  assert.match(built.coreSeed, /结果:1/)
  assert.match(built.characterDynamics, /结果:2/)
  assert.match(built.characterState, /结果:3/)
  assert.match(built.worldBuilding, /结果:4/)
  assert.match(built.plotArchitecture, /结果:5/)
  assert.match(steps[0], /雪花写作法/)
  assert.match(steps[2], /角色状态文档/)
  assert.match(steps[3], /物理维度/)
  assert.match(steps[4], /三幕式情节架构/)
  const again = await generateArchitecture(built, async () => {
    throw new Error('不应重跑已经写好的架构')
  })
  assert.equal(again.coreSeed, built.coreSeed)

  const blueprint = await appendChapterBlueprint(built, 1, 1, async (prompt) => {
    assert.match(prompt, /第1章到第1章/)
    assert.match(prompt, /小说架构/)
    assert.doesNotMatch(prompt, /read_episode_script/)
    return BLUEPRINT
  })
  const chapters = parseChapterBlueprint(blueprint)
  assert.equal(chapters[0]?.title, '雨夜回城')
  assert.equal(chapters[1]?.number, 2)
  assert.equal(chapters[1]?.purpose, '写下推门的后果')

  const finalized = await finalizeChapter(project(), 2, '灯还没灭。', async (prompt) => {
    if (prompt.includes('前文摘要')) return '摘要更新'
    return '记者：推开了门'
  })
  assert.equal(finalized.globalSummary, '摘要更新')
  assert.equal(finalized.characterState, '记者：推开了门')

  const manuscript = exportNovelToText(project({
    chapters: { '1': '灯还没灭。' },
  }))
  assert.match(manuscript, /《雾隐茶寮》/)
  assert.match(manuscript, /第1章 雨夜回城/)
  assert.match(manuscript, /灯还没灭。/)
  assert.doesNotMatch(manuscript, /【第1幕】|玩家：/)
  assert.equal(cleanResponse('`灯`还没灭。'), '灯还没灭。')
})

test('blueprint chunk width matches the original max_tokens formula', () => {
  assert.equal(NOVEL_SETTINGS_MAX_TOKENS, 8192)
  assert.equal(blueprintChunkSize(8192, 100), 30)
  assert.equal(blueprintChunkSize(8192, 20), 20)
  assert.equal(blueprintChunkSize(NOVEL_MAX_TOKENS, 100), 70)
  assert.equal(blueprintChunkSize(undefined, 100), 30)
})

test('empty blueprint is one shot when the chunk fits, otherwise token-sized chunks', async () => {
  const base = createNovelProject({
    title: '雾隐茶寮',
    topic: '雨夜的茶寮',
    genre: '悬疑',
    numberOfChapters: 20,
    userGuidance: '正文使用第一人称「我」。',
  })
  const oneShot: string[] = []
  const once = await generateChapterBlueprint({
    ...base,
    coreSeed: '核心',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
  }, async (prompt) => {
    oneShot.push(prompt)
    return '第1章 - 雨夜回城\n本章简述：到了'
  }, { maxTokens: 8192 })
  assert.equal(oneShot.length, 1)
  assert.match(oneShot[0], /设计20章的节奏分布/)
  assert.doesNotMatch(oneShot[0], /现在请设计第/)
  assert.match(once, /雨夜回城/)

  const resumed: string[] = []
  await generateChapterBlueprint({
    ...base,
    coreSeed: '核心',
    chapterBlueprint: '第1章 - 已有\n本章简述：有了',
  }, async (prompt) => {
    resumed.push(prompt)
    return '第2章 - 后续\n本章简述：接着'
  }, { maxTokens: 8192 })
  assert.equal(resumed.length, 1)
  assert.match(resumed[0], /现在请设计第2章到第20章/)
  assert.match(resumed[0], /已有/)

  const ranges: string[] = []
  await generateChapterBlueprint({
    ...base,
    numberOfChapters: 100,
    coreSeed: '核心',
  }, async (prompt) => {
    const found = prompt.match(/现在请设计第(\d+)章到第(\d+)章/)
    ranges.push(found ? `${found[1]}-${found[2]}` : 'one-shot')
    return `第${found?.[1] || 0}章 - 段`
  }, { maxTokens: 8192 })
  assert.deepEqual(ranges, ['1-30', '31-60', '61-90', '91-100'])

  const played: string[] = []
  await generateChapterBlueprint({
    ...base,
    numberOfChapters: 100,
    coreSeed: '核心',
  }, async (prompt) => {
    const found = prompt.match(/现在请设计第(\d+)章到第(\d+)章/)
    played.push(found ? `${found[1]}-${found[2]}` : 'one-shot')
    return `第${found?.[1] || 0}章 - 段`
  }, { maxTokens: NOVEL_MAX_TOKENS })
  assert.deepEqual(played, ['1-70', '71-100'])
})

test('chunked blueprint only sends the latest 100 chapters', async () => {
  const blocks = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1
    const marker = number === 1 ? 'MARKER_FIRST' : number === 6 ? 'MARKER_KEEP' : number === 105 ? 'MARKER_LAST' : `章${number}`
    return `第${number}章 - ${marker}\n本章简述：${marker}`
  })
  let seen = ''
  const project = {
    ...createNovelProject({
      title: '雾隐茶寮',
      topic: '雨夜',
      genre: '悬疑',
      numberOfChapters: 110,
    }),
    chapterBlueprint: blocks.join('\n\n'),
  }
  assert.equal(NOVEL_BLUEPRINT_RECENT_LIMIT, 100)
  await generateChapterBlueprint(project, async (prompt) => {
    seen = prompt
    return '第106章 - 新\n本章简述：新'
  }, { maxTokens: 8192 })
  assert.match(seen, /现在请设计第106章到第110章/)
  assert.match(seen, /MARKER_KEEP/)
  assert.match(seen, /MARKER_LAST/)
  assert.doesNotMatch(seen, /MARKER_FIRST/)
})

function blueprintText(): string {
  return [
    '第1章 - 雨夜回城',
    '本章定位：开端',
    '核心作用：入城',
    '本章简述：记者看见茶寮',
    '',
    '第2章 - 推门',
    '本章定位：推进',
    '核心作用：进门',
    '本章简述：掌柜抬头',
    '',
    '第3章 - 问茶',
    '本章定位：升温',
    '核心作用：问出茶券',
    '本章简述：茶券见光',
  ].join('\n')
}

test('chapter production fills architecture and the whole blueprint before the draft', async () => {
  const prompts: string[] = []
  const savedGuidance: string[] = []
  const action = '玩家选择了剧情走向：「推门」'
  const created = createNovelProject({
    title: '雾隐茶寮',
    topic: '雨夜的茶寮',
    genre: '悬疑',
    numberOfChapters: 20,
    wordNumber: 3000,
    userGuidance: '正文使用第一人称「我」。',
  })
  const result = await produceNovelChapter(created, 1, async (prompt) => {
    prompts.push(prompt)
    if (prompt.includes('现在请设计第')) throw new Error('20 章应一次性生成大纲')
    if (prompt.includes('设计20章的节奏分布')) return `${blueprintText()}\n第20章 - 收束\n本章简述：还远`
    if (prompt.includes('雪花写作法')) return '核心种子'
    if (prompt.includes('核心驱动力三角')) return '角色动力学'
    if (prompt.includes('请生成一个角色状态文档')) return '初始状态'
    if (prompt.includes('物理维度')) return '世界观'
    if (prompt.includes('三幕式情节架构')) return '情节架构'
    if (prompt.includes('即将创作：第 1 章')) return '雨'
    if (prompt.includes('以下章节文本较短')) return '雨还在下。我推开了茶寮的门。'
    if (prompt.includes('请根据本章新增内容，更新前文摘要')) return '摘要更新'
    if (prompt.includes('请更新主要角色状态')) return '记者：进了门'
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
  }, {
    maxTokens: 8192,
    chapterUserGuidance: `${created.userGuidance}\n\n${action}`,
    onProject: (partial) => {
      savedGuidance.push(partial.userGuidance)
    },
  })

  assert.equal(prompts.filter(prompt => prompt.includes('设计20章的节奏分布')).length, 1)
  assert.equal(prompts.some(prompt => prompt.includes('雪花写作法') && prompt.includes(action)), false)
  assert.equal(prompts.some(prompt => prompt.includes('设计20章的节奏分布') && prompt.includes(action)), false)
  const draft = prompts.find(prompt => prompt.includes('即将创作：第 1 章')) || ''
  assert.match(draft, /玩家选择了剧情走向/)
  const enrich = prompts.find(prompt => prompt.includes('以下章节文本较短')) || ''
  assert.match(enrich, /雨/)
  assert.doesNotMatch(enrich, /玩家选择了剧情走向/)
  assert.match(prompts.find(prompt => prompt.includes('更新前文摘要')) || '', /茶寮的门/)
  assert.equal(result.chapterText, '雨还在下。我推开了茶寮的门。')
  assert.equal(result.project.globalSummary, '摘要更新')
  assert.equal(result.project.characterState, '记者：进了门')
  assert.equal(result.project.userGuidance, created.userGuidance)
  assert.equal(result.project.chapters['1'], result.chapterText)
  assert.equal(result.project.blueprintGenerated, true)
  assert.equal(savedGuidance.every(guidance => guidance === created.userGuidance), true)
  assert.equal(architectureIncomplete(result.project), false)
})

test('a short draft is expanded once, a long draft is finalized as written', async () => {
  const ready = {
    ...createNovelProject({
      title: '雾隐茶寮',
      topic: '雨夜',
      genre: '悬疑',
      numberOfChapters: 3,
      wordNumber: 8,
      userGuidance: '正文使用第一人称「我」。',
    }),
    coreSeed: '核心',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    characterState: '记者：在门外',
    chapterBlueprint: blueprintText(),
    architectureGenerated: true,
    blueprintGenerated: true,
    chapters: { '1': '甲'.repeat(1000) + '灯花爆了一下。我站在门外。' },
    globalSummary: '记者回到了江城。',
  }
  const shortPrompts: string[] = []
  const expanded = await produceNovelChapter(ready, 2, async (prompt) => {
    shortPrompts.push(prompt)
    if (prompt.includes('前章结尾段')) return '短'
    if (prompt.includes('以下章节文本较短')) return '灯还没灭。我推开了门，掌柜抬起头。'
    if (prompt.includes('更新前文摘要')) return '进了门'
    if (prompt.includes('请更新主要角色状态')) return '记者：在门内'
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
  })
  assert.match(shortPrompts.find(prompt => prompt.includes('前章结尾段')) || '', /第3章《问茶》/)
  assert.doesNotMatch(shortPrompts.find(prompt => prompt.includes('前章结尾段')) || '', /未定/)
  assert.equal(expanded.chapterText, '灯还没灭。我推开了门，掌柜抬起头。')

  const longPrompts: string[] = []
  const kept = await produceNovelChapter({ ...ready, wordNumber: 4 }, 2, async (prompt) => {
    longPrompts.push(prompt)
    if (prompt.includes('前章结尾段')) return '灯还没灭。我推开了门。'
    if (prompt.includes('更新前文摘要')) return '进了门'
    if (prompt.includes('请更新主要角色状态')) return '记者：在门内'
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
  })
  assert.equal(longPrompts.some(prompt => prompt.includes('以下章节文本较短')), false)
  assert.equal(kept.chapterText, '灯还没灭。我推开了门。')
})

test('enrich and finalize failures still keep the drafted chapter', async () => {
  const ready = {
    ...createNovelProject({
      title: '雾隐茶寮',
      topic: '雨夜',
      genre: '悬疑',
      numberOfChapters: 3,
      wordNumber: 20,
      userGuidance: '正文使用第一人称「我」。',
    }),
    coreSeed: '核心',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    characterState: '记者：在门外',
    chapterBlueprint: blueprintText(),
    architectureGenerated: true,
    blueprintGenerated: true,
    globalSummary: '记者回到了江城。',
  }
  const originalError = console.error
  console.error = () => {}
  try {
    const enrichFailed = await produceNovelChapter(ready, 1, async (prompt) => {
      if (prompt.includes('即将创作')) return '雨'
      if (prompt.includes('以下章节文本较短')) throw new Error('扩写中断')
      if (prompt.includes('更新前文摘要')) return '摘要还在'
      if (prompt.includes('请更新主要角色状态')) return '记者：没动'
      throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
    })
    assert.equal(enrichFailed.chapterText, '雨')
    assert.equal(enrichFailed.project.globalSummary, '摘要还在')

    const finalizeFailed = await produceNovelChapter({ ...ready, wordNumber: 2 }, 1, async (prompt) => {
      if (prompt.includes('即将创作')) return '雨还在下。'
      if (prompt.includes('更新前文摘要')) throw new Error('定稿中断')
      throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
    })
    assert.equal(finalizeFailed.chapterText, '雨还在下。')
    assert.equal(finalizeFailed.project.chapters['1'], '雨还在下。')
    assert.equal(finalizeFailed.project.globalSummary, '记者回到了江城。')
    assert.equal(finalizeFailed.project.characterState, '记者：在门外')
  } finally {
    console.error = originalError
  }
})

test('missing character state is filled without rerunning the rest of the architecture', async () => {
  const prompts: string[] = []
  const filled = await generateArchitecture({
    ...createNovelProject({ title: '雾隐茶寮', topic: '雨夜', genre: '悬疑' }),
    coreSeed: '核心',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    architectureGenerated: true,
  }, async (prompt) => {
    prompts.push(prompt)
    return '补上的状态'
  })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /角色状态文档/)
  assert.equal(filled.characterState, '补上的状态')
  assert.equal(filled.coreSeed, '核心')
})

test('markdown export follows the original heading shape', () => {
  const markdown = exportNovelToMarkdown(project({ chapters: { '1': '灯还没灭。' } }))
  assert.match(markdown, /^# 雾隐茶寮/)
  assert.match(markdown, /## 第1章 雨夜回城/)
  assert.match(markdown, /灯还没灭。/)
  assert.match(markdown, /> \*\*类型\*\*：悬疑/)
})
