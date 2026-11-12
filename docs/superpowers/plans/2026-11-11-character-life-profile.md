# Character Life Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 角色库用固定的脸和身材，加上一组会随世界改写的默认生活细节，让新建角色成为一个完整的人。

**Architecture:** 纯函数负责档案字段、适配、失败回退和正文要求。全局角色表只新增默认生活细节列；本局版本留在 `player_character` 快照里。项目角色继续只同步姓名、身份、外貌、身材、性格、经历和服装。只有外貌、身材或服装变化才更换定妆图。

**Tech Stack:** TypeScript、Hono、Drizzle、better-sqlite3、Nuxt 3、Vue 3、`node:test`。

**Spec:** `docs/superpowers/specs/2026-11-11-character-life-profile-design.md`

---

## File map

- `backend/src/services/rpg/player-character.ts`：档案字段、快照归一化、适配、回退、定妆是否变化、正文要求。
- `backend/src/services/global-character.ts`：角色库草稿和本世界生成草稿。
- `backend/src/db/schema.ts` 与 `backend/src/db/sqlite-schema.ts`：新的默认列和旧库补列。
- `backend/src/routes/global-characters.ts`：保存这些默认值。
- `backend/src/services/rpg/engine.ts`：开局复制、适配写回、本局编辑。不回写全局角色。
- `frontend/app/pages/characters.vue`：两组表单。
- `frontend/app/views/rpg/play.vue`：展示和编辑本世界版本，脸和身材标成跨世界不变。
- 测试文件见各任务。制作台 `episode.vue` 不改。

字段对照：

| 本世界键 | 默认键 | 全局表列 |
| --- | --- | --- |
| `name` | `default_name` | 已有 `name` |
| `role` | `default_role` | 已有 `role` |
| `personality` | `default_personality` | 已有 `default_personality` |
| `values` | `default_values` | 新增 |
| `speech` | `default_speech` | 新增 |
| `habits` | `default_habits` | 新增 |
| `desires` | `default_desires` | 新增 |
| `fears` | `default_fears` | 新增 |
| `relationships` | `default_relationships` | 新增 |
| `abilities` | `default_abilities` | 新增 |
| `background` | `default_background` | 新增 |
| `styling` | `default_styling` | 已有 `default_styling` |

`appearance` 和 `physique` 没有默认副本。

## Task 1: 档案纯函数

**Files:**
- Modify: `backend/src/services/rpg/player-character.ts`
- Test: `backend/tests/rpg-player-character.test.ts`

- [ ] **Step 1: 用新行为替换测试**

把 `backend/tests/rpg-player-character.test.ts` 换成：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptPlayerCharacter,
  fallbackPlayerCharacter,
  normalizeStoredPlayerCharacter,
  playerProfileFromDefaults,
  portraitFieldsChanged,
  withPlayerCharacterGuidance,
  type PlayerCharacterSnapshot,
} from '../src/services/rpg/player-character.ts'

const profile = playerProfileFromDefaults({
  name: '林雾',
  role: '医生',
  personality: '谨慎但富有同情心',
  values: '先救人',
  speech: '短句、少下判断',
  habits: '先洗手再问诊',
  desires: '找到失踪的老师',
  fears: '再次迟到',
  relationships: '记挂老师和邻居孩子',
  abilities: '外伤处理和辨认药材',
  background: '在边境诊所长大',
  styling: '深色风衣',
})

const character: PlayerCharacterSnapshot = {
  global_character_id: 7,
  project_character_id: 12,
  appearance: '短发，左眉有浅疤',
  physique: '高挑清瘦',
  ...profile,
  image_url: '/static/lin-wu.png',
  adapted: false,
}

test('world adaptation rewrites life details and preserves face and physique', () => {
  const adapted = adaptPlayerCharacter(character, `\`\`\`json
{"name":"阿雾","role":"边境医官","appearance":"不该被采用的外貌","physique":"不该被采用的身材","personality":"冷静果断","values":"完成任务优先","speech":"军中用语","habits":"睡前检查药箱","desires":"活过这个冬天","fears":"药物用尽","relationships":"只信任同营的护士","abilities":"战地止血","background":"被征召离开诊所","styling":"旧军医制服"}
\`\`\``)
  assert.equal(adapted.name, '阿雾')
  assert.equal(adapted.role, '边境医官')
  assert.equal(adapted.appearance, character.appearance)
  assert.equal(adapted.physique, character.physique)
  assert.equal(adapted.values, '完成任务优先')
  assert.equal(adapted.speech, '军中用语')
  assert.equal(adapted.habits, '睡前检查药箱')
  assert.equal(adapted.desires, '活过这个冬天')
  assert.equal(adapted.fears, '药物用尽')
  assert.equal(adapted.relationships, '只信任同营的护士')
  assert.equal(adapted.abilities, '战地止血')
  assert.equal(adapted.background, '被征召离开诊所')
  assert.equal(adapted.styling, '旧军医制服')
  assert.equal(adapted.default_name, '林雾')
  assert.equal(adapted.adapted, true)
})

test('missing adaptation fields and failed calls keep defaults', () => {
  const partial = adaptPlayerCharacter(character, '{"background":"旧城长大","values":42}')
  assert.equal(partial.personality, character.default_personality)
  assert.equal(partial.values, character.default_values)
  assert.equal(partial.styling, character.default_styling)
  assert.equal(partial.background, '旧城长大')
  assert.throws(() => adaptPlayerCharacter(character, 'not json'))
  const fallback = fallbackPlayerCharacter({ ...character, name: '临时名', values: '临时价值观', styling: '临时衣服' })
  assert.equal(fallback.name, character.default_name)
  assert.equal(fallback.values, character.default_values)
  assert.equal(fallback.styling, character.default_styling)
  assert.equal(fallback.appearance, character.appearance)
})

test('stored snapshots without new keys remain usable', () => {
  const legacy = normalizeStoredPlayerCharacter({
    global_character_id: 7,
    project_character_id: 12,
    name: '林雾',
    role: '医生',
    appearance: '短发',
    physique: '清瘦',
    default_personality: '谨慎',
    default_styling: '深色风衣',
    personality: '谨慎',
    background: '',
    styling: '深色风衣',
    image_url: '/static/lin-wu.png',
    adapted: false,
  } as PlayerCharacterSnapshot)
  assert.equal(legacy.default_name, '林雾')
  assert.equal(legacy.values, '')
  assert.equal(legacy.default_values, '')
  assert.equal(legacy.default_personality, '谨慎')
})

test('only face, physique, and clothing refresh a portrait', () => {
  assert.equal(portraitFieldsChanged(character, { ...character, values: '另一种价值观' }), false)
  assert.equal(portraitFieldsChanged(character, { ...character, styling: '旧军医制服' }), true)
  assert.equal(portraitFieldsChanged(character, { ...character, appearance: '长发' }), true)
  assert.equal(portraitFieldsChanged(character, { ...character, physique: '矮小' }), true)
})

test('player guidance lists the world life and keeps face and physique fixed', () => {
  const first = withPlayerCharacterGuidance('世界规则：不能撒谎', character)
  const next = withPlayerCharacterGuidance(first, { ...character, styling: '旧军医制服', name: '阿雾' })
  assert.equal(next.split('【玩家主角设定】').length - 1, 1)
  assert.match(next, /世界规则：不能撒谎/)
  assert.match(next, /本世界姓名：阿雾/)
  assert.match(next, /本世界价值观：先救人/)
  assert.match(next, /本世界服装与妆造：旧军医制服/)
  assert.match(next, /固定外貌：短发，左眉有浅疤/)
  assert.match(next, /固定身材：高挑清瘦/)
  assert.match(next, /始终保持脸部外貌和身材与固定设定一致/)
  assert.doesNotMatch(next, /始终保持姓名、身份/)
})
```

- [ ] **Step 2: 确认测试失败**

Run: `cd backend && node --import tsx --test tests/rpg-player-character.test.ts`

Expected: FAIL，因为新导出的函数还不存在。

- [ ] **Step 3: 实现档案函数**

把 `backend/src/services/rpg/player-character.ts` 换成：

```ts
export interface PlayerCharacterSnapshot {
  global_character_id: number | null
  project_character_id: number
  name: string
  role: string
  appearance: string
  physique: string
  default_name: string
  default_role: string
  default_personality: string
  default_values: string
  default_speech: string
  default_habits: string
  default_desires: string
  default_fears: string
  default_relationships: string
  default_abilities: string
  default_background: string
  default_styling: string
  personality: string
  values: string
  speech: string
  habits: string
  desires: string
  fears: string
  relationships: string
  abilities: string
  background: string
  styling: string
  image_url: string
  adapted: boolean
}

export const PLAYER_PROFILE_FIELDS = [
  { world: 'name', fallback: 'default_name', guidance: '本世界姓名' },
  { world: 'role', fallback: 'default_role', guidance: '本世界身份' },
  { world: 'personality', fallback: 'default_personality', guidance: '本世界性格' },
  { world: 'values', fallback: 'default_values', guidance: '本世界价值观' },
  { world: 'speech', fallback: 'default_speech', guidance: '本世界说话方式' },
  { world: 'habits', fallback: 'default_habits', guidance: '本世界习惯' },
  { world: 'desires', fallback: 'default_desires', guidance: '本世界愿望' },
  { world: 'fears', fallback: 'default_fears', guidance: '本世界恐惧' },
  { world: 'relationships', fallback: 'default_relationships', guidance: '本世界在乎的人' },
  { world: 'abilities', fallback: 'default_abilities', guidance: '本世界能力' },
  { world: 'background', fallback: 'default_background', guidance: '本世界经历' },
  { world: 'styling', fallback: 'default_styling', guidance: '本世界服装与妆造' },
] as const

type ProfileWorldKey = typeof PLAYER_PROFILE_FIELDS[number]['world']
type ProfileFallbackKey = typeof PLAYER_PROFILE_FIELDS[number]['fallback']
type PlayerProfile = Pick<PlayerCharacterSnapshot, ProfileWorldKey | ProfileFallbackKey>

export function playerProfileFromDefaults(
  worldValues: Partial<Record<ProfileWorldKey, string>>,
  defaults: Partial<Record<ProfileWorldKey, string>> = worldValues,
): PlayerProfile {
  const profile = {} as PlayerProfile
  for (const field of PLAYER_PROFILE_FIELDS) {
    const fallback = stringValue(defaults[field.world], '')
    profile[field.fallback] = fallback
    profile[field.world] = stringValue(worldValues[field.world], fallback)
  }
  return profile
}

export function normalizeStoredPlayerCharacter(value: PlayerCharacterSnapshot): PlayerCharacterSnapshot {
  const stored = value || {} as PlayerCharacterSnapshot
  const text = (key: keyof PlayerCharacterSnapshot) => typeof stored[key] === 'string' ? stored[key] as string : ''
  const profile = {} as PlayerProfile
  for (const field of PLAYER_PROFILE_FIELDS) {
    const current = text(field.world)
    profile[field.world] = current
    profile[field.fallback] = typeof stored[field.fallback] === 'string' ? stored[field.fallback] as string : current
  }
  return {
    global_character_id: typeof stored.global_character_id === 'number' ? stored.global_character_id : null,
    project_character_id: stored.project_character_id,
    appearance: text('appearance'),
    physique: text('physique'),
    ...profile,
    image_url: text('image_url'),
    adapted: stored.adapted === true,
  }
}

export function adaptPlayerCharacter(character: PlayerCharacterSnapshot, response: string): PlayerCharacterSnapshot {
  const current = normalizeStoredPlayerCharacter(character)
  const result = parseModelObject(response)
  const adapted: PlayerCharacterSnapshot = { ...current, adapted: true }
  for (const field of PLAYER_PROFILE_FIELDS) {
    adapted[field.world] = stringValue(result[field.world], current[field.fallback])
  }
  return adapted
}

export function fallbackPlayerCharacter(character: PlayerCharacterSnapshot): PlayerCharacterSnapshot {
  const current = normalizeStoredPlayerCharacter(character)
  const fallback: PlayerCharacterSnapshot = { ...current, adapted: true }
  for (const field of PLAYER_PROFILE_FIELDS) fallback[field.world] = current[field.fallback]
  return fallback
}

export function portraitFieldsChanged(
  previous: Pick<PlayerCharacterSnapshot, 'appearance' | 'physique' | 'styling'>,
  next: Pick<PlayerCharacterSnapshot, 'appearance' | 'physique' | 'styling'>,
) {
  return previous.appearance !== next.appearance
    || previous.physique !== next.physique
    || previous.styling !== next.styling
}

export function normalizePlayerCharacterField(value: unknown, fallback: string) {
  return stringValue(value, fallback)
}

export function withPlayerCharacterGuidance(guidance: string, character: PlayerCharacterSnapshot) {
  const current = normalizeStoredPlayerCharacter(character)
  const marker = '【玩家主角设定】'
  const base = guidance.split(marker)[0].trim()
  return [
    base,
    marker,
    ...PLAYER_PROFILE_FIELDS.map(field => `${field.guidance}：${current[field.world]}`),
    `固定外貌：${current.appearance}`,
    `固定身材：${current.physique}`,
    '始终保持脸部外貌和身材与固定设定一致。姓名、身份和生活细节使用本世界版本。行为体现本世界性格、价值观、习惯、愿望、恐惧、关系和经历。画面造型使用本世界服装。',
  ].filter(Boolean).join('\n')
}

function parseModelObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('主角适配没有返回 JSON')
  const parsed = JSON.parse(cleaned.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('主角适配结果无效')
  return parsed as Record<string, unknown>
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.trim().slice(0, 4000) : fallback
}
```

- [ ] **Step 4: 确认测试通过**

Run: `cd backend && node --import tsx --test tests/rpg-player-character.test.ts`

Expected: PASS，5 个测试都通过。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/rpg/player-character.ts backend/tests/rpg-player-character.test.ts
git commit -m "$(cat <<'EOF'
让主角适配改写除脸和身材以外的生活细节。

EOF
)"
```

## Task 2: 草稿生成

**Files:**
- Modify: `backend/src/services/global-character.ts`
- Test: `backend/tests/global-character.test.ts`

- [ ] **Step 1: 扩展草稿测试**

把 `backend/tests/global-character.test.ts` 换成下面的完整文件：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fallbackWorldPlayerCharacterDraft,
  generateGlobalCharacterDraft,
  generateWorldPlayerCharacterDraft,
} from '../src/services/global-character.ts'

test('global character generation returns an editable draft and bounds fields', async () => {
  let prompt = ''
  const longValue = '值'.repeat(2001)
  const draft = await generateGlobalCharacterDraft('一个会修钟表的年轻侦探', async (value, options) => {
    prompt = value
    assert.equal(options?.timeoutMs, 45_000)
    return JSON.stringify({
      name: '沈知遥',
      role: '钟表匠兼侦探',
      appearance: '银灰色短发',
      physique: '清瘦',
      default_personality: '敏锐而克制',
      default_values: '把真相说完',
      default_speech: '先问再判断',
      default_habits: '随身带一本修理笔记',
      default_desires: longValue,
      default_fears: '看漏一处细小裂痕',
      default_relationships: '记挂店里的老钟表匠',
      default_abilities: '修理钟表和观察痕迹',
      default_background: '在港口学艺十年',
      default_styling: '深绿色短外套',
    })
  })
  assert.match(prompt, /只有外貌和身材跨世界保持原样|固定外貌和固定身材跨世界保持原样/)
  for (const label of ['价值观', '说话方式', '习惯', '愿望', '恐惧', '在乎的人', '能力', '经历']) {
    assert.match(prompt, new RegExp(label))
  }
  assert.equal(draft.name, '沈知遥')
  assert.equal(draft.default_personality, '敏锐而克制')
  assert.equal(draft.default_values, '把真相说完')
  assert.equal(draft.default_speech, '先问再判断')
  assert.equal(draft.default_habits, '随身带一本修理笔记')
  assert.equal(draft.default_desires.length, 2000)
  assert.equal(draft.default_fears, '看漏一处细小裂痕')
  assert.equal(draft.default_relationships, '记挂店里的老钟表匠')
  assert.equal(draft.default_abilities, '修理钟表和观察痕迹')
  assert.equal(draft.default_background, '在港口学艺十年')
  assert.equal(draft.image_url, null)
})

test('global character generation requires a usable name', async () => {
  await assert.rejects(
    generateGlobalCharacterDraft('角色构想', async () => '{"name":"  "}'),
    /缺少姓名/,
  )
})

test('world character generation uses the world premise and creates a local protagonist draft', async () => {
  let prompt = ''
  const draft = await generateWorldPlayerCharacterDraft({
    title: '雾隐茶寮',
    genre: '悬疑',
    premise: '你是刚回到江城的调查记者。',
  }, async (value, options) => {
    prompt = value
    assert.equal(options?.timeoutMs, 45_000)
    return JSON.stringify({
      name: '林知夏',
      role: '调查记者',
      appearance: '短发，左眉有浅疤',
      physique: '清瘦',
      personality: '警觉而克制',
      values: '把失踪的人找回来',
      speech: '问题比结论多',
      habits: '进门先看窗',
      desires: '查清搭档失踪的原因',
      fears: '再次把人留在身后',
      relationships: '记挂失踪的搭档',
      abilities: '采访和核对时间线',
      background: '三年前搭档失踪后离开江城',
      styling: '深色风衣',
    })
  })
  assert.match(prompt, /雾隐茶寮/)
  assert.match(prompt, /调查记者/)
  assert.match(prompt, /values/)
  assert.match(prompt, /relationships/)
  assert.equal(draft.name, '林知夏')
  assert.equal(draft.values, '把失踪的人找回来')
  assert.equal(draft.speech, '问题比结论多')
  assert.equal(draft.habits, '进门先看窗')
  assert.equal(draft.desires, '查清搭档失踪的原因')
  assert.equal(draft.fears, '再次把人留在身后')
  assert.equal(draft.relationships, '记挂失踪的搭档')
  assert.equal(draft.abilities, '采访和核对时间线')
  assert.equal(draft.background, '三年前搭档失踪后离开江城')
})

test('world character fallback keeps a usable protagonist when text generation is unavailable', () => {
  const draft = fallbackWorldPlayerCharacterDraft({
    title: '边城夜雨',
    genre: '武侠',
    premise: '你是边城驿站的杂役，今夜一辆马车闯进城。',
  })
  assert.equal(draft.name, '旅人')
  assert.equal(draft.role, '边城驿站的杂役')
  assert.equal(draft.background, '你是边城驿站的杂役，今夜一辆马车闯进城。')
  assert.match(draft.styling, /武侠/)
  assert.equal(draft.values, '')
  assert.equal(draft.speech, '')
  assert.equal(draft.habits, '')
  assert.equal(draft.desires, '')
  assert.equal(draft.fears, '')
  assert.equal(draft.relationships, '')
  assert.equal(draft.abilities, '')
})
```

- [ ] **Step 2: 确认测试失败**

Run: `cd backend && node --import tsx --test tests/global-character.test.ts`

Expected: FAIL，草稿对象没有新字段。

- [ ] **Step 3: 返回完整草稿**

`GlobalCharacterDraft` 增加 `default_values`、`default_speech`、`default_habits`、`default_desires`、`default_fears`、`default_relationships`、`default_abilities`、`default_background`。

`WorldPlayerCharacterDraft` 增加 `values`、`speech`、`habits`、`desires`、`fears`、`relationships`、`abilities`。

全局草稿提示改为：

```ts
'根据角色构想，设计一个可在不同世界复用的人。固定外貌和固定身材跨世界保持原样。姓名、身份、性格、价值观、说话方式、习惯、愿望、恐惧、在乎的人、能力、经历和服装是默认值，进入每个世界后会改写。',
`角色构想：${brief}`,
'返回 JSON 对象，字段为 name、role、appearance、physique、default_personality、default_values、default_speech、default_habits、default_desires、default_fears、default_relationships、default_abilities、default_background、default_styling，值均为简体中文字符串。不要返回 Markdown。',
```

用 `textField` 截断：姓名 80，身份 120，其余新增字段和原有长文本 2000。`image_url` 仍是 `null`。姓名为空仍抛出现有错误。

世界草稿提示在现有世界信息后要求 JSON 字段为 `name`、`role`、`appearance`、`physique`、`personality`、`values`、`speech`、`habits`、`desires`、`fears`、`relationships`、`abilities`、`background`、`styling`。每个字段都用 `textField`，上限与全局草稿相同。

`fallbackWorldPlayerCharacterDraft` 为这七个新字段返回空字符串。

- [ ] **Step 4: 确认测试通过**

Run: `cd backend && node --import tsx --test tests/global-character.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/global-character.ts backend/tests/global-character.test.ts
git commit -m "$(cat <<'EOF'
按完整的生活细节生成角色草稿。

EOF
)"
```

## Task 3: 保存默认生活细节

**Files:**
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/db/sqlite-schema.ts`
- Modify: `backend/src/routes/global-characters.ts`
- Test: `backend/tests/rpg-character-integration.test.ts`

- [ ] **Step 1: 写旧库补列测试**

在 `backend/tests/rpg-character-integration.test.ts` 增加：

```ts
test('existing global character rows receive life profile columns', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`CREATE TABLE global_characters (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); INSERT INTO global_characters (id, name, created_at, updated_at) VALUES (1, 'old', 't', 't')`)
    initSqliteSchema(sqlite)
    assert.deepEqual(sqlite.prepare(`SELECT default_values, default_speech, default_habits, default_desires,
      default_fears, default_relationships, default_abilities, default_background
      FROM global_characters WHERE id = 1`).get(), {
      default_values: null,
      default_speech: null,
      default_habits: null,
      default_desires: null,
      default_fears: null,
      default_relationships: null,
      default_abilities: null,
      default_background: null,
    })
  } finally {
    sqlite.close()
  }
})
```

再增加接口往返测试：

```ts
test('global character life defaults round-trip through the library API', async () => {
  const headers = { 'content-type': 'application/json' }
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '沈知遥', role: '钟表匠', appearance: '银灰色短发', physique: '清瘦',
    default_personality: '克制', default_values: '把真相说完', default_speech: '先问再判断',
    default_habits: '随身带笔记', default_desires: '找到委托人', default_fears: '看漏裂痕',
    default_relationships: '记挂老钟表匠', default_abilities: '修理钟表', default_background: '港口学艺十年',
    default_styling: '深绿短外套',
  }) })
  assert.equal(created.status, 201)
  const id = (await created.json() as any).data.id
  const updated = await globalCharacterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({
    default_values: '答应过的事要做到',
  }) })
  assert.equal(updated.status, 200)
  const body = await updated.json() as any
  assert.equal(body.data.default_values, '答应过的事要做到')
  assert.equal(body.data.default_relationships, '记挂老钟表匠')
  assert.equal(body.data.appearance, '银灰色短发')
})
```

- [ ] **Step 2: 确认测试失败**

Run: `cd backend && node --import tsx --test tests/rpg-character-integration.test.ts`

Expected: FAIL，查询新列时报没有该列，或接口不返回 `default_values`。

- [ ] **Step 3: 补列并接收字段**

在 `backend/src/db/schema.ts` 的 `globalCharacters` 中、`defaultPersonality` 后增加：

```ts
defaultValues: text('default_values'),
defaultSpeech: text('default_speech'),
defaultHabits: text('default_habits'),
defaultDesires: text('default_desires'),
defaultFears: text('default_fears'),
defaultRelationships: text('default_relationships'),
defaultAbilities: text('default_abilities'),
defaultBackground: text('default_background'),
```

`characters` 表不加这些列。

在 `backend/src/db/sqlite-schema.ts` 的 `CREATE TABLE global_characters` 里，于 `default_personality TEXT` 后加入同名八个 `TEXT` 列。

在 `initSqliteSchema` 读取 `global_characters` 的 `PRAGMA table_info`。对下面每个列名，表已存在且缺少该列时执行 `ALTER TABLE global_characters ADD COLUMN <name> TEXT`：

`default_values`、`default_speech`、`default_habits`、`default_desires`、`default_fears`、`default_relationships`、`default_abilities`、`default_background`。

`backend/src/routes/global-characters.ts` 的 `editableFields` 增加：

```ts
default_values: 'defaultValues',
default_speech: 'defaultSpeech',
default_habits: 'defaultHabits',
default_desires: 'defaultDesires',
default_fears: 'defaultFears',
default_relationships: 'defaultRelationships',
default_abilities: 'defaultAbilities',
default_background: 'defaultBackground',
```

`POST /` 和 `PUT /:id` 保存前按角色库上限截断：`name` 80 字，`role` 120 字，`appearance`、`physique`、`default_personality`、`default_styling` 和八个新字段都是 2000 字。空值保存为空字符串。不要新增 `reference_images` 输入框或新的写入分支；`reference_images` 仍只随现有图片快照保存。

- [ ] **Step 4: 确认测试通过**

Run: `cd backend && node --import tsx --test tests/rpg-character-integration.test.ts`

Expected: PASS。已有的开局适配图片测试也通过。

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.ts backend/src/db/sqlite-schema.ts backend/src/routes/global-characters.ts backend/tests/rpg-character-integration.test.ts
git commit -m "$(cat <<'EOF'
保存全局角色的默认生活细节。

EOF
)"
```

## Task 4: 开局复制、适配和本局编辑

**Files:**
- Modify: `backend/src/services/rpg/engine.ts`
- Test: `backend/tests/rpg-character-integration.test.ts`

- [ ] **Step 1: 写图片修订和行为测试**

在 `backend/tests/rpg-character-integration.test.ts` 增加三个测试。

第一个：只改生活细节不换脸。

```ts
test('player life edits do not replace the portrait', async () => {
  const session = await createSession({ title: '生活细节不换脸', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/face.png', localPath: '/static/face.png', imageAuto: true, imageRevision: 3 })
    .where(eq(schema.characters.id, id))
  await updateSessionPlayerCharacter(session.id, { personality: '更温和', values: '守信' })
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/face.png')
  assert.equal(character.imageRevision, 3)
  assert.equal((await getSession(session.id))?.player_character?.values, '守信')
  await updateSessionPlayerCharacter(session.id, { styling: '新斗篷' })
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, null)
  assert.equal(character.imageRevision, 4)
})
```

第二个：没有文本模型时，服装未变的开局适配不增加修订号。

```ts
test('opening adaptation keeps the portrait when clothing does not change', async () => {
  const headers = { 'content-type': 'application/json' }
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '林雾', role: '医生', appearance: '短发', physique: '清瘦', default_styling: '深色风衣',
    default_values: '先救人',
  }) })
  const global = (await created.json() as any).data
  const session = await createSession({ title: '服装未变', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: global.id })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/face.png', localPath: '/static/face.png', imageAuto: true, imageRevision: 2 })
    .where(eq(schema.characters.id, id))
  await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /未配置文本模型/)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/face.png')
  assert.equal(character.imageRevision, 2)
  const player = (await getSession(session.id))?.player_character
  assert.equal(player?.values, '先救人')
  assert.equal(player?.appearance, '短发')
  assert.equal(player?.adapted, true)
})
```

第三个：服装默认值和当前服装不同、图片是自动生成时，失败回退会清空图并增加修订号。

```ts
test('opening adaptation replaces an automatic portrait when fallback clothing changes', async () => {
  const headers = { 'content-type': 'application/json' }
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '林雾', default_styling: '深色风衣', appearance: '短发', physique: '清瘦',
  }) })
  const global = (await created.json() as any).data
  const session = await createSession({ title: '服装改变', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: global.id })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  const snapshot = { ...session.player_character, styling: '旧衣服' }
  await db.update(schema.rpgSessions).set({ playerCharacter: JSON.stringify(snapshot) }).where(eq(schema.rpgSessions.id, session.id))
  await db.update(schema.characters).set({ styling: '旧衣服', imageUrl: '/static/auto.png', localPath: '/static/auto.png', imageAuto: true, imageRevision: 1 })
    .where(eq(schema.characters.id, id))
  await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /未配置文本模型/)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.styling, '深色风衣')
  assert.equal(character.imageUrl, null)
  assert.equal(character.imageRevision, 2)
  assert.equal(character.appearance, '短发')
})
```

- [ ] **Step 2: 确认新测试失败**

Run: `cd backend && node --import tsx --test tests/rpg-character-integration.test.ts`

Expected: FAIL。只改性格仍会清空图片，或快照没有 `values`。

- [ ] **Step 3: 接入快照和条件换图**

从 `player-character.ts` 引入 `PLAYER_PROFILE_FIELDS`、`normalizeStoredPlayerCharacter`、`playerProfileFromDefaults`、`portraitFieldsChanged`。`normalizePlayerCharacterField` 已经在这个文件里引入。

`getSession` 和 `loadPlay` 在 `parseJson` 得到主角后立刻调用 `normalizeStoredPlayerCharacter`。

`createGlobalPlayerCharacter` 用全局角色组成 world 键对象：`name`、`role`（空则 `主角`）、`personality` 来自 `defaultPersonality`、`values` 来自 `defaultValues`、其余生活细节来自对应默认列、`background` 来自 `defaultBackground`、`styling` 来自 `defaultStyling`。空值用空字符串。调用 `playerProfileFromDefaults(defaults)`，返回值和插入项目角色都使用这份资料。项目角色只写已有列：`name`、`role`、`description` 仍为外貌、`appearance`、`physique`、`styling`、`personality`、`background`。不把新生活细节写入 `characters`。`adapted` 仍是 `false`。

`createWorldPlayerCharacter` 把草稿里的 `name`、`role`、`personality`、`values`、`speech`、`habits`、`desires`、`fears`、`relationships`、`abilities`、`background`、`styling` 交给 `playerProfileFromDefaults`。同一份值既是默认值也是本世界版本。`adapted` 为 `true`。项目角色同样只写已有列。

`updateSessionPlayerCharacter` 的入参类型为每个档案 world 键加上 `appearance`、`physique`、`description`、`global_character_id`、`generate_default`。已有主角时：

```ts
const current = normalizeStoredPlayerCharacter(loaded.playerCharacter)
const next = normalizeStoredPlayerCharacter({
  ...current,
  ...Object.fromEntries(PLAYER_PROFILE_FIELDS.map(field => [field.world,
    normalizePlayerCharacterField(input[field.world], current[field.world])])),
  appearance: normalizePlayerCharacterField(input.appearance, current.appearance),
  physique: normalizePlayerCharacterField(input.physique, current.physique),
})
const portraitChanged = portraitFieldsChanged({
  appearance: projectCharacter.appearance || '',
  physique: projectCharacter.physique || '',
  styling: projectCharacter.styling || '',
}, next)
const textChanged = portraitChanged || PLAYER_PROFILE_FIELDS.some(field => next[field.world] !== (current[field.world] || ''))
  || (typeof input.description === 'string' && input.description !== (projectCharacter.description || ''))
```

`textChanged` 时把 `next.adapted` 设为 `true`，并调用现有的 `prepareUncommittedOpeningForCharacterChange`。项目角色更新写 `name`、`role`、`appearance`、`physique`、`personality`、`background`、`styling` 和可选 `description`。只有 `portraitChanged` 时才执行现在这段清图逻辑：保存参考图、自动提示词置空、`imageUrl` 和 `localPath` 置空、`imageRevision` 加一。只改生活细节时不进入这段逻辑。不更新 `global_characters`。

`adaptPlayerCharacter` 的模型提示改为：

```ts
'请把一个全局角色改编为当前世界中的主角版本。只改写姓名、身份、性格、价值观、说话方式、习惯、愿望、恐惧、在乎的人、能力、经历和服装。脸部外貌和身材必须保持原文，不要改写。',
`世界名称：${loaded.world.title}`,
`世界类型：${loaded.world.genre || '原创'}`,
`世界设定：${loaded.world.premise}`,
`默认姓名：${character.default_name}`,
`默认身份：${character.default_role}`,
`固定外貌：${character.appearance}`,
`固定身材：${character.physique}`,
`默认性格：${character.default_personality}`,
`默认价值观：${character.default_values}`,
`默认说话方式：${character.default_speech}`,
`默认习惯：${character.default_habits}`,
`默认愿望：${character.default_desires}`,
`默认恐惧：${character.default_fears}`,
`默认在乎的人：${character.default_relationships}`,
`默认能力：${character.default_abilities}`,
`默认经历：${character.default_background}`,
`默认服装：${character.default_styling}`,
'返回 JSON 对象，字段为 name、role、personality、values、speech、habits、desires、fears、relationships、abilities、background、styling，值均为简体中文字符串。不要返回 Markdown。',
```

调用前先 `normalizeStoredPlayerCharacter`。失败时仍用 `fallbackPlayerCharacter`。成功和失败都把适配结果写回会话。项目角色更新为：

```ts
await db.update(schema.characters).set({
  name: adapted.name,
  role: adapted.role,
  personality: adapted.personality,
  background: adapted.background,
  styling: adapted.styling,
  finalPrompt: sql`CASE WHEN ${schema.characters.finalPromptAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN NULL ELSE ${schema.characters.finalPrompt} END`,
  imageUrl: sql`CASE WHEN ${schema.characters.imageAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN NULL ELSE ${schema.characters.imageUrl} END`,
  localPath: sql`CASE WHEN ${schema.characters.imageAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN NULL ELSE ${schema.characters.localPath} END`,
  imageRevision: sql`CASE WHEN ${schema.characters.imageAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN ${schema.characters.imageRevision} + 1 ELSE ${schema.characters.imageRevision} END`,
  updatedAt: ts,
}).where(eq(schema.characters.id, character.project_character_id))
```

不要在这条更新里改 `appearance` 或 `physique`。保留后面的 `scheduleEpisodeAssetImages`。

- [ ] **Step 4: 确认相关测试通过**

Run: `cd backend && node --import tsx --test tests/rpg-character-integration.test.ts tests/rpg-player-character.test.ts tests/rpg-screenplay-integration.test.ts`

Expected: PASS。已有的 `opening adaptation preserves manual prompts` 仍然满足原来的图片地址断言。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/rpg/engine.ts backend/tests/rpg-character-integration.test.ts
git commit -m "$(cat <<'EOF'
开局只改写可变的人物细节，服装未变时保留定妆图。

EOF
)"
```

## Task 5: 角色库和游玩页

**Files:**
- Modify: `frontend/app/pages/characters.vue`
- Modify: `frontend/app/views/rpg/play.vue`
- Test: `frontend/tests/character-life-profile.test.mjs`

- [ ] **Step 1: 写页面文案测试**

创建 `frontend/tests/character-life-profile.test.mjs`：

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const library = readFileSync(new URL('../app/pages/characters.vue', import.meta.url), 'utf8')
const play = readFileSync(new URL('../app/views/rpg/play.vue', import.meta.url), 'utf8')

test('character library separates fixed identity from world-variable defaults', () => {
  assert.match(library, /跨世界不变/)
  assert.match(library, /进入世界后会改变/)
  for (const label of ['默认姓名', '默认身份', '默认性格', '默认价值观', '默认说话方式', '默认习惯', '默认愿望', '默认恐惧', '默认在乎的人', '默认能力', '默认经历', '默认服装']) {
    assert.match(library, new RegExp(label))
  }
  assert.match(library, /随世界变化/)
  assert.equal(library.includes('reference_images'), false)
})

test('play editor shows the world life and marks face and physique as fixed', () => {
  assert.match(play, /固定外貌<span class="change-tag">跨世界不变<\/span>/)
  assert.match(play, /固定身材<span class="change-tag">跨世界不变<\/span>/)
  for (const label of ['本世界姓名', '本世界身份', '本世界性格', '本世界价值观', '本世界说话方式', '本世界习惯', '本世界愿望', '本世界恐惧', '本世界在乎的人', '本世界能力', '本世界经历', '本世界服装与妆造']) {
    assert.match(play, new RegExp(label))
  }
})
```

- [ ] **Step 2: 确认测试失败**

Run: `cd frontend && node --test tests/character-life-profile.test.mjs`

Expected: FAIL，角色库还没有「默认价值观」。

- [ ] **Step 3: 更新两个页面**

`characters.vue` 的页首说明改为：`保存这个人的固定外貌、身材，以及进入不同世界后会改写的默认生活。`

把现在的 `editor-grid` 分成两段。第一段标题 `跨世界不变`，说明 `脸、身材和参考形象进入任何世界都保持原样。`，保留固定外貌、固定身材和参考形象地址。不增加 `reference_images` 输入框。

第二段标题 `进入世界后会改变`，说明 `这些是默认值，进入不同世界后会单独改写。` 用一份字段表渲染十二项，每一项的标签旁都有文字 `随世界变化`：

```ts
const variableProfileFields = [
  { key: 'name', label: '默认姓名', max: 80, short: true, placeholder: '角色姓名' },
  { key: 'role', label: '默认身份', max: 120, short: true, placeholder: '例如：调查记者' },
  { key: 'default_personality', label: '默认性格', max: 2000, placeholder: '处事方式和性格倾向' },
  { key: 'default_values', label: '默认价值观', max: 2000, placeholder: '这个人坚持或反对什么' },
  { key: 'default_speech', label: '默认说话方式', max: 2000, placeholder: '用词、语气、说与不说的习惯' },
  { key: 'default_habits', label: '默认习惯', max: 2000, placeholder: '日常动作、癖好和行事惯例' },
  { key: 'default_desires', label: '默认愿望', max: 2000, placeholder: '长期想得到或想完成的事' },
  { key: 'default_fears', label: '默认恐惧', max: 2000, placeholder: '害怕失去、面对或再次发生的事' },
  { key: 'default_relationships', label: '默认在乎的人', max: 2000, placeholder: '放不下的人，以及彼此的关系' },
  { key: 'default_abilities', label: '默认能力', max: 2000, placeholder: '擅长、不擅长和赖以生活的本事' },
  { key: 'default_background', label: '默认经历', max: 2000, placeholder: '形成这个人的经历' },
  { key: 'default_styling', label: '默认服装', max: 2000, placeholder: '作为跨世界适配起点的发型、服装和配饰' },
] as const
```

短字段用 `input`，其余用 `textarea`。`draft`、`startNew`、`edit`、保存 payload 和生成草稿赋值都包含这些键。`GlobalCharacter` 类型也包含它们。生成结果缺字段时用空字符串。姓名仍是唯一必填项。

增加样式：

```css
.profile-group { display: grid; gap: 14px; padding-top: 18px; }
.profile-group h3 { margin: 0; font-size: 15px; }
.field-note { margin: 0; color: var(--text-2); font-size: 13px; font-weight: 400; line-height: 1.6; }
.change-tag { margin-left: 8px; color: var(--text-3); font-size: 12px; font-weight: 400; }
```

两组内部继续使用现有 `.editor-grid`。

`play.vue` 的本局主角摘要下面，按非空值展示：本世界性格、价值观、说话方式、习惯、愿望、恐惧、在乎的人、能力、经历、服装。固定外貌和固定身材另两行，标签为 `固定外貌`、`固定身材`，旁边文本是 `跨世界不变`。

编辑弹窗包含本世界十二项，服装标签写为 `本世界服装与妆造`。每项 `maxlength` 4000；姓名和身份用单行输入，姓名 80、身份 120。固定外貌和固定身材的标签写成 `<span>固定外貌<span class="change-tag">跨世界不变</span></span>` 与 `<span>固定身材<span class="change-tag">跨世界不变</span></span>`。`playerCharacterDraft`、`openCharacterEditor` 和保存请求携带这些键，以及 `appearance`、`physique`。

弹窗底部说明改为：`修改会用于后续章节。修改外貌、身材或服装会重新生成角色定妆图。`

剧情人物编辑弹窗不增加这些生活细节。

- [ ] **Step 4: 确认页面测试通过**

Run: `cd frontend && node --test tests/character-life-profile.test.mjs tests/global-character-library.test.mjs tests/global-character-media.test.mjs`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/app/pages/characters.vue frontend/app/views/rpg/play.vue frontend/tests/character-life-profile.test.mjs
git commit -m "$(cat <<'EOF'
在角色库和本局主角里呈现完整的生活细节。

EOF
)"
```

## Task 6: 汇总验证

- [ ] **Step 1: 运行受影响的测试**

Run:

```bash
cd backend && node --import tsx --test tests/rpg-player-character.test.ts tests/global-character.test.ts tests/rpg-character-integration.test.ts tests/rpg-screenplay-integration.test.ts tests/rpg-turn.test.ts
cd frontend && node --test tests/character-life-profile.test.mjs tests/global-character-library.test.mjs tests/global-character-media.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 2: 类型检查**

Run: `cd backend && npm run typecheck`

Expected: 退出码 0。

## Spec coverage

- 两组字段和字数限制：Task 1、Task 2、Task 5。
- 旧全局角色新列为空，旧快照仍可读取：Task 1 的归一化，Task 3 的补列。
- 八个新列只在 `global_characters`：Task 3。
- 新生活细节不进 `characters` 和制作台：Task 4 只写已有列，Task 5 不改 `episode.vue`。
- 开局改写可变项，缺字段或失败时用默认值：Task 1 和 Task 4。
- 按世界生成的主角不再二次适配：Task 4 保持 `adapted: true`。
- 手动保存后不再自动适配：Task 4 继续在 `adapted` 已为 true 时跳过，生活细节修改会把 `adapted` 设为 true。
- 正文要求：Task 1。
- 定妆图规则：Task 1 的判断和 Task 4 的写回。
- 本局修改脸和身材不回写角色库：Task 4 明确不更新 `global_characters`。
- 角色库与游玩页文案：Task 5。
