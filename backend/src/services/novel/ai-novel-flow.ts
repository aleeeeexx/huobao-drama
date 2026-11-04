/**
 * 织界文章生成与续写。
 * 对照权威是私有仓库 aleeeeexx/AI_NovelGenerator 的 main 快照，不是公开的 YILING0013 副本。
 * 设定按该快照的 create_novel_by_ai 连线执行。
 * 章计划和正文使用同一快照的 plan_chapters_by_ai / write_chapter_by_ai 提示词。
 * 前文摘录长度与 writing_context.py 一致：只保留上一章最后 6000 字。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatGenre,
  parseChapterBlueprint,
  type NovelChapterInfo,
  type NovelProject,
} from './project.js'

const SOURCE_DEFAULTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../ai-novel/vendor/ai-novel-generator/defaults',
)

/** 与私有 writing_context.py 的 previous_excerpt_limit 相同。超出时只保留结尾，并用 truncated 标明。 */
export const NOVEL_PREVIOUS_TEXT_CHARS = 6000

const CHAPTER_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chapters'],
  properties: {
    chapters: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'planning'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          summary: { type: 'string', maxLength: 2000 },
          planning: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', maxLength: 2000 },
              start_state: { type: 'string', maxLength: 2000 },
              end_state: { type: 'string', maxLength: 2000 },
              beats: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 2000 } },
              pov_character_id: { type: 'null' },
              must_include: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 2000 } },
              must_avoid: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 2000 } },
              target_word_count: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
  },
} as const

interface FlowPort {
  required?: boolean
  default?: unknown
  type?: string
  enum?: string[]
  minLength?: number
  maxLength?: number
}

interface FlowNode {
  id: string
  type: string
  inputs: Record<string, FlowPort>
  outputs: Record<string, FlowPort>
  config: {
    prompt?: string
    schema_prompt?: string
    text_prompt?: string
    prompt_separator?: string
    preserve_prompt_whitespace?: boolean
    format_suffix?: boolean
    force_text_prompt?: boolean
    mode?: string
    append_output_schema?: boolean
  }
}

interface FlowFile {
  task: string
  nodes: FlowNode[]
  edges: Array<{ source: string; source_port: string; target: string; target_port: string }>
}

export interface ParsedChapterPlan {
  title: string
  summary: string
  goal: string
  startState: string
  endState: string
  beats: string[]
  mustInclude: string[]
  mustAvoid: string[]
  targetWordCount: number | null
}

let cachedFlow: FlowFile | null = null

export function novelPromptDefaultsDir(): string {
  const fromEnv = process.env.AI_NOVEL_ROOT
  if (fromEnv) {
    const dir = path.join(fromEnv, 'vendor', 'ai-novel-generator', 'defaults')
    if (fs.existsSync(path.join(dir, 'create_novel_by_ai.json'))) return dir
  }
  if (fs.existsSync(path.join(SOURCE_DEFAULTS, 'create_novel_by_ai.json'))) return SOURCE_DEFAULTS
  throw new Error('找不到织界小说流程文件')
}

function readDefaultsFile(name: string): string {
  const defaultsDir = novelPromptDefaultsDir()
  const filePath = path.resolve(defaultsDir, name)
  if (!filePath.startsWith(defaultsDir + path.sep)) throw new Error('提示词路径不正确')
  return fs.readFileSync(filePath, 'utf8')
}

function loadCreateNovelFlow(): FlowFile {
  if (cachedFlow) return cachedFlow
  const defaultsDir = novelPromptDefaultsDir()
  const data = JSON.parse(fs.readFileSync(path.join(defaultsDir, 'create_novel_by_ai.json'), 'utf8')) as FlowFile
  if (data.task !== 'create_novel_by_ai') throw new Error('建书流程任务名不正确')
  for (const node of data.nodes) {
    const config = node.config || {}
    for (const key of ['prompt', 'schema_prompt', 'text_prompt'] as const) {
      const reference = (config as Record<string, unknown>)[`${key}_file`]
      if (typeof reference !== 'string' || !reference) continue
      delete (config as Record<string, unknown>)[`${key}_file`]
      config[key] = readDefaultsFile(reference)
    }
    node.config = config
  }
  cachedFlow = data
  return data
}

export function renderTemplate(template: string, inputs: Record<string, unknown>): string {
  const pattern = /(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g
  const required = new Set<string>()
  for (const match of template.matchAll(pattern)) required.add(match[1])
  const missing = [...required].filter(name => !Object.prototype.hasOwnProperty.call(inputs, name))
  if (missing.length) throw new Error('提示词缺少输入')
  return template.replace(pattern, (_all, name: string) => {
    const value = inputs[name]
    return value && typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

function buildNodePrompt(node: FlowNode, inputs: Record<string, unknown>, schemaText = ''): string {
  const config = node.config
  let prompt = renderTemplate(String(config.prompt || ''), inputs)
  let suffix = String(config.text_prompt || '')
  if (config.format_suffix) suffix = renderTemplate(suffix, inputs)
  if (suffix) {
    if (!config.preserve_prompt_whitespace) {
      prompt = prompt.replace(/\s+$/, '')
      suffix = suffix.trim()
    }
    const separator = typeof config.prompt_separator === 'string' ? config.prompt_separator : '\n\n'
    prompt += separator + suffix
  }
  if (schemaText) prompt += `\n\nJSON Schema:\n${schemaText}`
  return prompt
}

export function parseModelJson(raw: string): Record<string, unknown> {
  let text = String(raw || '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) text = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('模型没有返回 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型没有返回 JSON')
  return parsed as Record<string, unknown>
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}没有生成出来`)
  return value.trim()
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function readSource(
  produced: Record<string, Record<string, unknown>>,
  start: Record<string, unknown>,
  source: string,
  port: string,
): unknown {
  if (source === 'start') return start[port]
  return produced[source]?.[port]
}

function nodeInputs(
  flow: FlowFile,
  node: FlowNode,
  produced: Record<string, Record<string, unknown>>,
  start: Record<string, unknown>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {}
  for (const edge of flow.edges) {
    if (edge.target !== node.id) continue
    inputs[edge.target_port] = readSource(produced, start, edge.source, edge.source_port)
  }
  for (const [name, spec] of Object.entries(node.inputs || {})) {
    if (inputs[name] === undefined && spec.default !== undefined) inputs[name] = spec.default
    if (inputs[name] === undefined) throw new Error('建书流程缺少输入')
  }
  return inputs
}

export function userIdeaForProject(project: NovelProject): string {
  const genre = formatGenre(project.genre)
  return [
    project.title ? `书名：${project.title}` : '',
    genre && genre !== '其他' ? `类型倾向：${genre}` : '',
    project.userGuidance ? `作者要求：${project.userGuidance}` : '',
    `篇幅：约${project.numberOfChapters}章，每章${project.wordNumber}字`,
    project.topic,
  ].filter(Boolean).join('\n')
}

function settingGenre(project: NovelProject): string {
  return project.extractedGenre || formatGenre(project.genre) || '其他'
}

export function renderSettingPrompt(nodeId: string, inputs: Record<string, unknown>): string {
  const flow = loadCreateNovelFlow()
  const node = flow.nodes.find(item => item.id === nodeId && item.type === 'llm')
  if (!node) throw new Error('建书流程缺少节点')
  return buildNodePrompt(node, inputs)
}

async function runSettingNode(
  nodeId: string,
  inputs: Record<string, unknown>,
  complete: (prompt: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const raw = await complete(renderSettingPrompt(nodeId, inputs))
  return parseModelJson(raw)
}

export async function generateNovelSetting(
  project: NovelProject,
  complete: (prompt: string) => Promise<string>,
  onPartial?: (project: NovelProject) => Promise<void> | void,
): Promise<NovelProject> {
  const next: NovelProject = { ...project, chapters: { ...project.chapters }, tags: [...(project.tags || [])] }
  const save = async () => {
    await onPartial?.(next)
  }
  if (!next.fullPlot) {
    const expanded = await runSettingNode('expand_idea_to_full_novel_story', {
      user_idea: userIdeaForProject(next),
    }, complete)
    next.fullPlot = clip(requiredText(expanded.plot, '完整故事'), 5000)
    next.coreSeed = ''
    next.tone = ''
    next.coreIdea = ''
    next.targetAudience = ''
    next.extractedGenre = ''
    next.worldBuilding = ''
    next.bookSummary = ''
    next.introduction = ''
    await save()
  }
  if (!next.tone || !next.coreIdea || !next.targetAudience) {
    const extracted = await runSettingNode('extract_idea', { plot: next.fullPlot }, complete)
    next.extractedGenre = clip(requiredText(extracted.genre, '类型'), 30)
    next.tone = clip(requiredText(extracted.tone, '基调'), 30)
    next.targetAudience = clip(requiredText(extracted.target_audience, '目标读者'), 30)
    next.coreIdea = clip(requiredText(extracted.core_idea, '核心设想'), 300)
    if (!formatGenre(next.genre) || formatGenre(next.genre) === '其他') next.genre = next.extractedGenre
    next.characterDynamics = next.coreIdea
    await save()
  }
  if (!next.coreSeed) {
    const seeded = await runSettingNode('core_seed', {
      plot: next.fullPlot,
      genre: settingGenre(next),
      tone: next.tone,
      target_audience: next.targetAudience,
      core_idea: next.coreIdea,
      number_of_chapters: next.numberOfChapters,
      words_per_chapter: next.wordNumber,
    }, complete)
    next.coreSeed = clip(requiredText(seeded.core_seed, '核心种子'), 150)
    await save()
  }
  if (!next.worldBuilding || !next.bookSummary) {
    const meta = await runSettingNode('novel_meta', {
      plot: next.fullPlot,
      genre: settingGenre(next),
      tone: next.tone,
      target_audience: next.targetAudience,
      core_idea: next.coreIdea,
      core_seed: next.coreSeed,
      number_of_chapters: next.numberOfChapters,
      words_per_chapter: next.wordNumber,
    }, complete)
    next.generatedTitle = clip(requiredText(meta.title, '书名'), 30)
    next.subtitle = clip(requiredText(meta.subtitle, '副标题'), 50)
    next.introduction = clip(requiredText(meta.introduction, '引言'), 300)
    next.bookSummary = clip(requiredText(meta.summary, '简介'), 500)
    next.worldBuilding = clip(requiredText(meta.worldview, '世界观'), 800)
    next.writingStyle = clip(requiredText(meta.writing_style, '创作风格'), 50)
    next.narrativePov = requiredText(meta.narrative_pov, '叙事视角')
    next.eraBackground = clip(requiredText(meta.era_background, '时代背景'), 50)
    next.tags = Array.isArray(meta.tags)
      ? meta.tags.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 30)
      : []
    next.plotArchitecture = next.bookSummary
    next.characterDynamics = next.coreIdea || next.characterDynamics
    await save()
  }
  next.architectureGenerated = true
  await save()
  return next
}

export function previousChapterText(text: string): { excerpt: string; truncated: boolean; excerptStart: number } {
  const source = text || ''
  const truncated = source.length > NOVEL_PREVIOUS_TEXT_CHARS
  return {
    excerpt: truncated ? source.slice(-NOVEL_PREVIOUS_TEXT_CHARS) : source,
    truncated,
    excerptStart: truncated ? source.length - NOVEL_PREVIOUS_TEXT_CHARS : 0,
  }
}

export function planFromBlueprint(info: NovelChapterInfo | undefined): ParsedChapterPlan | null {
  if (!info) return null
  return {
    title: info.title,
    summary: info.summary,
    goal: info.purpose,
    startState: info.position,
    endState: info.endState || info.summary,
    beats: [info.foreshadowing, info.twistLevel].map(item => item.trim()).filter(Boolean),
    mustInclude: [],
    mustAvoid: [],
    targetWordCount: null,
  }
}

export function chapterPlan(project: NovelProject, chapterNumber: number): ParsedChapterPlan | null {
  return planFromBlueprint(parseChapterBlueprint(project.chapterBlueprint).find(item => item.number === chapterNumber))
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 30)
}

export function parseChapterPlans(raw: string, count: number): ParsedChapterPlan[] {
  const parsed = parseModelJson(raw)
  const chapters = parsed.chapters
  if (!Array.isArray(chapters) || chapters.length !== count) throw new Error('章计划数量不正确')
  return chapters.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('章计划没有生成出来')
    const record = item as Record<string, unknown>
    const planning = record.planning && typeof record.planning === 'object' && !Array.isArray(record.planning)
      ? record.planning as Record<string, unknown>
      : {}
    const target = planning.target_word_count
    return {
      title: clip(requiredText(record.title, '章标题'), 120),
      summary: clip(typeof record.summary === 'string' ? record.summary.trim() : '', 2000),
      goal: clip(typeof planning.goal === 'string' ? planning.goal.trim() : '', 2000),
      startState: clip(typeof planning.start_state === 'string' ? planning.start_state.trim() : '', 2000),
      endState: clip(typeof planning.end_state === 'string' ? planning.end_state.trim() : '', 2000),
      beats: stringList(planning.beats),
      mustInclude: stringList(planning.must_include),
      mustAvoid: stringList(planning.must_avoid),
      targetWordCount: typeof target === 'number' && Number.isInteger(target) && target > 0 ? target : null,
    }
  })
}

export function renderChapterPlan(chapterNumber: number, plan: ParsedChapterPlan): string {
  return [
    `第 ${chapterNumber} 章 - ${plan.title}`,
    `本章定位：${plan.startState}`,
    `核心作用：${plan.goal}`,
    `悬念密度：`,
    `伏笔操作：${plan.beats.join('；')}`,
    `认知颠覆：`,
    `本章简述：${plan.summary}`,
    `终点：${plan.endState}`,
  ].join('\n')
}

export function appendRenderedPlan(blueprint: string, chapterNumber: number, plan: ParsedChapterPlan): string {
  if (parseChapterBlueprint(blueprint).some(item => item.number === chapterNumber)) return blueprint
  const block = renderChapterPlan(chapterNumber, plan)
  return blueprint.trim() ? `${blueprint.trim()}\n\n${block}` : block
}

function planningFields(plan: ParsedChapterPlan | null): Record<string, unknown> | null {
  if (!plan) return null
  return {
    goal: plan.goal,
    start_state: plan.startState,
    end_state: plan.endState,
    beats: plan.beats,
    must_include: plan.mustInclude,
    must_avoid: plan.mustAvoid,
    target_word_count: plan.targetWordCount,
    pov_character_id: null,
  }
}

function writingBundle(project: NovelProject, chapterNumber: number, guidance: string, task: 'plan_chapters_by_ai' | 'write_chapter_by_ai') {
  const previousSource = chapterNumber > 1 ? (project.chapters[String(chapterNumber - 1)] || '') : ''
  const previous = previousSource ? previousChapterText(previousSource) : null
  const previousPlan = chapterNumber > 1 ? chapterPlan(project, chapterNumber - 1) : null
  const currentPlan = task === 'write_chapter_by_ai' ? chapterPlan(project, chapterNumber) : null
  const savedChapter = project.chapters[String(chapterNumber)] || ''
  const previousWritten = previous ? {
    kind: 'written_excerpt',
    title: previousPlan?.title || `第${chapterNumber - 1}章`,
    plan_summary: previousPlan?.summary || '',
    excerpt: previous.excerpt,
    truncated: previous.truncated,
    excerpt_start: previous.excerptStart,
  } : null
  return {
    writing_context: {
      position: {
        version: 1,
        intent: task === 'write_chapter_by_ai' ? 'chapter_before' : 'append',
        target_type: task === 'write_chapter_by_ai' ? 'chapter' : 'scene',
        order: [chapterNumber],
      },
      plan: [{
        resource_type: 'novel',
        title: project.title,
        genre: formatGenre(project.genre),
        tone: project.tone,
        writing_style: project.writingStyle,
        narrative_pov: project.narrativePov,
        era_background: project.eraBackground,
        target_audience: project.targetAudience,
        words_per_chapter: project.wordNumber,
        content_semantics: 'design_plan',
        core_seed: project.coreSeed,
        core_idea: project.coreIdea || project.characterDynamics,
        worldview: project.worldBuilding,
        plot: project.fullPlot || project.plotArchitecture,
        summary: project.bookSummary || project.plotArchitecture,
      }, ...(currentPlan ? [{
        resource_type: 'chapter',
        title: currentPlan.title,
        order_index: chapterNumber,
        content_semantics: 'design_plan',
        planning: planningFields(currentPlan),
      }] : [])],
      neighbors: {
        previous: previousPlan ? {
          resource_type: 'chapter',
          title: previousPlan.title,
          content_semantics: 'design_plan',
          planning: {
            goal: previousPlan.goal,
            start_state: previousPlan.startState,
            end_state: previousPlan.endState,
            must_avoid: previousPlan.mustAvoid,
          },
        } : null,
        next: null,
      },
      existing_children: [],
      previous_written: previousWritten,
      selected_entities: [],
      relations: [],
      volume_states: [],
      search_results: [],
      edit_target: task === 'write_chapter_by_ai' && savedChapter ? {
        content: savedChapter,
        content_semantics: 'edit_target',
      } : null,
      user_guidance: guidance,
      count: 1,
      count_mode: 'fixed',
      target_word_count: currentPlan?.targetWordCount || project.wordNumber,
      truncation: {
        previous_excerpt_limit: NOVEL_PREVIOUS_TEXT_CHARS,
        previous_truncated: Boolean(previous?.truncated),
      },
      id_policy: '本次没有人物、势力、地点、物品或规则的正式业务 ID。pov_character_id 必须为 null，不要编造 ID。',
    },
    prepared_context: {
      adopted: ['已保存设定', '压缩故事', previousWritten ? '上一章正文' : '无前章正文'],
      missing_required: [],
      count: 1,
      note: '织界把已保存的设定和正文直接交给这一章，不调用书库读取工具。',
    },
  }
}

export function renderPlanChapterPrompt(project: NovelProject, chapterNumber: number, guidance: string): string {
  const bundle = writingBundle(project, chapterNumber, guidance, 'plan_chapters_by_ai')
  const prompt = readDefaultsFile('plan_chapters_by_ai_story_prompt.md').replace(/\s+$/, '')
  const suffix = readDefaultsFile('plan_chapters_by_ai_output.md').trim()
  return `${renderTemplate(prompt, bundle)}\n\n${suffix}\n\nJSON Schema:\n${JSON.stringify(CHAPTER_PLAN_JSON_SCHEMA)}`
}

export function renderWriteChapterPrompt(project: NovelProject, chapterNumber: number, guidance: string): string {
  const bundle = writingBundle(project, chapterNumber, guidance, 'write_chapter_by_ai')
  return renderTemplate(readDefaultsFile('write_chapter_by_ai_story_prompt.md'), bundle)
}

export function chapterProse(raw: string): string {
  let text = String(raw || '').trim()
  const fenced = text.match(/^```(?:\w+)?\s*([\s\S]*?)```$/i)
  if (fenced) text = fenced[1].trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { content?: unknown }
      if (typeof parsed.content === 'string' && parsed.content.trim()) return parsed.content
    } catch {
      // 正文提示词要求纯文本。解析失败时按原文留下。
    }
  }
  return text
}
