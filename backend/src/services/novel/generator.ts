/**
 * 火宝小说（chatfire-AI/huobao-novel）的生成编排。
 * 步骤和提示词与原项目一致：架构（含角色状态）→ 整本大纲（一次写完或按 max_tokens 分块）→ 章节草稿 → 字数不足则扩写 → 定稿摘要与角色状态。
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
  blueprint: chapterBlueprintPrompt,
  blueprintChunked: chunkedChapterBlueprintPrompt,
  firstDraft: firstChapterDraftPrompt,
  nextDraft: nextChapterDraftPrompt,
  enrich: enrichChapterPrompt,
} = chapterPrompts
const { summary: summaryPrompt, updateCharacterState: updateCharacterStatePrompt } = utilityPrompts

/** 创建项目对话框的默认章节数。互动续写不一次写完，但架构仍按这部篇幅规划，避免第一章被写成结局。 */
export const NOVEL_DEFAULT_CHAPTER_COUNT = 100
/** 创建项目对话框的默认每章字数。 */
export const NOVEL_DEFAULT_WORD_NUMBER = 3000
/** 后续章节只贴前章结尾，原项目是截取最后 800 字。 */
export const NOVEL_CHAPTER_EXCERPT_CHARS = 800
/** 火宝小说设置页默认 max_tokens。大纲分块宽度按请求实际使用的 max_tokens 计算，缺省时用这个值。 */
export const NOVEL_SETTINGS_MAX_TOKENS = 8192
/** 织界章节请求的输出上限。3000 字不能被设置页默认的 8192 截断；大纲分块按这个实际上限计算。 */
export const NOVEL_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16384)
/** 分块大纲提示词只附带最近这么多章。原项目写死 100。 */
export const NOVEL_BLUEPRINT_RECENT_LIMIT = 100
const NOVEL_BLUEPRINT_TOKENS_PER_CHAPTER = 200

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

/** 与火宝小说 generateChapterBlueprint 相同：每章预留 200 token，再按十章取整减 10。 */
export function blueprintChunkSize(maxTokens: number | null | undefined, numberOfChapters: number): number {
  const tokens = maxTokens || NOVEL_SETTINGS_MAX_TOKENS
  const rounded = Math.floor(tokens / NOVEL_BLUEPRINT_TOKENS_PER_CHAPTER / 10) * 10 - 10
  return Math.max(1, Math.min(rounded, numberOfChapters))
}

export function architectureIncomplete(project: NovelProject): boolean {
  return !project.architectureGenerated
    || !project.coreSeed
    || !project.characterDynamics
    || !project.characterState
    || !project.worldBuilding
    || !project.plotArchitecture
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

/**
 * 解析大纲。字段名沿用火宝小说 generator.js：读取「悬念密度 / 认知颠覆」，
 * 不是大纲提示词里的「情感强度 / 情节张力」。
 */
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
    chapterList: limitChapterBlueprint(project.chapterBlueprint, NOVEL_BLUEPRINT_RECENT_LIMIT),
    startChapter,
    endChapter,
  }))
  const chunk = cleanResponse(await complete(prompt))
  if (!chunk) return project.chapterBlueprint
  return project.chapterBlueprint ? `${project.chapterBlueprint}\n\n${chunk}` : chunk
}

export interface BlueprintGenerationOptions {
  /** 本次大纲请求的 max_tokens。决定一次写完还是分块，以及每块多少章。 */
  maxTokens?: number
  onPartial?: (blueprint: string) => Promise<void> | void
}

/**
 * 生成整本大纲。目录还空着、且一块就放得下全部章节时，用一次性 blueprint；
 * 否则从已有最大章号的下一章起，按 chunkSize 调用 blueprintChunked，直到 numberOfChapters。
 */
export async function generateChapterBlueprint(
  project: NovelProject,
  complete: NovelComplete,
  options: BlueprintGenerationOptions = {},
): Promise<string> {
  const numberOfChapters = project.numberOfChapters
  const novelArchitecture = buildNovelArchitecture(project)
  const chunkSize = blueprintChunkSize(options.maxTokens, numberOfChapters)
  let blueprint = project.chapterBlueprint || ''

  if (chunkSize >= numberOfChapters && !blueprint) {
    blueprint = cleanResponse(await complete(chapterBlueprintPrompt(promptParams({
      userGuidance: project.userGuidance,
      novelArchitecture,
      numberOfChapters,
    }))))
    await options.onPartial?.(blueprint)
    return blueprint
  }

  let startChapter = maxBlueprintChapter(blueprint) + 1
  while (startChapter <= numberOfChapters) {
    const endChapter = Math.min(startChapter + chunkSize - 1, numberOfChapters)
    blueprint = await appendChapterBlueprint(
      { ...project, chapterBlueprint: blueprint },
      startChapter,
      endChapter,
      complete,
    )
    await options.onPartial?.(blueprint)
    startChapter = endChapter + 1
  }
  return blueprint
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

/** 扩写章节。原项目是写章面板上的「扩写」按钮，提示词只接收正文和目标字数。 */
export async function enrichChapter(
  chapterText: string,
  wordNumber: number,
  complete: NovelComplete,
): Promise<string> {
  const enrichedText = cleanResponse(await complete(enrichChapterPrompt(promptParams({
    chapterText,
    wordNumber,
  }))))
  return enrichedText || chapterText
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

/** 导出小说为 Markdown。游玩原稿仍用纯文本，制作台读取的是这份 txt 结构。 */
export function exportNovelToMarkdown(project: NovelProject): string {
  const lines: string[] = []
  lines.push(`# ${project.title}`)
  lines.push('')
  lines.push(`> **类型**：${formatGenre(project.genre)}`)
  lines.push(`> **主题**：${project.topic}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  const chapterNums = Object.keys(project.chapters || {}).map(Number).filter(item => item > 0).sort((a, b) => a - b)
  const blueprintChapters = parseChapterBlueprint(project.chapterBlueprint)
  for (const num of chapterNums) {
    const info = blueprintChapters.find(item => item.number === num)
    const title = info?.title || `第${num}章`
    lines.push(`## 第${num}章 ${title}`)
    lines.push('')
    lines.push(project.chapters[String(num)] || '')
    lines.push('')
  }
  return lines.join('\n')
}

export interface NovelChapterProductionOptions {
  /** 大纲请求的 max_tokens，同时决定一次性生成还是分块。 */
  maxTokens?: number
  /**
   * 只注入这一章草稿的用户指导。
   * 不写回项目，也不进入架构和大纲。织界用它放进本回合的玩家行动。
   */
  chapterUserGuidance?: string
  /** 草稿和扩写结果交给玩家之前的整理。缺省则原样保留模型正文。 */
  normalizeChapterText?: (text: string) => string
  onProject?: (project: NovelProject) => Promise<void> | void
}

/**
 * 把火宝小说写一章的按钮按顺序跑完：缺的架构（核心种子 → 角色动力学 → 角色状态 → 世界观 → 情节）→
 * 还没覆盖完全书的大纲 → 草稿 → 正文短于目标字数时扩写一次 → 定稿。
 * 定稿或扩写失败时仍留下草稿，避免这一章白写。灵感罗盘不在这里：下一章草稿不读图谱。
 */
export async function produceNovelChapter(
  project: NovelProject,
  chapterNumber: number,
  complete: NovelComplete,
  options: NovelChapterProductionOptions = {},
): Promise<{ project: NovelProject; chapterText: string }> {
  let next: NovelProject = { ...project, chapters: { ...project.chapters } }
  const persist = async () => {
    await options.onProject?.(next)
  }
  const normalize = options.normalizeChapterText ?? ((text: string) => text)

  if (architectureIncomplete(next)) {
    next = await generateArchitecture(next, complete, async (partial) => {
      next = { ...partial, chapters: { ...partial.chapters } }
      await persist()
    })
    await persist()
  }

  if (maxBlueprintChapter(next.chapterBlueprint) < next.numberOfChapters) {
    const blueprint = await generateChapterBlueprint(next, complete, {
      maxTokens: options.maxTokens,
      onPartial: async (partialBlueprint) => {
        next = {
          ...next,
          chapterBlueprint: partialBlueprint,
          blueprintGenerated: maxBlueprintChapter(partialBlueprint) >= next.numberOfChapters,
        }
        await persist()
      },
    })
    next = {
      ...next,
      chapterBlueprint: blueprint,
      blueprintGenerated: maxBlueprintChapter(blueprint) >= next.numberOfChapters,
    }
    await persist()
  } else if (!next.blueprintGenerated) {
    next = { ...next, blueprintGenerated: true }
    await persist()
  }

  const draftProject = options.chapterUserGuidance !== undefined
    ? { ...next, userGuidance: options.chapterUserGuidance }
    : next
  let chapterText = normalize(await generateChapterDraft(draftProject, chapterNumber, complete))
  if (!chapterText.trim()) throw new Error('这一幕没有写完，请再试一次')

  if (chapterText.length < next.wordNumber) {
    try {
      const enriched = normalize(await enrichChapter(chapterText, next.wordNumber, complete))
      if (enriched.trim()) chapterText = enriched
    } catch (error) {
      console.error('[novel] enrich', error instanceof Error ? error.message : error)
    }
  }

  try {
    const finalized = await finalizeChapter(next, chapterNumber, chapterText, complete)
    next = { ...next, ...finalized }
  } catch (error) {
    console.error('[novel] finalize', error instanceof Error ? error.message : error)
  }

  next = {
    ...next,
    chapters: { ...next.chapters, [String(chapterNumber)]: chapterText },
    userGuidance: project.userGuidance,
  }
  await persist()
  return { project: next, chapterText }
}
