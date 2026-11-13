/**
 * 最终提示词服务
 * 生图前确保角色/场景/道具已有「最终提示词」：
 * - 角色 → 左侧正脸特写 + 右侧全身三视图（正面/90 度侧面/背面）
 * - 场景 → 固定视角 + 前景/中景/后景
 * - 道具 → 白底单品静物（single product shot on pure white background）
 * 缺失时运行 prompt_generator Agent 创作并保存；失败返回 ''，由调用方回退到本地拼接提示词
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext, type AgentRequestContextValues, type GlobalCharacterPromptContext } from '../agents/context.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'

type CharacterRow = typeof schema.characters.$inferSelect
type SceneRow = typeof schema.scenes.$inferSelect
type PropRow = typeof schema.props.$inferSelect

/** 顶栏选择的文本模型/配置覆盖（不传则跟随 Agent 与文本配置默认） */
export interface PromptAgentOptions { model?: string; configId?: number; forImageSubmission?: boolean }

async function runPromptAgent(context: AgentRequestContextValues, message: string, opts?: PromptAgentOptions) {
  const agent = mastra.getAgent('prompt_generator')
  if (!agent) throw new Error('图片提示词 Agent 不可用')
  const requestContext = buildAgentRequestContext({
    ...context,
    modelOverride: opts?.model || undefined,
    textConfigId: opts?.configId || undefined,
  })
  await agent.generate([{ role: 'user', content: message }], { maxSteps: 12, requestContext })
}

/** 确保角色拥有三视图最终提示词，返回最终提示词（失败返回 ''）；force 时忽略已有提示词强制重新生成 */
export async function ensureCharacterFinalPrompt(char: CharacterRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<string> {
  if (char.finalPrompt && !force) return char.finalPrompt
  try {
    logTaskProgress('FinalPrompt', 'character-generate', { characterId: char.id, episodeId })
    await runPromptAgent({
      episodeId,
      dramaId: char.dramaId,
      characterImageRevision: { id: char.id, revision: char.imageRevision, invalidateOnSave: !opts?.forImageSubmission },
    }, `为角色「${char.name}」(character_id=${char.id}) 生成三视图最终提示词，并调用 save_character_final_prompt 保存。`, opts)
    const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, char.id))
    return fresh?.finalPrompt || ''
  } catch (err: any) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: char.id, error: err.message })
    return ''
  }
}

/** 全局角色使用同一个提示词 Agent 和角色参考图技能，不需要项目或剧集。 */
export async function generateGlobalCharacterFinalPrompt(char: typeof schema.globalCharacters.$inferSelect, stylePrompt: string, opts?: PromptAgentOptions): Promise<string> {
  const globalCharacterPrompt: GlobalCharacterPromptContext = {
    character: {
      id: char.id, name: char.name, role: char.role, appearance: char.appearance, physique: char.physique,
      styling: char.defaultStyling, personality: char.defaultPersonality,
    },
    stylePrompt,
  }
  try {
    logTaskProgress('FinalPrompt', 'global-character-generate', { globalCharacterId: char.id })
    await runPromptAgent({ globalCharacterPrompt },
      `为全局角色「${char.name}」(character_id=${char.id}) 生成角色参考图最终提示词：左侧正脸特写，右侧正面、90 度侧面、背面三张等高全身视图。沿用角色参考图技能规范，调用 read_characters 读取资料，然后调用 save_character_final_prompt 保存。本次为独立全局角色任务，没有项目、剧集或分镜；只处理指定角色。所选视觉风格由保存工具注入，不要自行添加风格词。`, opts)
    return globalCharacterPrompt.finalPrompt || ''
  } catch (err: any) {
    logTaskError('FinalPrompt', 'global-character-generate', { globalCharacterId: char.id, error: err.message })
    return ''
  }
}

/** 确保场景拥有固定视角（前中后景）最终提示词，返回最终提示词（失败返回 ''）；force 时忽略已有提示词强制重新生成 */
export async function ensureSceneFinalPrompt(scene: SceneRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<string> {
  if (scene.finalPrompt && !force) return scene.finalPrompt
  try {
    logTaskProgress('FinalPrompt', 'scene-generate', { sceneId: scene.id, episodeId })
    await runPromptAgent({ episodeId, dramaId: scene.dramaId },
      `为场景「${scene.location}」(scene_id=${scene.id}) 生成固定视角（前景/中景/后景）最终提示词，并调用 save_scene_final_prompt 保存。注意：这是无人物空镜——场景图中不能出现任何的人（含背影、剪影、倒影、照片里的人），即使场景描述提到人物活动也必须剔除，只保留场景本身。`, opts)
    const [fresh] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.id))
    return fresh?.finalPrompt || ''
  } catch (err: any) {
    logTaskError('FinalPrompt', 'scene-generate', { sceneId: scene.id, error: err.message })
    return ''
  }
}

/** 确保道具拥有白底单品最终提示词，返回最终提示词（失败返回 ''）；force 时忽略已有提示词强制重新生成 */
export async function ensurePropFinalPrompt(prop: PropRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<string> {
  if (prop.finalPrompt && !force) return prop.finalPrompt
  try {
    logTaskProgress('FinalPrompt', 'prop-generate', { propId: prop.id, episodeId })
    await runPromptAgent({ episodeId, dramaId: prop.dramaId },
      `为道具「${prop.name}」(prop_id=${prop.id}) 生成白底单品最终提示词，并调用 save_prop_final_prompt 保存。`, opts)
    const [fresh] = await db.select().from(schema.props).where(eq(schema.props.id, prop.id))
    return fresh?.finalPrompt || ''
  } catch (err: any) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: prop.id, error: err.message })
    return ''
  }
}
