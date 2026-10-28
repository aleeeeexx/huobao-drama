import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/views/rpg/play.vue', import.meta.url), 'utf8')
const template = page.slice(0, page.indexOf('<script'))
const script = page.slice(page.indexOf('<script'), page.indexOf('<style'))
const live = template.match(/<article v-if="acting" class="turn live"[^>]*>[\s\S]*?<\/article>/)
const finished = template.match(/<article v-for="turn in session\?\.turns \|\| \[\]"[\s\S]*?<\/article>/)
const reveal = script.match(/function showPersistedSession\(nextSession: any\) \{[\s\S]*?\n\}/)

test('续写和开场生成时只显示书写状态，不把流式草稿画进叙事', () => {
  assert.ok(live, 'live turn')
  assert.match(live[0], /aria-busy="true"/)
  assert.match(live[0], /role="status"/)
  assert.match(live[0], /正在书写这一幕…/)
  assert.match(live[0], /v-if="pendingAction"/)
  assert.doesNotMatch(live[0], /\{\{\s*draft\s*\}\}/)
  assert.doesNotMatch(live[0], /class="narrative"/)
  assert.doesNotMatch(live[0], /event\.data\.text|turn\.narrative/)

  assert.ok(finished, 'finished turn')
  assert.match(finished[0], /<p class="narrative">\{\{ turn\.narrative \}\}<\/p>/)

  assert.match(template, /v-for="choice in choices"/)
  assert.match(template, /:disabled="acting"/)
  assert.match(template, /v-if="loading && !acting && !\(session\?\.turns \|\| \[\]\)\.length"/)

  assert.doesNotMatch(script, /draft/)
  assert.doesNotMatch(script, /event\.event === 'delta'/)
  assert.doesNotMatch(script, /event\.data\.text/)
  assert.match(script, /if \(event\.event === 'error'\)/)
  assert.match(script, /response\.body\.getReader\(\)/)
  assert.match(script, /shareOpening\(sessionId\.value, \(\) => act\(\{ mode: 'opening' \}\)\)/)
})

test('落库回合和生成状态在同一次赋值里切换，中间不再清空草稿', () => {
  assert.ok(reveal, 'showPersistedSession')
  assert.doesNotMatch(reveal[0], /await/)
  const sessionAt = reveal[0].indexOf('session.value = nextSession')
  const actingAt = reveal[0].indexOf('acting.value = false')
  assert.ok(sessionAt >= 0 && actingAt > sessionAt)

  const handoffs = [...script.matchAll(/const nextSession = await rpgAPI\.session\(sessionId\.value\)\n([\s\S]*?)showPersistedSession\(nextSession\)/g)]
  assert.equal(handoffs.length, 2)
  for (const handoff of handoffs) assert.doesNotMatch(handoff[1], /await/)

  const success = script.slice(script.indexOf('if (failure) throw new Error(failure)'), script.indexOf('} catch (error)'))
  assert.match(success, /showPersistedSession\(nextSession\)/)
  assert.doesNotMatch(success, /draft\.value\s*=\s*''/)
  const revealedAt = success.indexOf('showPersistedSession(nextSession)')
  const scrolledAt = success.indexOf('await scrollLog()')
  assert.ok(revealedAt >= 0 && scrolledAt > revealedAt)
  assert.doesNotMatch(script, /finally\s*\{[^}]*acting\.value = false/)
})
