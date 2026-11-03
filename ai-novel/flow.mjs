/**
 * 执行 AI_NovelGenerator 的默认建书任务图 create_novel_by_ai。
 * 提示词与连线来自 vendor/ai-novel-generator（AGPL-3.0）。
 * 拼接方式对齐上游 backend/services/task_flows/llm.py：
 * 本模块只发普通 chat completion（上游 native=false），因此附上 text_prompt。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export const AI_NOVEL_UPSTREAM_COMMIT = 'a61674fad4dd6c4c5fa9a2ad2f12b667109e628a'
export const AI_NOVEL_FLOW_TASK = 'create_novel_by_ai'

const STEP_LABELS = {
  expand_idea_to_full_novel_story: '把创意扩写成完整故事',
  extract_idea: '提炼类型、基调与核心设想',
  core_seed: '生成核心种子',
  novel_meta: '生成书名、简介与世界观',
}

const FIELD_LABELS = {
  plot: '完整故事',
  genre: '类型',
  tone: '基调',
  target_audience: '目标读者',
  core_idea: '核心设想',
  core_seed: '核心种子',
  title: '书名',
  subtitle: '副标题',
  introduction: '引言',
  summary: '简介',
  worldview: '世界观',
  writing_style: '创作风格',
  narrative_pov: '叙事视角',
  era_background: '时代背景',
  tags: '标签',
}

export function aiNovelVendorDir() {
  const override = process.env.AI_NOVEL_VENDOR_DIR
  if (override && fs.existsSync(path.join(override, 'defaults', 'create_novel_by_ai.json'))) return override
  const bundled = path.join(moduleDir, 'vendor', 'ai-novel-generator')
  if (fs.existsSync(path.join(bundled, 'defaults', 'create_novel_by_ai.json'))) return bundled
  throw new Error('找不到建书流程文件')
}

export function loadCreateNovelFlow(vendorDir = aiNovelVendorDir()) {
  const defaultsDir = path.join(vendorDir, 'defaults')
  const data = JSON.parse(fs.readFileSync(path.join(defaultsDir, 'create_novel_by_ai.json'), 'utf8'))
  if (data.task !== AI_NOVEL_FLOW_TASK) throw new Error('建书流程任务名不正确')
  for (const node of data.nodes) {
    const config = node.config || {}
    for (const key of ['prompt', 'schema_prompt', 'text_prompt']) {
      const reference = config[`${key}_file`]
      if (typeof reference !== 'string' || !reference) continue
      delete config[`${key}_file`]
      const filePath = path.resolve(defaultsDir, reference)
      if (!filePath.startsWith(defaultsDir + path.sep)) throw new Error('提示词路径不正确')
      config[key] = fs.readFileSync(filePath, 'utf8')
    }
    node.config = config
  }
  return data
}

export function renderTemplate(template, inputs) {
  const pattern = /(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g
  const required = new Set()
  for (const match of template.matchAll(pattern)) required.add(match[1])
  const missing = [...required].filter(name => !Object.prototype.hasOwnProperty.call(inputs, name))
  if (missing.length) throw new Error('提示词缺少输入')
  const values = {}
  for (const [name, value] of Object.entries(inputs)) {
    values[name] = value && typeof value === 'object' ? JSON.stringify(value) : value
  }
  return template.replace(pattern, (_all, name) => String(values[name]))
}

export function buildNodePrompt(node, inputs) {
  const config = node.config
  let prompt = renderTemplate(String(config.prompt || ''), inputs)
  let suffix = String(config.text_prompt || '')
  if (config.format_suffix) suffix = renderTemplate(suffix, inputs)
  if (!suffix) return prompt
  if (!config.preserve_prompt_whitespace) {
    prompt = prompt.replace(/\s+$/, '')
    suffix = suffix.trim()
  }
  const separator = typeof config.prompt_separator === 'string' ? config.prompt_separator : '\n\n'
  return prompt + separator + suffix
}

export function parseModelJson(raw) {
  let text = String(raw || '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) text = text.slice(start, end + 1)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('模型没有返回 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型没有返回 JSON')
  return parsed
}

function labelOf(name) {
  return FIELD_LABELS[name] || '这一项'
}

export function coercePort(name, spec, value) {
  if (value === undefined || value === null || value === '') {
    if (spec.required === false && spec.type === 'array') return []
    if (spec.required === false && spec.default !== undefined) return spec.default
    throw new Error(`${labelOf(name)}没有生成出来`)
  }
  if (spec.enum) {
    if (typeof value !== 'string' || !spec.enum.includes(value)) throw new Error(`${labelOf(name)}不在可选范围内`)
    return value
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error(`${labelOf(name)}格式不正确`)
    }
    const tags = value.map(item => item.trim())
    if (tags.length > 30 || new Set(tags).size !== tags.length) throw new Error(`${labelOf(name)}格式不正确`)
    return tags
  }
  if (spec.type === 'integer') {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(number)) throw new Error(`${labelOf(name)}格式不正确`)
    if (spec.minimum !== undefined && number < spec.minimum) throw new Error(`${labelOf(name)}超出范围`)
    if (spec.maximum !== undefined && number > spec.maximum) throw new Error(`${labelOf(name)}超出范围`)
    return number
  }
  if (typeof value !== 'string') throw new Error(`${labelOf(name)}格式不正确`)
  const text = value.trim()
  const min = spec.minLength ?? (spec.required === false ? 0 : 1)
  const max = spec.maxLength
  if (text.length < min || (max !== undefined && text.length > max)) throw new Error(`${labelOf(name)}长度不符合要求`)
  return text
}

function llmOrder(flow) {
  const nodes = new Map(flow.nodes.filter(node => node.type === 'llm').map(node => [node.id, node]))
  const incoming = new Map()
  for (const id of nodes.keys()) incoming.set(id, new Set())
  for (const edge of flow.edges) {
    if (nodes.has(edge.source) && nodes.has(edge.target)) incoming.get(edge.target).add(edge.source)
  }
  const ready = [...nodes.keys()].filter(id => incoming.get(id).size === 0)
  const ordered = []
  while (ready.length) {
    const id = ready.shift()
    ordered.push(nodes.get(id))
    for (const [target, sources] of incoming) {
      if (!sources.delete(id)) continue
      if (sources.size === 0) ready.push(target)
    }
  }
  if (ordered.length !== nodes.size) throw new Error('建书流程有循环')
  return ordered
}

function readSource(produced, start, source, port) {
  if (source === 'start') return start[port]
  return produced[source]?.[port]
}

function nodeInputs(flow, node, produced, start) {
  const inputs = {}
  for (const edge of flow.edges) {
    if (edge.target !== node.id) continue
    inputs[edge.target_port] = readSource(produced, start, edge.source, edge.source_port)
  }
  for (const [name, spec] of Object.entries(node.inputs)) {
    if (inputs[name] === undefined && spec.default !== undefined) inputs[name] = spec.default
    if (inputs[name] === undefined) throw new Error('建书流程缺少输入')
  }
  return inputs
}

export async function runCreateNovelFlow(input, complete, onStep) {
  const flow = loadCreateNovelFlow()
  const start = {
    user_idea: input.userIdea,
    number_of_chapters: input.numberOfChapters,
    words_per_chapter: input.wordsPerChapter,
  }
  const produced = {}
  for (const node of llmOrder(flow)) {
    const label = STEP_LABELS[node.id] || node.id
    if (onStep) await onStep({ id: node.id, label, status: 'start' })
    const inputs = nodeInputs(flow, node, produced, start)
    const prompt = buildNodePrompt(node, inputs)
    const raw = await complete(prompt)
    const parsed = parseModelJson(raw)
    const outputs = {}
    for (const [name, spec] of Object.entries(node.outputs)) {
      outputs[name] = coercePort(name, spec, parsed[name])
    }
    produced[node.id] = outputs
    if (onStep) await onStep({ id: node.id, label, status: 'done' })
  }
  const resultNode = flow.nodes.find(node => node.type === 'output')
  if (!resultNode) throw new Error('建书流程没有结果节点')
  const document = {}
  for (const edge of flow.edges) {
    if (edge.target !== resultNode.id) continue
    document[edge.target_port] = readSource(produced, start, edge.source, edge.source_port)
  }
  document.workflow = AI_NOVEL_FLOW_TASK
  document.upstream_commit = AI_NOVEL_UPSTREAM_COMMIT
  return document
}

export function parseCreateNovelInput(body) {
  const record = body && typeof body === 'object' ? body : {}
  const userIdea = String(record.user_idea ?? record.userIdea ?? record.idea ?? '').trim()
  if (!userIdea) return { ok: false, message: '先写下创意' }
  if (userIdea.length > 20_000) return { ok: false, message: '创意太长了' }
  const numberOfChapters = Number(record.number_of_chapters ?? record.numberOfChapters ?? 100)
  const wordsPerChapter = Number(record.words_per_chapter ?? record.wordsPerChapter ?? 3000)
  if (!Number.isInteger(numberOfChapters) || numberOfChapters < 1 || numberOfChapters > 10_000) {
    return { ok: false, message: '章节数不正确' }
  }
  if (!Number.isInteger(wordsPerChapter) || wordsPerChapter < 1 || wordsPerChapter > 100_000) {
    return { ok: false, message: '每章字数不正确' }
  }
  return { ok: true, input: { userIdea, numberOfChapters, wordsPerChapter } }
}
