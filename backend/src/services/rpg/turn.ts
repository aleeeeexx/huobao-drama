/**
 * 织界回合的纯逻辑：玩家行动解析、叙事流拆分、从短剧资产投影档案。
 * 不访问数据库，方便单测。续写、提取、分镜和提示词不在这里调用模型。
 */

export const RPG_STATE_SENTINEL = '<<<RPG_STATE>>>'
const FREE_TEXT_MAX = 400
const STILL_FRAME_NOTE = '单幅真人电影剧照，真实演员在实景中表演，主体清晰，不要文字，不要水印，不要分镜格子，不要动漫，不要二次元，不要卡通，不要插画'

export interface RpgChoice {
  id: string
  label: string
  detail: string
}

export interface RpgCharacter {
  name: string
  role: string
  status: string
  appearance: string
}

export interface RpgItem {
  name: string
  holder: string
  description: string
}

export interface RpgQuest {
  title: string
  status: 'active' | 'done' | 'failed'
  detail: string
}

export interface RpgSceneState {
  location: string
  time: string
  summary: string
  atmosphere: string
}

export interface RpgWorldState {
  scene: RpgSceneState
  characters: RpgCharacter[]
  items: RpgItem[]
  quests: RpgQuest[]
  memory: string
}

export interface ResolvedAction {
  mode: 'opening' | 'choice' | 'free'
  text: string
  choiceId: string | null
}

export const FALLBACK_CHOICES: RpgChoice[] = [
  { id: 'c1', label: '仔细观察四周', detail: '先弄清眼前的局面' },
  { id: 'c2', label: '上前搭话', detail: '找最近的人问个明白' },
  { id: 'c3', label: '先撤一步', detail: '不打草惊蛇，换个角度' },
]

export function emptyWorldState(premise = ''): RpgWorldState {
  return {
    scene: {
      location: '起点',
      time: '此时',
      summary: clip(premise, 80),
      atmosphere: '',
    },
    characters: [],
    items: [],
    quests: [],
    memory: '',
  }
}

export function resolvePlayerAction(
  body: { mode?: unknown; choice_id?: unknown; choiceId?: unknown; text?: unknown },
  latestChoices: RpgChoice[] | null,
  hasTurns: boolean,
): { ok: true; action: ResolvedAction } | { ok: false; message: string } {
  const mode = String(body?.mode || '').trim()
  const choiceId = String(body?.choice_id ?? body?.choiceId ?? '').trim()
  const text = String(body?.text ?? '').trim()

  if (!hasTurns) {
    if (mode && mode !== 'opening') return { ok: false, message: '这一局还没有开场，请先开始故事' }
    return { ok: true, action: { mode: 'opening', text: '', choiceId: null } }
  }
  if (mode === 'opening') return { ok: false, message: '开场已经写过了' }

  if (mode === 'choice') {
    if (!choiceId) return { ok: false, message: '请选择一个剧情走向' }
    const matched = (latestChoices || []).find(choice => choice.id === choiceId)
    if (!matched) return { ok: false, message: '这个选项已经不在当前回合' }
    return { ok: true, action: { mode: 'choice', text: matched.label, choiceId } }
  }

  if (mode === 'free') {
    if (!text) return { ok: false, message: '写下你要做的事' }
    if (text.length > FREE_TEXT_MAX) return { ok: false, message: `行动请控制在 ${FREE_TEXT_MAX} 字以内` }
    return { ok: true, action: { mode: 'free', text, choiceId: null } }
  }

  return { ok: false, message: '请点选剧情走向，或写下你的行动' }
}

/**
 * 把模型流式输出拆成「可展示的叙事」和「回合结束后的状态 JSON」。
 * script_rewriter 的多步 textStream 会把工具前后的工序说明和正文拼在一起，
 * 这里按句丢掉工序说明，玩家只收到故事。
 */
export class NarrativeStreamParser {
  private pending = ''
  private stateRaw = ''
  private inState = false
  private rawNarrative = ''
  private held = ''
  private seenProse = false
  narrative = ''

  push(chunk: string): string {
    if (!chunk) return ''
    if (this.inState) {
      this.stateRaw += chunk
      return ''
    }
    this.pending += chunk
    const fresh = this.pullFreshNarrative()
    if (!fresh) return ''
    this.rawNarrative += fresh
    this.held += fresh
    return this.flushHeld(false)
  }

  finish(): { narrative: string; rawNarrative: string; stateRaw: string; tail: string } {
    if (!this.inState) {
      const combined = this.rawNarrative + this.pending
      const marker = trailingStateIndex(combined)
      if (marker !== -1) {
        const narrativeRaw = combined.slice(0, marker)
        const consumed = this.rawNarrative.length - this.held.length
        this.rawNarrative = narrativeRaw
        this.held = narrativeRaw.slice(Math.min(Math.max(consumed, 0), narrativeRaw.length))
        this.stateRaw = combined.slice(marker).trim()
      } else {
        this.held += this.pending
        this.rawNarrative = combined
      }
      this.pending = ''
    }
    const tail = this.flushHeld(true)
    const narrative = visibleNarrative(this.rawNarrative)
    this.narrative = narrative
    return {
      narrative,
      rawNarrative: this.rawNarrative.trim(),
      stateRaw: this.stateRaw.trim(),
      tail,
    }
  }

  private pullFreshNarrative(): string {
    const marker = this.pending.indexOf(RPG_STATE_SENTINEL)
    if (marker === -1) {
      const hold = RPG_STATE_SENTINEL.length - 1
      if (this.pending.length <= hold) return ''
      const visible = this.pending.slice(0, this.pending.length - hold)
      this.pending = this.pending.slice(this.pending.length - hold)
      return visible
    }
    const visible = this.pending.slice(0, marker)
    this.stateRaw = this.pending.slice(marker + RPG_STATE_SENTINEL.length)
    this.pending = ''
    this.inState = true
    return visible
  }

  /** 句子没收尾时先攒着，避免工序说明只到一半就被推给玩家。 */
  private flushHeld(final: boolean): string {
    let emitted = ''
    while (this.held) {
      const next = takeSentence(this.held, final)
      if (!next) break
      this.held = next.rest
      if (isPipelineMetaSentence(next.sentence)) continue
      if (!next.sentence.trim()) {
        if (!this.seenProse) continue
        emitted += next.sentence
        continue
      }
      this.seenProse = true
      emitted += next.sentence
    }
    return emitted
  }
}

/** 没有分隔符时，从含 choices / scene 的那一层 { 切开，而不是最内层括号。 */
function trailingStateIndex(text: string): number {
  let best = -1
  for (const key of ['"choices"', '"scene"']) {
    let from = 0
    while (from < text.length) {
      const keyAt = text.indexOf(key, from)
      if (keyAt === -1) break
      const brace = text.lastIndexOf('{', keyAt)
      if (brace > 20 && (best === -1 || brace < best)) best = brace
      from = keyAt + key.length
    }
  }
  return best
}

export function salvageTrailingState(text: string): { narrative: string; stateRaw: string } {
  const marker = trailingStateIndex(text)
  if (marker === -1) return { narrative: text.trim(), stateRaw: '' }
  return { narrative: text.slice(0, marker).trim(), stateRaw: text.slice(marker).trim() }
}

const SENTENCE_PATTERN = /[^。！？!?\n]*[。！？!?]+|[^。！？!?\n]+/g

function takeSentence(text: string, final: boolean): { sentence: string; rest: string } | null {
  const match = text.match(/^[。！？!?\n]|[^。！？!?\n]+[。！？!?\n]?/)
  if (!match?.[0]) return null
  const sentence = match[0]
  if (!final && !/[。！？!?\n]$/.test(sentence)) return null
  return { sentence, rest: text.slice(sentence.length) }
}

/**
 * 工序说明和故事正文走的是同一条 textStream。
 * 只丢掉「读本集 / 写入剧本 / 补上正文」这类句子，不改故事里的纸页、信和杯子。
 */
export function isPipelineMetaSentence(sentence: string): boolean {
  const text = sentence.replace(/\s+/g, '')
  if (!text) return false
  if (/^##S\d+\b/.test(text)) return true
  if (/read_episode_script|save_script/i.test(text)) return true
  if (/给(?:玩家|你)看的正文/.test(text)) return true
  if (/落进剧本|保存剧本|保存完整剧本/.test(text)) return true
  if (/读取(?:本集|当前集)|已有正文|先读本集/.test(text)) return true
  if (/续写第\d+幕/.test(text)) return true
  if (/补上正文|正文补上/.test(text)) return true
  if (/先把这一幕|这一幕写入剧本/.test(text)) return true
  if (/写入剧本/.test(text) && /(?:我|先把|补上|保存|读取|这一幕)/.test(text)) return true
  if (/剧本改写|不要绕过工具|不要写进回复|不要输出任何文字|从故事的第一句/.test(text)) return true
  if (/^(?:我先|让我先|接下来我)/.test(text) && /(?:剧本|正文|本集|续写第)/.test(text)) return true
  return false
}

export function stripPipelineMeta(text: string): string {
  if (!text) return ''
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = new RegExp(SENTENCE_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (!match[0].trim()) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  let kept = ''
  let cursor = 0
  for (const range of ranges) {
    if (!isPipelineMetaSentence(text.slice(range.start, range.end))) continue
    kept += text.slice(cursor, range.start)
    cursor = range.end
  }
  kept += text.slice(cursor)
  return kept
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/[ \t]+$/, '')
}

/** 只读取剧情分支。角色、场景、物品以提取 Agent 写入的资产为准，不采用这段 JSON。 */
export function choicesFromPayload(raw: string): RpgChoice[] {
  return normalizeChoices(parseJsonObject(raw)?.choices)
}

export interface ProjectedCharacter {
  name: string
  role?: string | null
  description?: string | null
  appearance?: string | null
  styling?: string | null
}

export interface ProjectedScene {
  id: number
  location: string
  time?: string | null
  prompt?: string | null
  lighting?: string | null
  updatedAt?: string | null
}

export interface ProjectedProp {
  name: string
  type?: string | null
  description?: string | null
}

/**
 * 把短剧资产投影成玩家档案。
 * 事务没有对应的工作室实体，沿用上一幕已记下的条目。
 */
export function projectWorldState(
  previous: RpgWorldState,
  assets: { characters: ProjectedCharacter[]; scenes: ProjectedScene[]; props: ProjectedProp[] },
  preferredSceneId?: number | null,
): { state: RpgWorldState; sceneId: number | null } {
  const scene = pickScene(assets.scenes, preferredSceneId)
  const sceneState: RpgSceneState = scene
    ? {
      location: clip(scene.location || '未知地点', 40) || '未知地点',
      time: clip(scene.time || '此时', 20) || '此时',
      summary: clip(scene.prompt || '', 160),
      atmosphere: clip(scene.lighting || '', 80),
    }
    : previous.scene
  const characters = assets.characters.length
    ? assets.characters.slice(0, 8).map(projectCharacter).filter(item => item.name)
    : previous.characters
  const items = assets.props.length
    ? assets.props.slice(0, 8).map(projectProp).filter(item => item.name)
    : previous.items
  return {
    sceneId: scene?.id ?? null,
    state: {
      scene: sceneState,
      characters,
      items,
      quests: previous.quests,
      memory: sceneState.summary || previous.memory,
    },
  }
}

export function sceneIdFromScreenplay(
  script: string,
  turnIndex: number,
  scenes: Array<{ id: number; location: string }>,
): number | null {
  const header = script.match(new RegExp(`##\\s*S${turnIndex}\\b[^\\n]*`))
  if (!header) return null
  const matched = scenes.find(scene => scene.location && header[0].includes(scene.location))
  return matched?.id ?? null
}

export function scriptHasScene(script: string, turnIndex: number): boolean {
  return new RegExp(`##\\s*S${turnIndex}\\b`).test(script || '')
}

export function narrativeFromScreenplay(script: string, turnIndex: number): string {
  const match = (script || '').match(new RegExp(`##\\s*S${turnIndex}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s*S\\d+\\b|$)`))
  if (!match) return ''
  return visibleNarrative(match[1].replace(/^\s*（玩家行动）[^\n]*\n+/, ''))
}

export function stripChoiceTail(script: string): string {
  const marker = script.indexOf(RPG_STATE_SENTINEL)
  if (marker === -1) return script
  return script.slice(0, marker).trim()
}

export function visibleNarrative(text: string): string {
  return stripPipelineMeta(text).trim()
}

/** 模型若把场景头写进回复，回退补剧本时沿用这个地点，而不是上一幕的地点。 */
export function locationFromNarrativeHeader(text: string): { location: string; time: string } | null {
  const match = text.match(/(?:^|\n)##\s*S\d+\s*\|[^|\n]*·\s*([^|\n]+?)\s*\|\s*([^\n]+)/)
  if (!match) return null
  const location = match[1].trim()
  const time = match[2].trim()
  if (!location) return null
  return { location, time: time || '此时' }
}

export function formatScreenplayScene(
  turnIndex: number,
  state: RpgWorldState,
  narrative: string,
  playerText: string | null,
): string {
  const location = state.scene.location || '未知地点'
  const time = state.scene.time || '日'
  const interior = /室|屋|房|殿|舱|寮|店|栈|阁|厅/.test(location) ? '内景' : '外景'
  const action = playerText ? `（玩家行动）${playerText}\n\n` : ''
  return `## S${turnIndex} | ${interior} · ${location} | ${time}\n\n${action}${narrative.trim()}\n`
}

/**
 * 插画提示词由场景最终提示词（prompt_generator，已含项目风格）和资产外貌拼成。
 * 场景 Agent 的最终提示词是空镜；这里补上本幕出场的人，避免玩家插画变成无人设定图。
 */
export function assembleStillPrompt(input: {
  stylePrompt: string
  sceneFinalPrompt: string
  location: string
  time: string
  scenePrompt: string
  lighting: string
  characters: Array<{ name: string; appearance?: string; role?: string }>
  narrative: string
}): string {
  const style = input.stylePrompt.trim()
  const plate = input.sceneFinalPrompt.trim()
  const head = plate
    ? (style && !plate.startsWith(style) ? `${style}，\n${plate}` : plate)
    : [style, input.location, input.time, input.scenePrompt, input.lighting].filter(part => part && part.trim()).join('，')
  const people = input.characters
    .slice(0, 3)
    .map(character => {
      const name = clip(character.name || '', 20)
      if (!name) return ''
      return `${name}（${clip(character.appearance || character.role || '人物', 80)}）`
    })
    .filter(Boolean)
    .join('，')
  return [
    head,
    STILL_FRAME_NOTE,
    people ? `画面中的人物：${people}` : '',
    input.narrative ? `这一幕：${clip(input.narrative, 180)}` : '',
  ].filter(Boolean).join('\n')
}

export function buildPlayRewriteMessage(input: {
  worldTitle: string
  genre: string
  premise: string
  actionLine: string
  turnIndex: number
  existingScript: string
  recent: string
}): string {
  return [
    '这是互动短剧「织界」的一回合。你仍是剧本改写 Agent，必须用工具读完再保存。不要绕过工具直接结束。工具调用不要写进回复。',
    `世界：${input.worldTitle}`,
    input.genre ? `类型：${input.genre}` : '',
    `设定：${input.premise}`,
    input.recent ? `最近剧情：\n${input.recent}` : '',
    input.existingScript
      ? `已保存的剧本（续写时整段保留，只在末尾追加本幕）：\n${input.existingScript}`
      : '还没有已保存的剧本。',
    input.actionLine,
    '请按顺序完成：',
    '1. 调用 read_episode_script 读取当前集正文。这一步不要输出任何文字。',
    `2. 回复只写第 ${input.turnIndex} 幕的故事，并且从故事的第一句写起：简体中文，第二人称「你」，280 到 420 字，一段或两段。不要写场景头，不要复述旧剧本，不要写「选项」三个字。不要写计划、步骤或工作说明，也不要出现「读取本集」「写入剧本」「落进剧本」「保存剧本」「补上正文」「给玩家看的正文」。`,
    `3. 正文结束后另起一行，只输出一次 ${RPG_STATE_SENTINEL}，然后输出 JSON：{"choices":[{"id":"c1","label":"不超过18字","detail":"不超过36字"},{"id":"c2","label":"第二条","detail":"不同方向"},{"id":"c3","label":"第三条","detail":"再一个方向"}]}。恰好 3 条，方向不同。不要用 markdown 代码块。不要在 JSON 里写角色、物品或场景；那些由提取 Agent 从剧本里读取。`,
    `4. 调用 save_script 保存完整剧本：已有场景全部保留，并追加一个场景，场景头为 ## S${input.turnIndex} | 内景或外景 · 地点 | 时间。这一步不要输出任何文字。格式化剧本只放进 save_script，不要把分隔符和 JSON 写进剧本。不要替玩家写结局。`,
  ].filter(Boolean).join('\n\n')
}

export function buildPlayStoryboardMessage(input: {
  turnIndex: number
  narrative: string
  screenplay: string
  videoLabel: string
  characters: Array<{ id: number; name: string }>
  scenes: Array<{ id: number; location: string; time?: string | null }>
  props: Array<{ id: number; name: string }>
}): string {
  const characters = input.characters.length
    ? input.characters.map(item => `${item.name}(ID:${item.id})`).join('、')
    : '（当前集还没有角色）'
  const scenes = input.scenes.length
    ? input.scenes.map(item => `${item.location} · ${item.time || '未设时间'}(ID:${item.id})`).join('、')
    : '（当前集还没有场景）'
  const props = input.props.length
    ? input.props.map(item => `${item.name}(ID:${item.id})`).join('、')
    : '（当前集还没有道具）'
  return [
    `请只为第 ${input.turnIndex} 幕追加 1 个分镜，shot_number 必须是 ${input.turnIndex}。`,
    '不要把 replace_existing 设为 true，不要删除或改写其他分镜号。',
    `本次视频模型：${input.videoLabel}。请按该模型的特性与时长限制写 video_prompt。`,
    `当前集已有角色：${characters}`,
    `当前集已有场景：${scenes}`,
    `当前集已有道具：${props}`,
    '绑定要求与制作台拆分相同：character_ids、scene_id、prop_ids 只能来自上面的 ID。有角色出场就要绑定，没有道具可传空数组。',
    '这一幕剧本：',
    input.screenplay || input.narrative,
  ].join('\n')
}

export function describeAction(action: ResolvedAction, choices: RpgChoice[]): string {
  if (action.mode === 'opening') return '请写下这一局的开场，把玩家放进世界。'
  if (action.mode === 'choice') {
    const matched = choices.find(choice => choice.id === action.choiceId)
    const detail = matched?.detail ? `（${matched.detail}）` : ''
    return `玩家选择了剧情走向：「${action.text}」${detail}`
  }
  return `玩家写下了自己的行动：「${action.text}」`
}

function normalizeChoices(value: unknown): RpgChoice[] {
  if (!Array.isArray(value)) return FALLBACK_CHOICES.map(choice => ({ ...choice }))
  const choices: RpgChoice[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = clip(String(record.label || record.text || ''), 18)
    if (!label) continue
    const id = clip(String(record.id || `c${choices.length + 1}`), 16) || `c${choices.length + 1}`
    choices.push({
      id,
      label,
      detail: clip(String(record.detail || record.hint || ''), 36),
    })
    if (choices.length === 3) break
  }
  if (choices.length < 2) return FALLBACK_CHOICES.map(choice => ({ ...choice }))
  return choices.map((choice, index) => ({ ...choice, id: choice.id || `c${index + 1}` }))
}

function pickScene(scenes: ProjectedScene[], preferredSceneId?: number | null): ProjectedScene | null {
  if (!scenes.length) return null
  if (preferredSceneId) {
    const preferred = scenes.find(scene => scene.id === preferredSceneId)
    if (preferred) return preferred
  }
  return [...scenes].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0]
}

function projectCharacter(row: ProjectedCharacter): RpgCharacter {
  return {
    name: clip(row.name || '', 40),
    role: clip(row.role || '', 40),
    status: clip(row.description || '', 120),
    appearance: clip([row.appearance, row.styling].filter(Boolean).join('，'), 200),
  }
}

function projectProp(row: ProjectedProp): RpgItem {
  return {
    name: clip(row.name || '', 40),
    holder: clip(row.type || '', 40),
    description: clip(row.description || '', 200),
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}
