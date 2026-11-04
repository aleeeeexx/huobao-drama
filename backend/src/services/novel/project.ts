/** 织界小说项目。设定、章计划和正文都写在这一份状态里。 */

export const NOVEL_DEFAULT_CHAPTER_COUNT = 100
export const NOVEL_DEFAULT_WORD_NUMBER = 3000
/** 织界章节请求的输出上限。 */
export const NOVEL_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16384)

export interface NovelChapterInfo {
  number: number
  title: string
  position: string
  purpose: string
  suspense: string
  foreshadowing: string
  twistLevel: string
  summary: string
  endState: string
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
  fullPlot: string
  tone: string
  targetAudience: string
  coreIdea: string
  extractedGenre: string
  generatedTitle: string
  subtitle: string
  introduction: string
  bookSummary: string
  writingStyle: string
  narrativePov: string
  eraBackground: string
  tags: string[]
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
    fullPlot: '',
    tone: '',
    targetAudience: '',
    coreIdea: '',
    extractedGenre: '',
    generatedTitle: '',
    subtitle: '',
    introduction: '',
    bookSummary: '',
    writingStyle: '',
    narrativePov: '',
    eraBackground: '',
    tags: [],
  }
}

export function settleNovelProject(project: NovelProject): NovelProject {
  return {
    ...createNovelProject({ title: project.title, topic: project.topic }),
    ...project,
    chapters: project.chapters && typeof project.chapters === 'object' ? project.chapters : {},
    tags: Array.isArray(project.tags) ? project.tags.filter(item => typeof item === 'string') : [],
    userGuidance: typeof project.userGuidance === 'string' ? project.userGuidance : '',
    numberOfChapters: project.numberOfChapters || NOVEL_DEFAULT_CHAPTER_COUNT,
    wordNumber: project.wordNumber || NOVEL_DEFAULT_WORD_NUMBER,
  }
}

export function formatGenre(genre: string | string[] | null | undefined): string {
  if (Array.isArray(genre)) return genre.join(' / ')
  return genre || ''
}

/** 去掉模型偶尔套上的代码围栏。 */
export function cleanResponse(text: string): string {
  if (!text) return ''
  return text.replace(/```[\s\S]*?```/g, '').replace(/`/g, '').trim()
}

export function maxBlueprintChapter(blueprint: string): number {
  const existing = (blueprint || '').match(/第\s*(\d+)\s*章/g) || []
  if (!existing.length) return 0
  return Math.max(...existing.map(item => Number(item.match(/\d+/)?.[0] || 0)))
}

export function architectureIncomplete(project: NovelProject): boolean {
  return !project.architectureGenerated
    || !project.coreSeed
    || !project.worldBuilding
    || !(project.fullPlot || project.plotArchitecture)
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
    const nextHeading = blueprint.slice(startIndex + match[0].length).search(/第\s*\d+\s*章\s*[-–—]/)
    const chapterText = nextHeading > -1
      ? blueprint.substring(startIndex, startIndex + match[0].length + nextHeading)
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
      endState: extractField(chapterText, '终点'),
    })
  }
  return chapters
}

function extractField(text: string, fieldName: string): string {
  const pattern = new RegExp(`${fieldName}[：:]\\s*(.+?)(?=\\n|$)`)
  const match = text.match(pattern)
  return match ? match[1].trim() : ''
}

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
