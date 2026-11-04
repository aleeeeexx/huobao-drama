import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  architectureIncomplete,
  cleanResponse,
  createNovelProject,
  exportNovelToMarkdown,
  exportNovelToText,
  generateArchitecture,
  generateChapterBlueprint,
  generateChapterDraft,
  NOVEL_DEFAULT_CHAPTER_COUNT,
  NOVEL_DEFAULT_WORD_NUMBER,
  parseChapterBlueprint,
  produceNovelChapter,
  type NovelProject,
} from '../src/services/novel/generator.ts'
import { NOVEL_PREVIOUS_TEXT_CHARS } from '../src/services/novel/ai-novel-flow.ts'
import { PLAY_NOVEL_CHAPTER_CHARS } from '../src/services/rpg/turn.ts'

const BLUEPRINT = [
  '第1章 - 雨夜回城',
  '本章定位：开端',
  '核心作用：把主角放回茶寮',
  '悬念密度：平缓',
  '伏笔操作：埋设(茶券)',
  '认知颠覆：★☆☆☆☆',
  '本章简述：记者在雨里看见茶寮亮灯',
  '',
  '第2章 - 推门',
  '本章定位：推进',
  '核心作用：写下推门的后果',
  '悬念密度：渐进',
  '伏笔操作：强化(无署名的信)',
  '认知颠覆：★★☆☆☆',
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
    fullPlot: '雨夜的完整故事',
    ...overrides,
  }
}

function settingAnswer(prompt: string): string {
  if (prompt.includes('零散创意')) return JSON.stringify({ plot: '雨夜茶寮从回城写到真相大白。' })
  if (prompt.includes('提炼出清晰的小说构思要素')) {
    return JSON.stringify({
      genre: '科幻',
      tone: '冷',
      target_audience: '成年读者',
      core_idea: '记者回来找一张茶券。',
    })
  }
  if (prompt.includes('雪花写作法')) {
    return JSON.stringify({ core_seed: '当记者看见茶券，必须推门，否则雨会把真相淹没。' })
  }
  if (prompt.includes('构建小说的整体设定')) {
    return JSON.stringify({
      title: '生成的书名',
      subtitle: '雨夜里的茶券',
      introduction: '有人在雨里回到茶寮。',
      summary: '记者推门之后，茶券把旧案重新打开。',
      worldview: '江城的茶寮按旧规矩留灯。',
      writing_style: '冷',
      narrative_pov: '第一人称',
      era_background: '当代',
      tags: ['悬疑', '雨夜'],
    })
  }
  throw new Error(`unexpected setting prompt: ${prompt.slice(0, 40)}`)
}

function planAnswer(): string {
  return JSON.stringify({
    chapters: [{
      title: '雨夜回城',
      summary: '看见茶寮亮灯',
      planning: {
        goal: '把人带回茶寮',
        start_state: '人在雨里',
        end_state: '站在门外',
        beats: ['看见灯'],
        pov_character_id: null,
        must_include: ['茶券'],
        must_avoid: [],
        target_word_count: 3000,
      },
    }],
  })
}

test('novel project uses the original chapter count and word number', () => {
  const created = createNovelProject({ title: '雾隐茶寮', topic: '雨夜' })
  assert.equal(created.numberOfChapters, NOVEL_DEFAULT_CHAPTER_COUNT)
  assert.equal(created.wordNumber, NOVEL_DEFAULT_WORD_NUMBER)
  assert.equal(NOVEL_DEFAULT_WORD_NUMBER, PLAY_NOVEL_CHAPTER_CHARS)
  assert.equal(created.chapters && Object.keys(created.chapters).length, 0)
})

test('continuation uses the saved previous chapter inside the write prompt', async () => {
  const prompts: string[] = []
  const draft = await generateChapterDraft(project(), 2, async (prompt) => {
    prompts.push(prompt)
    return '灯还没灭。我推开了门。'
  })
  assert.equal(draft, '灯还没灭。我推开了门。')
  const prompt = prompts[0]
  assert.match(prompt, /依据当前章计划完成本章正文/)
  assert.match(prompt, /灯花爆了一下/)
  assert.match(prompt, /甲甲甲/)
  assert.match(prompt, /正文使用第一人称/)
  assert.match(prompt, /写下推门的后果/)
  assert.equal(prompt.includes('前章结尾段'), false)
  const previous = project().chapters['1']
  assert.equal(prompt.includes(previous), true)

  const openingPrompts: string[] = []
  await generateChapterDraft(project({ chapters: {} }), 1, async (prompt) => {
    openingPrompts.push(prompt)
    return '雨还在下。'
  })
  assert.match(openingPrompts[0], /"previous_text":""/)
  assert.equal(openingPrompts[0].includes('灯花爆了一下'), false)
})

test('a long previous chapter keeps its ending and marks the cut', async () => {
  const opening = '开头标记不应再出现。'
  const ending = '结尾标记还在门外。'
  const previous = opening + '中'.repeat(NOVEL_PREVIOUS_TEXT_CHARS) + ending
  const prompts: string[] = []
  await generateChapterDraft(project({ chapters: { '1': previous } }), 2, async (prompt) => {
    prompts.push(prompt)
    return '我推开了门。'
  })
  assert.match(prompts[0], /前文开头已截断/)
  assert.match(prompts[0], /结尾标记还在门外/)
  assert.equal(prompts[0].includes(opening), false)
})

test('setting resumes after the compressed story and does not replace a chosen title', async () => {
  const steps: string[] = []
  const empty = createNovelProject({
    title: '雾隐茶寮',
    topic: '雨夜的茶寮',
    genre: '悬疑',
    userGuidance: '正文使用第一人称「我」。',
  })
  const built = await generateArchitecture(empty, async (prompt) => {
    steps.push(prompt)
    return settingAnswer(prompt)
  })
  assert.equal(built.architectureGenerated, true)
  assert.equal(built.title, '雾隐茶寮')
  assert.equal(built.generatedTitle, '生成的书名')
  assert.equal(built.genre, '悬疑')
  assert.equal(built.extractedGenre, '科幻')
  assert.match(built.fullPlot, /真相大白/)
  assert.match(built.coreSeed, /茶券/)
  assert.equal(built.coreIdea, '记者回来找一张茶券。')
  assert.match(built.worldBuilding, /旧规矩/)
  assert.equal(steps.length, 4)
  assert.match(steps[0], /零散创意/)
  assert.match(steps[0], /正文使用第一人称/)
  assert.match(steps[2], /雪花写作法/)
  const again = await generateArchitecture(built, async () => {
    throw new Error('不应重跑已经写好的设定')
  })
  assert.equal(again.coreSeed, built.coreSeed)

  const resumed: string[] = []
  const partial = await generateArchitecture({
    ...built,
    architectureGenerated: false,
    worldBuilding: '',
    bookSummary: '',
  }, async (prompt) => {
    resumed.push(prompt)
    return settingAnswer(prompt)
  })
  assert.equal(resumed.length, 1)
  assert.match(resumed[0], /构建小说的整体设定/)
  assert.equal(partial.fullPlot, built.fullPlot)
  assert.match(partial.worldBuilding, /旧规矩/)
})

test('chapter plans are appended one chapter at a time and keep the old outline readable', async () => {
  const built = project({ chapterBlueprint: '', blueprintGenerated: false, numberOfChapters: 20 })
  const prompts: string[] = []
  const blueprint = await generateChapterBlueprint(built, async (prompt) => {
    prompts.push(prompt)
    return planAnswer()
  }, { throughChapter: 1 })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /根据当前场景规划生成章计划/)
  assert.match(prompts[0], /JSON Schema/)
  assert.equal(prompts[0].includes('设计20章'), false)
  const chapters = parseChapterBlueprint(blueprint)
  assert.equal(chapters[0]?.title, '雨夜回城')
  assert.equal(chapters[0]?.purpose, '把人带回茶寮')
  assert.equal(chapters[0]?.endState, '站在门外')

  const existing = parseChapterBlueprint(BLUEPRINT)
  assert.equal(existing[0]?.title, '雨夜回城')
  assert.equal(existing[1]?.number, 2)
  assert.equal(existing[1]?.purpose, '写下推门的后果')
  assert.equal(cleanResponse('`灯`还没灭。'), '灯还没灭。')
})

test('chapter production fills the setting and only the current plan before the prose', async () => {
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
    if (prompt.includes('根据当前场景规划生成章计划')) return planAnswer()
    if (prompt.includes('依据当前章计划完成本章正文')) return '雨还在下。我推开了茶寮的门。'
    return settingAnswer(prompt)
  }, {
    maxTokens: 8192,
    chapterUserGuidance: `${created.userGuidance}\n\n${action}`,
    onProject: (partial) => {
      savedGuidance.push(partial.userGuidance)
    },
  })

  assert.equal(prompts.filter(prompt => prompt.includes('根据当前场景规划生成章计划')).length, 1)
  assert.equal(prompts.some(prompt => prompt.includes('零散创意') && prompt.includes(action)), false)
  assert.equal(prompts.some(prompt => prompt.includes('根据当前场景规划生成章计划') && prompt.includes(action)), false)
  const draft = prompts.find(prompt => prompt.includes('依据当前章计划完成本章正文')) || ''
  assert.match(draft, /玩家选择了剧情走向/)
  assert.match(draft, /3000/)
  assert.equal(prompts.some(prompt => prompt.includes('以下章节文本较短')), false)
  assert.equal(prompts.some(prompt => prompt.includes('更新前文摘要')), false)
  assert.equal(result.chapterText, '雨还在下。我推开了茶寮的门。')
  assert.equal(result.project.title, '雾隐茶寮')
  assert.equal(result.project.characterState, '站在门外')
  assert.equal(result.project.userGuidance, created.userGuidance)
  assert.equal(result.project.chapters['1'], result.chapterText)
  assert.equal(result.project.blueprintGenerated, false)
  assert.equal(maxPlanned(result.project), 1)
  assert.equal(savedGuidance.every(guidance => guidance === created.userGuidance), true)
  assert.equal(architectureIncomplete(result.project), false)
})

test('an existing outline is not replanned, and a blank draft is rejected', async () => {
  const ready = project({ wordNumber: 4 })
  const prompts: string[] = []
  const written = await produceNovelChapter(ready, 2, async (prompt) => {
    prompts.push(prompt)
    return '灯还没灭。我推开了门。'
  }, {
    normalizeChapterText: text => text.replace('灯', '灯火'),
  })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /依据当前章计划完成本章正文/)
  assert.equal(prompts.some(prompt => prompt.includes('根据当前场景规划生成章计划')), false)
  assert.equal(written.chapterText, '灯火还没灭。我推开了门。')
  assert.equal(written.project.characterState, '掌柜认出茶券')

  await assert.rejects(
    () => produceNovelChapter(ready, 1, async () => '   '),
    /这一幕没有写完/,
  )
})

test('markdown export follows the original heading shape', () => {
  const markdown = exportNovelToMarkdown(project({ chapters: { '1': '灯还没灭。' } }))
  assert.match(markdown, /^# 雾隐茶寮/)
  assert.match(markdown, /## 第1章 雨夜回城/)
  assert.match(markdown, /灯还没灭。/)
  assert.match(markdown, /> \*\*类型\*\*：悬疑/)
  const manuscript = exportNovelToText(project({ chapters: { '1': '灯还没灭。' } }))
  assert.match(manuscript, /《雾隐茶寮》/)
  assert.match(manuscript, /第1章 雨夜回城/)
  assert.doesNotMatch(manuscript, /【第1幕】|玩家：/)
})

function maxPlanned(item: NovelProject): number {
  return parseChapterBlueprint(item.chapterBlueprint).reduce((max, chapter) => Math.max(max, chapter.number), 0)
}
