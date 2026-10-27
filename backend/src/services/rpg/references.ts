/**
 * 织界画面要锁住哪几张参考图。纯函数，不访问数据库。
 * 顺序与制作台分镜一致：场景图、角色定妆、道具单品。
 */

export const PLAY_STILL_PROMPT_MARK = '单幅真人电影剧照'
export const PLAY_STILL_FRAME = 'play_still'
export const ASSET_REFERENCE_FRAME = 'asset_reference'
export const PLAY_REFERENCE_WAIT_MS = 180_000
export const STILL_CHARACTER_LIMIT = 3
export const STILL_PROP_LIMIT = 2
export const STILL_REFERENCE_LIMIT = 6
export const VIDEO_REFERENCE_LIMIT = 9

export type ReferenceKind = 'scene' | 'character' | 'prop' | 'still'

export interface VisualReference {
  kind: ReferenceKind
  name: string
  imageUrl: string
}

export type AssetEnqueueDecision = 'use-existing' | 'reuse-task' | 'skip-failed' | 'enqueue'

/** 绘制中的剧情图继续轮询。已完成的图只有玩家明确重画时才另开一张。 */
export function reuseExistingStill(status: string | null | undefined, force: boolean): boolean {
  if (status === 'processing') return true
  if (status === 'completed' && !force) return true
  return false
}

export function decideAssetEnqueue(input: {
  hasImage: boolean
  latestStatus: 'processing' | 'completed' | 'failed' | null
  skipIfPresent: boolean
  retryFailed: boolean
}): AssetEnqueueDecision {
  if (!input.skipIfPresent) return 'enqueue'
  if (input.hasImage) return 'use-existing'
  if (input.latestStatus === 'processing') return 'reuse-task'
  if (input.latestStatus === 'failed' && !input.retryFailed) return 'skip-failed'
  return 'enqueue'
}

/** 制作台参考图任务，以及还没写 frameType 的旧资产图。剧情图和分镜帧不算。 */
export function isAssetReferenceTask(input: {
  frameType?: string | null
  prompt?: string | null
  storyboardId?: number | null
  characterId?: number | null
  sceneId?: number | null
  propId?: number | null
}): boolean {
  if (input.frameType === ASSET_REFERENCE_FRAME) return true
  if (input.frameType === PLAY_STILL_FRAME) return false
  if (input.storyboardId) return false
  if (input.frameType === 'first_frame' || input.frameType === 'last_frame') return false
  if ((input.prompt || '').includes(PLAY_STILL_PROMPT_MARK)) return false
  return !!(input.characterId || input.sceneId || input.propId)
}

export function mentionedByName<T extends { name: string }>(assets: T[], narrative: string): T[] {
  const text = narrative || ''
  const ranked = assets
    .map((asset, index) => ({ asset, index, name: asset.name.trim() }))
    .filter(item => item.name.length > 0)
    .sort((left, right) => right.name.length - left.name.length || left.index - right.index)
  const used = new Array<boolean>(text.length).fill(false)
  const hits: Array<{ asset: T; index: number }> = []
  for (const item of ranked) {
    let from = 0
    let found = false
    while (from <= text.length - item.name.length) {
      const at = text.indexOf(item.name, from)
      if (at < 0) break
      let overlaps = false
      for (let cursor = at; cursor < at + item.name.length; cursor++) {
        if (used[cursor]) overlaps = true
      }
      if (!overlaps) {
        for (let cursor = at; cursor < at + item.name.length; cursor++) used[cursor] = true
        found = true
        break
      }
      from = at + 1
    }
    if (found) hits.push({ asset: item.asset, index: item.index })
  }
  return hits.sort((left, right) => left.index - right.index).map(item => item.asset)
}

/**
 * 本幕要画进剧情图的人。
 * 正文点了名就用被点名的人；否则用分镜绑定；再没有就沿用档案里靠前的角色（和原来的提示词人数一致）。
 */
export function selectPlayCharacters<T extends { id: number; name: string }>(
  characters: T[],
  narrative: string,
  boundIds: number[] = [],
  limit = STILL_CHARACTER_LIMIT,
): T[] {
  const mentioned = mentionedByName(characters, narrative)
  if (mentioned.length) return mentioned.slice(0, limit)
  if (boundIds.length) {
    const bound = new Set(boundIds)
    const picked = characters.filter(item => bound.has(item.id))
    if (picked.length) return picked.slice(0, limit)
  }
  return characters.slice(0, limit)
}

/** 道具只在正文点名或分镜绑定时带上，避免每张剧情图都塞进整集道具。 */
export function selectPlayProps<T extends { id: number; name: string }>(
  props: T[],
  narrative: string,
  boundIds: number[] = [],
  limit = STILL_PROP_LIMIT,
): T[] {
  const mentioned = mentionedByName(props, narrative)
  if (mentioned.length) return mentioned.slice(0, limit)
  if (!boundIds.length) return []
  const bound = new Set(boundIds)
  return props.filter(item => bound.has(item.id)).slice(0, limit)
}

export function stillPromptCharacters(
  assets: Array<{ name: string; role?: string | null; appearance?: string | null; styling?: string | null }>,
  stateCharacters: Array<{ name: string; role?: string; appearance?: string }>,
): Array<{ name: string; role: string; appearance: string }> {
  const source = assets.length
    ? assets
    : stateCharacters.map(item => ({ name: item.name, role: item.role || '', appearance: item.appearance || '', styling: '' }))
  return source.flatMap(asset => {
    const name = asset.name.trim()
    if (!name) return []
    const known = stateCharacters.find(item => item.name === name)
    const appearance = known?.appearance
      || [asset.appearance, asset.styling].filter(Boolean).join('，')
      || asset.role
      || known?.role
      || '人物'
    return [{
      name,
      role: asset.role || known?.role || '',
      appearance,
    }]
  })
}

export function buildStillReferences(input: {
  scene?: { name: string; imageUrl?: string | null } | null
  characters?: Array<{ name: string; imageUrl?: string | null }>
  props?: Array<{ name: string; imageUrl?: string | null }>
  extras?: Array<{ kind: ReferenceKind; name: string; imageUrl?: string | null }>
  limit?: number
}): VisualReference[] {
  const limit = input.limit ?? STILL_REFERENCE_LIMIT
  const refs: VisualReference[] = []
  const push = (kind: ReferenceKind, name: string, imageUrl?: string | null) => {
    const url = (imageUrl || '').trim()
    if (!url || refs.some(item => item.imageUrl === url) || refs.length >= limit) return
    refs.push({ kind, name: (name || '').trim(), imageUrl: url })
  }
  if (input.scene) push('scene', input.scene.name, input.scene.imageUrl)
  for (const character of input.characters || []) push('character', character.name, character.imageUrl)
  for (const prop of input.props || []) push('prop', prop.name, prop.imageUrl)
  for (const extra of input.extras || []) push(extra.kind, extra.name, extra.imageUrl)
  return refs
}

/** 与制作台 genVid 相同：@名字 → @图片N名字，N 按参考图顺序从 1 起。 */
export function applyReferenceMarkers(prompt: string, refs: Array<{ name: string }>): string {
  const nameToIndex: Record<string, number> = {}
  refs.forEach((ref, index) => {
    const name = ref.name.trim()
    if (name && !(name in nameToIndex)) nameToIndex[name] = index + 1
  })
  const names = Object.keys(nameToIndex).sort((left, right) => right.length - left.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@]+)/g, (match, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) return `@图片${nameToIndex[name]}${name}${raw.slice(name.length)}`
    }
    return match
  })
}
