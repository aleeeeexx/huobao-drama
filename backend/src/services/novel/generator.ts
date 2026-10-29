/**
 * 火宝小说（chatfire-AI/huobao-novel）的生成编排。
 * 步骤、提示词和章节衔接与原项目一致：架构 → 分块大纲 → 章节草稿 → 定稿摘要与角色状态。
 * 模型调用由调用方注入。火宝小说用独立的 chat/completions；织界改走短剧已配置的文本模型。
 */
import { architecturePrompts, type NovelPromptParams } from './architecture.js'
import { chapterPrompts } from './chapter.js'
import { utilityPrompts } from './utility.js'

const {
  coreSeed: coreSeedPrompt,
  characterDynamics: characterDynamicsPrompt,
  worldBuilding: worldBuildingPrompt,
  plotArchitecture: plotArchitecturePrompt,
  characterState: createCharacterStatePrompt,
} = architecturePrompts
const {
  blueprintChunked: chunkedChapterBlueprintPrompt,
  firstDraft: firstChapterDraftPrompt,
  nextDraft: nextChapterDraftPrompt,
} = chapterPrompts
const { summary: summaryPrompt, updateCharacterState: updateCharacterStatePrompt } = utilityPrompts

/** 创建项目对话框的默认章节数。互动续写不一次写完，但架构仍按这部篇幅规划，避免第一章被写成结局。 */
export const NOVEL_DEFAULT_CHAPTER_COUNT = 100
/** 创建项目对话框的默认每章字数。 */
export const NOVEL_DEFAULT_WORD_NUMBER = 3000
/** 后续章节只贴前章结尾，原项目是截取最后 800 字。 */
export const NOVEL_CHAPTER_EXCERPT_CHARS = 800

export type NovelComplete = (prompt: string) => Promise<string>

export interface NovelChapterInfo {
  number: number
  title: string
  position: string
  purpose: string
  suspense: string
  foreshadowing: string
  twistLevel: string
  summary: string
}

export interface NovelProject {
  title: string
  topic: string
  genre: string | string[]
  numberOfChapters: number
  wordNumber: number
  userGuidance: string
  coreSeed: string
  characterDynamics: string
  worldBuilding: string
  plotArchitecture: string
  characterState: string
  chapterBlueprint: string
  chapters: Record<string, string>
  globalSummary: string
  architectureGenerated: boolean
  blueprintGenerated: boolean
}

export function createNovelProject(input: {
  title: string
  topic: string
  genre?: string | string[] | null
  userGuidance?: string
  wordNumber?: number
  numberOfChapters?: number
}): NovelProject {
  return {
    title: input.title,
    topic: input.topic,
    genre: input.genre && (Array.isArray(input.genre) ? input.genre.length : input.genre) ? input.genre : '其他',
    numberOfChapters: input.numberOfChapters ?? NOVEL_DEFAULT_CHAPTER_COUNT,
    wordNumber: input.wordNumber ?? NOVEL_DEFAULT_WORD_NUMBER,
    userGuidance: input.userGuidance || '',
    coreSeed: '',
    characterDynamics: '',
    worldBuilding: '',
    plotArchitecture: '',
    characterState: '',
    chapterBlueprint: '',
    chapters: {},
    globalSummary: '',
    architectureGenerated: false,
    blueprintGenerated: false,
  }
}

export function formatGenre(genre: string | string[] | null | undefined): string {
  if (Array.isArray(genre)) return genre.join(' / ')
  return genre || ''
}

/** 与火宝小说 llm.cleanResponse 相同：去掉模型偶尔套上的代码围栏。 */
export function cleanResponse(text: string): string {
  if (!text) return ''
  return text.replace(/```[\s\S]*?```/g, '').replace(/`/g, '').trim()
}

export function chapterPreviousExcerpt(prevChapter: string): string {
  return (prevChapter || '').slice(-NOVEL_CHAPTER_EXCERPT_CHARS) || '(无前章内容)'
}

export function maxBlueprintChapter(blueprint: string): number {
  const existing = (blueprint || '').match(/第\s*(\d+)\s*章/g) || []
  if (!existing.length) return 0
  return Math.max(...existing.map(item => Number(item.match(/\d+/)?.[0] || 0)))
}

export function buildNovelArchitecture(project: NovelProject): string {
  return `
#=== 0) 小说设定 ===
主题：${project.topic}，类型：${formatGenre(project.genre)}，篇幅：约${project.numberOfChapters}章（每章${project.wordNumber}字）

#=== 1) 核心种子 ===
${project.coreSeed}

#=== 2) 角色动力学 ===
${project.characterDynamics}

#=== 3) 世界观 ===
${project.worldBuilding}

#=== 4) 三幕式情节架构 ===
${project.plotArchitecture}
`
}

export function limitChapterBlueprint(blueprint: string, limit: number): string {
  if (!blueprint) return ''
  const pattern = /(第\s*\d+\s*章.*?)(?=第\s*\d+\s*章|$)/gs
  const chapters = blueprint.match(pattern) || []
  if (chapters.length <= limit) return blueprint
  return chapters.slice(-limit).join('\n\n').trim()
}

export function parseChapterBlueprint(blueprint: string): NovelChapterInfo[] {
  if (!blueprint) return []
  const chapters: NovelChapterInfo[] = []
  const pattern = /第\s*(\d+)\s*章\s*[-–—]\s*(.+?)(?=\n|$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(blueprint)) !== null) {
    const chapterNum = parseInt(match[1], 10)
    const title = match[2].trim()
    const startIndex = match.index
    const endIndex = blueprint.indexOf(`第 ${chapterNum + 1} 章`, startIndex)
    const chapterText = endIndex > -1
      ? blueprint.substring(startIndex, endIndex)
      : blueprint.substring(startIndex)
    chapters.push({
      number: chapterNum,
      title,
      position: extractField(chapterText, '本章定位'),
      purpose: extractField(chapterText, '核心作用'),
      suspense: extractField(chapterText, '悬念密度'),
      foreshadowing: extractField(chapterText, '伏笔操作'),
      twistLevel: extractField(chapterText, '认知颠覆'),
      summary: extractField(chapterText, '本章简述'),
    })
  }
  return chapters
}

function extractField(text: string, fieldName: string): string {
  const pattern = new RegExp(`${fieldName}[：:]\\s*(.+?)(?=\\n|$)`)
  const match = text.match(pattern)
  return match ? match[1].trim() : ''
}

function promptParams(values: Record<string, string | number | undefined>): NovelPromptParams {
  return values
}

/**
 * 生成小说架构。已有字段跳过，和原项目「缺哪步补哪步」一样。
 * onPartial 在每一步写完后回调，方便中断后接着写。
 */
export async function generateArchitecture(
  project: NovelProject,
  complete: NovelComplete,
  onPartial?: (project: NovelProject) => Promise<void> | void,
): Promise<NovelProject> {
  const next = { ...project }
  const params = {
    topic: next.topic,
    genre: formatGenre(next.genre),
    numberOfChapters: next.numberOfChapters,
    wordNumber: next.wordNumber,
    userGuidance: next.userGuidance || '',
  }
  if (!next.coreSeed) {
    next.coreSeed = cleanResponse(await complete(coreSeedPrompt(promptParams(params))))
    await onPartial?.(next)
  }
  if (!next.characterDynamics) {
    next.characterDynamics = cleanResponse(await complete(characterDynamicsPrompt(promptParams({
      ...params,
      coreSeed: next.coreSeed,
    }))))
    await onPartial?.(next)
  }
  if (!next.characterState && next.characterDynamics) {
    next.characterState = cleanResponse(await complete(createCharacterStatePrompt(promptParams({
      characterDynamics: next.characterDynamics,
    }))))
    await onPartial?.(next)
  }
  if (!next.worldBuilding) {
    next.worldBuilding = cleanResponse(await complete(worldBuildingPrompt(promptParams({
      ...params,
      coreSeed: next.coreSeed,
    }))))
    await onPartial?.(next)
  }
  if (!next.plotArchitecture) {
    next.plotArchitecture = cleanResponse(await complete(plotArchitecturePrompt(promptParams({
      ...params,
      coreSeed: next.coreSeed,
      characterDynamics: next.characterDynamics,
      worldBuilding: next.worldBuilding,
    }))))
    await onPartial?.(next)
  }
  next.architectureGenerated = true
  await onPartial?.(next)
  return next
}

/** 用原项目的分块大纲提示词补上 start 到 end 章。已有大纲整段保留在前面。 */
export async function appendChapterBlueprint(
  project: NovelProject,
  startChapter: number,
  endChapter: number,
  complete: NovelComplete,
): Promise<string> {
  const prompt = chunkedChapterBlueprintPrompt(promptParams({
    userGuidance: project.userGuidance || '',
    novelArchitecture: buildNovelArchitecture(project),
    numberOfChapters: project.numberOfChapters,
    chapterList: limitChapterBlueprint(project.chapterBlueprint, 100),
    startChapter,
    endChapter,
  }))
  const chunk = cleanResponse(await complete(prompt))
  if (!chunk) return project.chapterBlueprint
  return project.chapterBlueprint ? `${project.chapterBlueprint}\n\n${chunk}` : chunk
}

const MISSING_NEXT_CHAPTER: NovelChapterInfo = {
  number: 0,
  title: '(未定)',
  position: '过渡章节',
  purpose: '承上启下',
  suspense: '中等',
  foreshadowing: '无特殊伏笔',
  twistLevel: '★☆☆☆☆',
  summary: '衔接过渡内容',
}

/** 生成单章草稿。第一章用 firstDraft，之后用 nextDraft，并只贴前章最后 800 字。 */
export async function generateChapterDraft(
  project: NovelProject,
  chapterNumber: number,
  complete: NovelComplete,
): Promise<string> {
  const chapters = parseChapterBlueprint(project.chapterBlueprint)
  const chapterInfo = chapters.find(item => item.number === chapterNumber)
  if (!chapterInfo) throw new Error(`章节 ${chapterNumber} 不存在于大纲中`)
  const nextChapterInfo = chapters.find(item => item.number === chapterNumber + 1) || {
    ...MISSING_NEXT_CHAPTER,
    number: chapterNumber + 1,
  }
  const novelSetting = `
小说类型：${formatGenre(project.genre)}

核心种子：${project.coreSeed}

角色体系：${project.characterDynamics}

世界观：${project.worldBuilding}

情节架构：${project.plotArchitecture}
`
  const prompt = chapterNumber === 1
    ? firstChapterDraftPrompt(promptParams({
      chapterNumber,
      chapterTitle: chapterInfo.title,
      chapterRole: chapterInfo.position,
      chapterPurpose: chapterInfo.purpose,
      suspenseLevel: chapterInfo.suspense,
      foreshadowing: chapterInfo.foreshadowing,
      plotTwistLevel: chapterInfo.twistLevel,
      chapterSummary: chapterInfo.summary,
      novelSetting,
      wordNumber: project.wordNumber,
      userGuidance: project.userGuidance || '',
    }))
    : nextChapterDraftPrompt(promptParams({
      chapterNumber,
      chapterTitle: chapterInfo.title,
      chapterRole: chapterInfo.position,
      chapterPurpose: chapterInfo.purpose,
      suspenseLevel: chapterInfo.suspense,
      foreshadowing: chapterInfo.foreshadowing,
      plotTwistLevel: chapterInfo.twistLevel,
      chapterSummary: chapterInfo.summary,
      wordNumber: project.wordNumber,
      globalSummary: project.globalSummary || '(这是第一章，暂无前文摘要)',
      previousChapterExcerpt: chapterPreviousExcerpt(project.chapters[String(chapterNumber - 1)] || ''),
      characterState: project.characterState || '(暂无角色状态)',
      userGuidance: project.userGuidance || '',
      shortSummary: '',
      nextChapterNumber: chapterNumber + 1,
      nextChapterTitle: nextChapterInfo.title,
      nextChapterRole: nextChapterInfo.position,
      nextChapterPurpose: nextChapterInfo.purpose,
      nextSuspenseLevel: nextChapterInfo.suspense,
      nextForeshadowing: nextChapterInfo.foreshadowing,
      nextPlotTwistLevel: nextChapterInfo.twistLevel,
      nextChapterSummary: nextChapterInfo.summary,
    }))
  return cleanResponse(await complete(prompt))
}

/** 章节定稿：更新前文摘要和角色状态。这两次调用和原项目 finalizeChapter 相同。 */
export async function finalizeChapter(
  project: NovelProject,
  _chapterNumber: number,
  chapterText: string,
  complete: NovelComplete,
): Promise<{ globalSummary: string; characterState: string }> {
  const globalSummary = cleanResponse(await complete(summaryPrompt(promptParams({
    chapterText,
    globalSummary: project.globalSummary || '',
  }))))
  const characterState = cleanResponse(await complete(updateCharacterStatePrompt(promptParams({
    chapterText,
    oldState: project.characterState || '',
  }))))
  return {
    globalSummary: globalSummary || project.globalSummary,
    characterState: characterState || project.characterState,
  }
}

/** 把已写章节导出成小说纯文本。制作台原始内容存的就是这份原稿。 */
export function exportNovelToText(project: NovelProject): string {
  const lines: string[] = []
  lines.push(`《${project.title}》`)
  lines.push('')
  lines.push(`类型：${formatGenre(project.genre)}`)
  lines.push(`主题：${project.topic}`)
  lines.push('')
  lines.push('='.repeat(50))
  lines.push('')
  const chapterNums = Object.keys(project.chapters || {}).map(Number).filter(item => item > 0).sort((a, b) => a - b)
  const blueprintChapters = parseChapterBlueprint(project.chapterBlueprint)
  for (const num of chapterNums) {
    const info = blueprintChapters.find(item => item.number === num)
    const title = info?.title || `第${num}章`
    lines.push(`第${num}章 ${title}`)
    lines.push('')
    lines.push(project.chapters[String(num)] || '')
    lines.push('')
    lines.push('-'.repeat(30))
    lines.push('')
  }
  return lines.join('\n')
}
