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
