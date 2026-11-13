/**
 * 提示词生成 Agent 工具
 * 模块级单例 — dramaId 通过 RequestContext 按请求注入
 *
 * Agent 负责创作最终提示词：
 * 1. 角色 → 三视图（character turnaround：正面/侧面/背面）
 * 2. 场景 → 固定视角 + 前景/中景/后景分层构图
 * 3. 道具 → 白底单品静物（single product shot on pure white background）
 * 工具负责读取资产信息与保存 Agent 产出的最终提示词（保存时注入项目视觉风格）
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { and, eq, sql } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { getDramaStylePrompt } from '../../services/style-preset.js'
import { getDramaId, getGlobalCharacterPrompt } from '../context.js'

// ─── 角色提示词 ───────────────────────────────────────

const readCharacters = createTool({
  id: 'read_characters',
  description: '读取当前项目角色，或本次指定的全局角色资料，用于生成正脸特写加全身三视图的角色参考图提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const globalPrompt = getGlobalCharacterPrompt(context?.requestContext)
    if (globalPrompt) {
      const character = globalPrompt.character
      return { characters: [{
        id: character.id,
        name: character.name,
        role: character.role || '',
        description: character.appearance || '',
        appearance: character.appearance || '',
        physique: character.physique || '',
        styling: character.styling || '',
        personality: character.personality || '',
        final_prompt: globalPrompt.finalPrompt || '',
      }] }
    }
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const chars = (await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId)))
      .filter(c => !c.deletedAt)
    return {
      characters: chars.map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        physique: c.physique || '',
        styling: c.styling || '',
        personality: c.personality || '',
        final_prompt: c.finalPrompt || '',
      })),
    }
  },
})

const saveCharacterFinalPrompt = createTool({
  id: 'save_character_final_prompt',
  description: '保存为角色创作的参考图最终提示词（正脸特写加全身三视图）。项目风格或本次选定风格由工具自动拼接，prompt 参数中不要包含风格词。全局角色结果保存到本次请求供生图使用。',
  inputSchema: z.object({
    character_id: z.number(),
    prompt: z.string().describe('角色三视图最终提示词（使用会话语言指令指定的目标语言，不含风格词）'),
  }),
  execute: async ({ character_id, prompt }, context) => {
    const globalPrompt = getGlobalCharacterPrompt(context?.requestContext)
    if (globalPrompt) {
      if (character_id !== globalPrompt.character.id) return { error: '只能保存本次指定的全局角色提示词' }
      if (!prompt.trim()) return { error: '角色提示词不能为空' }
      globalPrompt.finalPrompt = globalPrompt.stylePrompt ? `${globalPrompt.stylePrompt}, ${prompt.trim()}` : prompt.trim()
      return {
        character_id,
        character_name: globalPrompt.character.name,
        saved: true,
        final_prompt: globalPrompt.finalPrompt,
      }
    }
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [c] = await db.select().from(schema.characters)
      .where(eq(schema.characters.id, character_id))
    if (!c) return { error: 'Character not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    const expected = context?.requestContext?.get('characterImageRevision' as never) as { id: number; revision: number; invalidateOnSave?: boolean } | undefined
    if (expected?.id === character_id && expected.revision !== c.imageRevision) return { error: '角色资料已更新，请重新生成提示词' }
    const result = await db.update(schema.characters)
      .set({ finalPrompt, finalPromptAuto: true,
        ...(expected?.invalidateOnSave === false ? {} : { imageRevision: sql`${schema.characters.imageRevision} + 1` }), updatedAt: now() })
      .where(expected?.id === character_id
        ? and(eq(schema.characters.id, character_id), eq(schema.characters.imageRevision, expected.revision))
        : eq(schema.characters.id, character_id))
    if (!result.changes) return { error: '角色资料已更新，请重新生成提示词' }

    return {
      character_id: c.id,
      character_name: c.name,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

// ─── 场景提示词 ───────────────────────────────────────

const readScenes = createTool({
  id: 'read_scenes',
  description: '读取当前剧集中的所有场景信息，用于生成场景固定视角最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const scenes = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)))
      .filter(s => !s.deletedAt)
    return {
      scenes: scenes.map(s => ({
        id: s.id,
        location: s.location,
        time: s.time || '',
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        final_prompt: s.finalPrompt || '',
      })),
    }
  },
})

const saveSceneFinalPrompt = createTool({
  id: 'save_scene_final_prompt',
  description: '保存为场景创作的固定视角（前景/中景/后景）最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。',
  inputSchema: z.object({
    scene_id: z.number(),
    prompt: z.string().describe('场景固定视角最终提示词（使用会话语言指令指定的目标语言，不含风格词）'),
  }),
  execute: async ({ scene_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [s] = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.id, scene_id))
    if (!s) return { error: 'Scene not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    await db.update(schema.scenes)
      .set({ finalPrompt, updatedAt: now() })
      .where(eq(schema.scenes.id, scene_id))

    return {
      scene_id: s.id,
      location: s.location,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

// ─── 道具提示词 ───────────────────────────────────────

const readProps = createTool({
  id: 'read_props',
  description: '读取当前剧集项目中的所有道具信息，用于生成道具白底单品最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const props = (await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId)))
      .filter(p => !p.deletedAt)
    return {
      props: props.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        final_prompt: p.finalPrompt || '',
      })),
    }
  },
})

const savePropFinalPrompt = createTool({
  id: 'save_prop_final_prompt',
  description: '保存为道具创作的白底单品最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。',
  inputSchema: z.object({
    prop_id: z.number(),
    prompt: z.string().describe('道具白底单品最终提示词（使用会话语言指令指定的目标语言，不含风格词）'),
  }),
  execute: async ({ prop_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [p] = await db.select().from(schema.props)
      .where(eq(schema.props.id, prop_id))
    if (!p) return { error: 'Prop not found' }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    await db.update(schema.props)
      .set({ finalPrompt, updatedAt: now() })
      .where(eq(schema.props.id, prop_id))

    return {
      prop_id: p.id,
      prop_name: p.name,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

export const imagePromptTools = {
  readCharacters,
  saveCharacterFinalPrompt,
  readScenes,
  saveSceneFinalPrompt,
  readProps,
  savePropFinalPrompt,
}
