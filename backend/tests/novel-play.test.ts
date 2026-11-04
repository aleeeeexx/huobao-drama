import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createNovelProject,
  NOVEL_DEFAULT_CHAPTER_COUNT,
  NOVEL_DEFAULT_WORD_NUMBER,
  type NovelProject,
} from '../src/services/novel/generator.ts'
import {
  chapterGuidanceForDraft,
  novelWritePhase,
  parseChapterNote,
  parseNovelBookInput,
  phaseForNovelPrompt,
  writeOriginalChapter,
} from '../src/services/novel/play-flow.ts'
import { STUDIO_SCRIPT_REWRITE_MESSAGE } from '../src/services/studio-script.ts'
import { visibleNarrative } from '../src/services/rpg/turn.ts'

const SCREENPLAY_LINE = '掌柜：（抬头）进来吧。灯还亮着，雨没停。'

function readyProject(overrides: Partial<NovelProject> = {}): NovelProject {
  return {
    ...createNovelProject({
      title: '雾隐茶寮',
      topic: '雨夜的茶寮里，记者回来找一张没有署名的茶券。',
      genre: '悬疑',
      userGuidance: '保留茶券这条线。',
      numberOfChapters: 2,
      wordNumber: 4,
    }),
    coreSeed: '核心',
    characterDynamics: '记者和掌柜',
    characterState: '记者：站在门外',
    worldBuilding: '江城雨夜',
    plotArchitecture: '三幕',
    chapterBlueprint: [
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
    ].join('\n'),
    chapters: { '1': '灯还亮着。我站在门外。' },
    globalSummary: '记者回到了江城。',
    architectureGenerated: true,
    blueprintGenerated: true,
    ...overrides,
  }
}

test('starting a book keeps the original chapter count and word number', () => {
  const parsed = parseNovelBookInput({ title: '雾隐茶寮', topic: '雨夜茶寮' })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.book.numberOfChapters, NOVEL_DEFAULT_CHAPTER_COUNT)
  assert.equal(parsed.book.wordNumber, NOVEL_DEFAULT_WORD_NUMBER)
  assert.equal(parsed.book.userGuidance, '')
  assert.equal(parsed.book.genre, '其他')
  const project = createNovelProject(parsed.book)
  assert.equal(project.userGuidance.includes('第一人称'), false)
})

test('book input rejects an empty topic and an out-of-range chapter count', () => {
  assert.equal(parseNovelBookInput({ title: '雾隐茶寮', topic: '雨' }).ok, false)
  const chapters = parseNovelBookInput({ title: '雾隐茶寮', topic: '雨夜茶寮', number_of_chapters: 0 })
  assert.equal(chapters.ok, false)
  const note = parseChapterNote('雨'.repeat(501))
  assert.equal(note.ok, false)
})

test('an empty chapter note does not replace the book guidance', () => {
  assert.equal(chapterGuidanceForDraft('保留茶券', ''), undefined)
  assert.equal(chapterGuidanceForDraft('保留茶券', ' 让雨更大 '), '保留茶券\n\n让雨更大')
})

test('phase labels follow the setting, plan, and chapter prompts', () => {
  assert.equal(phaseForNovelPrompt('你是一名资深小说策划编辑，擅长将一个零散创意，扩写为一整本书。'), 'architecture')
  assert.equal(phaseForNovelPrompt('你是一名资深小说编辑, 请从用户提供的长篇小说压缩剧情中提炼出清晰的小说构思要素。'), 'architecture')
  assert.equal(phaseForNovelPrompt('作为专业作家, 请用“雪花写作法”第一步构建故事核心。'), 'architecture')
  assert.equal(phaseForNovelPrompt('你是一名专业小说策划人, 请基于以下信息构建小说的整体设定。'), 'architecture')
  assert.equal(phaseForNovelPrompt('你是小说作者的写作助手。根据当前场景规划生成章计划。每章填写目标。'), 'blueprint')
  assert.equal(phaseForNovelPrompt('你是小说作者的写作助手。依据当前章计划完成本章正文。只输出正文。'), 'draft')
  assert.equal(phaseForNovelPrompt('以下是新完成的章节文本：\n即将创作：这段是正文，不是新的草稿提示词'), 'finalize')
  assert.equal(phaseForNovelPrompt('以下章节文本较短，请扩写。'), 'enrich')
})

function settingAnswer(prompt: string): string {
  if (prompt.includes('零散创意')) return JSON.stringify({ plot: '雨夜茶寮从回城写到茶券见光。' })
  if (prompt.includes('提炼出清晰的小说构思要素')) {
    return JSON.stringify({ genre: '悬疑', tone: '冷', target_audience: '成年读者', core_idea: '记者回来找茶券。' })
  }
  if (prompt.includes('雪花写作法')) return JSON.stringify({ core_seed: '当记者看见茶券，必须推门，否则旧案继续被雨盖住。' })
  if (prompt.includes('构建小说的整体设定')) {
    return JSON.stringify({
      title: '生成的书名',
      subtitle: '雨夜',
      introduction: '有人回到茶寮。',
      summary: '茶券把人留在门口。',
      worldview: '江城的茶寮按旧规矩留灯。',
      writing_style: '冷',
      narrative_pov: '第一人称',
      era_background: '当代',
      tags: ['悬疑'],
    })
  }
  throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`)
}

test('the first chapter runs setting, one chapter plan, and the manuscript without rewriting it', async () => {
  const phases: string[] = []
  const prompts: string[] = []
  const project = createNovelProject({
    title: '雾隐茶寮',
    topic: '雨夜的茶寮里，记者回来找一张没有署名的茶券。',
    genre: '悬疑',
    userGuidance: '保留茶券这条线。',
    numberOfChapters: 2,
    wordNumber: 80,
  })
  const result = await writeOriginalChapter(project, 1, async (prompt) => {
    prompts.push(prompt)
    const phase = phaseForNovelPrompt(prompt)
    if (phase) phases.push(phase)
    if (phase === 'blueprint') {
      return JSON.stringify({
        chapters: [{
          title: '雨夜回城',
          summary: '看见茶寮',
          planning: { goal: '回到门口', start_state: '在雨里', end_state: '记者：推开了门', beats: ['茶券'] },
        }],
      })
    }
    if (phase === 'draft') return SCREENPLAY_LINE
    return settingAnswer(prompt)
  }, {
    onPhase: (phase) => { phases.push(phase) },
  })

  assert.equal(phases.includes('architecture'), true)
  assert.equal(phases.includes('blueprint'), true)
  assert.equal(phases.includes('draft'), true)
  assert.equal(phases.includes('enrich'), false)
  assert.equal(phases.includes('finalize'), false)
  assert.equal(prompts.some(prompt => prompt.includes(STUDIO_SCRIPT_REWRITE_MESSAGE)), false)
  const planAt = prompts.findIndex(prompt => prompt.includes('根据当前场景规划生成章计划'))
  const draftAt = prompts.findIndex(prompt => prompt.includes('依据当前章计划完成本章正文'))
  assert.ok(planAt > 0 && draftAt > planAt)
  assert.equal(result.chapterText, SCREENPLAY_LINE)
  assert.notEqual(visibleNarrative(SCREENPLAY_LINE), SCREENPLAY_LINE)
  assert.equal(result.project.chapters['1'], SCREENPLAY_LINE)
  assert.equal(result.project.userGuidance, '保留茶券这条线。')
  assert.equal(result.project.characterState, '记者：推开了门')
  assert.equal(novelWritePhase(result.project, 1), 'draft')
})

test('the next chapter keeps a chapter note out of the book guidance and uses the saved previous text', async () => {
  const prompts: string[] = []
  const result = await writeOriginalChapter(readyProject(), 2, async (prompt) => {
    prompts.push(prompt)
    if (phaseForNovelPrompt(prompt) === 'draft') return SCREENPLAY_LINE
    return '不应再规划'
  }, { chapterNote: '让雨更大' })

  const draft = prompts.find(prompt => prompt.includes('依据当前章计划完成本章正文'))
  assert.ok(draft)
  assert.match(draft || '', /灯还亮着/)
  assert.match(draft || '', /保留茶券这条线/)
  assert.match(draft || '', /让雨更大/)
  assert.equal(prompts.some(prompt => prompt.includes(STUDIO_SCRIPT_REWRITE_MESSAGE)), false)
  assert.equal(prompts.some(prompt => prompt.includes('根据当前场景规划生成章计划')), false)
  assert.equal(result.chapterText, SCREENPLAY_LINE)
  assert.equal(result.project.userGuidance, '保留茶券这条线。')
  assert.equal(result.project.chapters['2'], SCREENPLAY_LINE)
  assert.equal(result.project.characterState, '掌柜认出茶券')
})
