import { test } from 'node:test'
import assert from 'node:assert/strict'
import { architecturePrompts } from '../src/services/novel/architecture.ts'
import { chapterPrompts } from '../src/services/novel/chapter.ts'
import { utilityPrompts } from '../src/services/novel/utility.ts'
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

test('phase labels follow the original prompt openings, including text embedded in a later step', () => {
  const params = {
    topic: '雨',
    genre: '悬疑',
    numberOfChapters: 2,
    wordNumber: 300,
    userGuidance: '保留茶券',
    coreSeed: '核心',
    characterDynamics: '人物',
    characterState: '状态',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    novelArchitecture: '物理维度：被嵌进大纲的世界观',
    chapterNumber: 1,
    chapterTitle: '雨夜',
    chapterText: '即将创作：这段是正文，不是新的草稿提示词',
  }
  assert.equal(phaseForNovelPrompt(architecturePrompts.coreSeed(params)), 'architecture')
  assert.equal(phaseForNovelPrompt(architecturePrompts.characterDynamics(params)), 'architecture')
  assert.equal(phaseForNovelPrompt(architecturePrompts.characterState(params)), 'architecture')
  assert.equal(phaseForNovelPrompt(architecturePrompts.worldBuilding(params)), 'architecture')
  assert.equal(phaseForNovelPrompt(architecturePrompts.plotArchitecture(params)), 'architecture')
  assert.equal(phaseForNovelPrompt(chapterPrompts.blueprint(params)), 'blueprint')
  assert.equal(phaseForNovelPrompt(chapterPrompts.blueprintChunked({ ...params, startChapter: 1, endChapter: 2 })), 'blueprint')
  assert.equal(phaseForNovelPrompt(chapterPrompts.firstDraft(params)), 'draft')
  assert.equal(phaseForNovelPrompt(chapterPrompts.nextDraft(params)), 'draft')
  assert.equal(phaseForNovelPrompt(chapterPrompts.enrich(params)), 'enrich')
  assert.equal(phaseForNovelPrompt(utilityPrompts.summary({ chapterText: params.chapterText, globalSummary: '' })), 'finalize')
  assert.equal(phaseForNovelPrompt(utilityPrompts.updateCharacterState({ chapterText: params.chapterText, oldState: '旧' })), 'finalize')
})

test('the first chapter runs architecture, the full blueprint, draft, enrich and finalize without rewriting the manuscript', async () => {
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
  const blueprint = readyProject().chapterBlueprint
  const result = await writeOriginalChapter(project, 1, async (prompt) => {
    prompts.push(prompt)
    const phase = phaseForNovelPrompt(prompt)
    if (phase) phases.push(phase)
    if (phase === 'blueprint') return blueprint
    if (phase === 'draft') return '短'
    if (phase === 'enrich') return SCREENPLAY_LINE
    if (prompt.includes('角色状态文档')) return '记者：推开了门'
    return '写好的一段'
  }, {
    onPhase: (phase) => { phases.push(phase) },
  })

  assert.equal(phases.includes('architecture'), true)
  assert.equal(phases.includes('blueprint'), true)
  assert.equal(phases.includes('draft'), true)
  assert.equal(phases.includes('enrich'), true)
  assert.equal(phases.includes('finalize'), true)
  assert.equal(prompts.some(prompt => prompt.includes(STUDIO_SCRIPT_REWRITE_MESSAGE)), false)
  assert.equal(prompts.some(prompt => prompt.trimStart().startsWith('作为专业作家')), true)
  assert.equal(prompts.some(prompt => prompt.trimStart().startsWith('依据当前角色动力学设定')), true)
  const statePrompt = prompts.findIndex(prompt => prompt.trimStart().startsWith('依据当前角色动力学设定'))
  const blueprintPrompt = prompts.findIndex(prompt => prompt.includes('章的节奏分布'))
  assert.ok(statePrompt >= 0 && blueprintPrompt > statePrompt)
  assert.equal(result.chapterText, SCREENPLAY_LINE)
  assert.notEqual(visibleNarrative(SCREENPLAY_LINE), SCREENPLAY_LINE)
  assert.equal(result.project.chapters['1'], SCREENPLAY_LINE)
  assert.equal(result.project.userGuidance, '保留茶券这条线。')
  assert.equal(result.project.characterState, '记者：推开了门')
  assert.equal(novelWritePhase(result.project, 1), 'finalize')
})

test('the next chapter uses the original next-chapter draft and keeps a chapter note out of the book guidance', async () => {
  const prompts: string[] = []
  const result = await writeOriginalChapter(readyProject(), 2, async (prompt) => {
    prompts.push(prompt)
    if (phaseForNovelPrompt(prompt) === 'draft') return SCREENPLAY_LINE
    if (prompt.includes('当前的角色状态文档')) return '记者：进了门'
    return '摘要更新'
  }, { chapterNote: '让雨更大' })

  const draft = prompts.find(prompt => prompt.trimStart().startsWith('参考文档：'))
  assert.ok(draft)
  assert.match(draft || '', /角色状态/)
  assert.match(draft || '', /保留茶券这条线/)
  assert.match(draft || '', /让雨更大/)
  assert.equal(prompts.some(prompt => prompt.includes(STUDIO_SCRIPT_REWRITE_MESSAGE)), false)
  assert.equal(prompts.some(prompt => prompt.trimStart().startsWith('即将创作：')), false)
  assert.equal(result.chapterText, SCREENPLAY_LINE)
  assert.equal(result.project.userGuidance, '保留茶券这条线。')
  assert.equal(result.project.chapters['2'], SCREENPLAY_LINE)
  assert.equal(result.project.characterState, '记者：进了门')
})
