import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendChapterBlueprint,
  chapterPreviousExcerpt,
  cleanResponse,
  createNovelProject,
  exportNovelToText,
  finalizeChapter,
  generateArchitecture,
  generateChapterDraft,
  NOVEL_CHAPTER_EXCERPT_CHARS,
  NOVEL_DEFAULT_CHAPTER_COUNT,
  NOVEL_DEFAULT_WORD_NUMBER,
  parseChapterBlueprint,
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
