/**
 * 资产提取任务 — 异步执行，按「集 × 类型」粒度跟踪
 * 角色 / 场景 / 道具 可分别单独提取，同一集的不同类型可并行
 * 任务状态为进程内内存态：后端重启后运行中的任务状态丢失（Agent 调用本身已被中断）
 * 幻书回合也调用 runExtraction，与制作台共用 extractor Agent。
 */
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { runStudioAgent } from './agent-runner.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { scheduleEpisodeAssetImages } from './asset-images.js'

export type ExtractTarget = 'characters' | 'scenes' | 'props'
export const EXTRACT_TARGETS: ExtractTarget[] = ['characters', 'scenes', 'props']

export interface ExtractTask {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<string, ExtractTask>()
const keyOf = (episodeId: number, target: string) => `${episodeId}:${target}`

/** 每类资产的提取指令：限定只提取该类型，并要求与已有数据去重合并 */
const EXTRACT_MESSAGES: Record<ExtractTarget, string> = {
  characters: '请从本集剧本中提取所有角色信息，区分固定身份、外貌和身材，与本世界性格、背景经历、服装妆造。先用 read_existing_characters 读取项目已有角色；同名或近名（带括号定位/别名，如「林小雨（主角）」与「林小雨」）直接复用，不要重复创建；manually_edited 为 true 的角色保留已填写的信息，可以补充空字段。再用 save_dedup_characters 保存。本次只提取角色，不要提取场景和道具。',
  scenes: '请从本集剧本中提取所有场景信息（地点、时间、光影等），先用 read_existing_scenes 读取已有场景去重，再用 save_dedup_scenes 保存。本次只提取场景，不要提取角色和道具。',
  props: '请从本集剧本中提取关键道具——必须同时满足：① 直接推动剧情（出现/交接/损坏/发现会引发情节转折，如凶器、信物、关键文件、定情礼物、证据）；② 值得单独生成白底单品图（分镜会给它特写或反复出现）。判定三问任一答"否"即放弃：删掉它剧情依然成立吗？它只是随手使用的日常物品（手机、筷子、水杯）吗？它是场景陈设（桌椅、灯具）吗？宁可少提不要多提，一集通常 0-3 个，超过 3 个只保留最重要的 3 个，没有就一个都不提取（save_dedup_props 传空数组）。description 只记录物品外貌。先用 read_existing_props 读取已有道具去重，再用 save_dedup_props 保存。本次只提取道具，不要提取角色和场景。',
}

export interface ExtractionOptions { model?: string; configId?: number; timeoutMs?: number; script?: string }

const EXTRACTION_TIMEOUT_MS = 120_000

/** 跑完一类资产的提取 Agent。制作台的异步任务和幻书回合都走这里。 */
export async function runExtraction(
  episodeId: number,
  dramaId: number,
  target: ExtractTarget,
  opts: ExtractionOptions = {},
): Promise<void> {
  const result = await runStudioAgent({
    agentType: 'extractor',
    episodeId,
    dramaId,
    message: EXTRACT_MESSAGES[target],
    maxSteps: 20,
    timeoutMs: opts.timeoutMs ?? EXTRACTION_TIMEOUT_MS,
    model: opts.model,
    configId: opts.configId,
    extractionScript: opts.script,
    onStepFinish: (step: any) => {
      const tools = (step?.toolCalls || [])
        .map((toolCall: any) => toolCall?.toolName || toolCall?.payload?.toolName)
        .filter(Boolean)
      logTaskProgress('Extract', `${target}-step`, {
        episodeId,
        tools: tools.length ? tools.join(',') : undefined,
        text: (step?.text || '').slice(0, 200) || undefined,
      })
    },
  })
  const toolNames = (result.raw?.toolCalls || []).map((toolCall: any) => toolCall?.toolName).filter(Boolean)
  logTaskSuccess('Extract', target, {
    episodeId,
    steps: result.raw?.steps?.length,
    toolCalls: toolNames.join(',') || undefined,
    reply: (result.text || '').slice(0, 300) || undefined,
  })
  if (target === 'characters') {
    const sessions = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.dramaId, dramaId))
    if (sessions.some(session => session.episodeId === episodeId)) scheduleEpisodeAssetImages(dramaId, episodeId)
  }
}

/** 启动异步提取任务（立即返回）；同集同类型已在运行时返回 false；可指定文本模型覆盖 */
export function startExtraction(episodeId: number, dramaId: number, target: ExtractTarget, opts: ExtractionOptions = {}): boolean {
  const key = keyOf(episodeId, target)
  if (tasks.get(key)?.status === 'running') return false

  const task: ExtractTask = { status: 'running', started_at: new Date().toISOString() }
  tasks.set(key, task)

  logTaskStart('Extract', target, { episodeId, dramaId, model: opts.model || undefined, configId: opts.configId || undefined })
  void runExtraction(episodeId, dramaId, target, opts)
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '提取失败'
      logTaskError('Extract', target, { episodeId, error: err?.message })
    })
  return true
}

/** 查询某集三类资产的提取任务状态（未启动过的类型为 null） */
export function getExtractionStatus(episodeId: number): Record<ExtractTarget, ExtractTask | null> {
  const result = {} as Record<ExtractTarget, ExtractTask | null>
  for (const target of EXTRACT_TARGETS) result[target] = tasks.get(keyOf(episodeId, target)) || null
  return result
}
