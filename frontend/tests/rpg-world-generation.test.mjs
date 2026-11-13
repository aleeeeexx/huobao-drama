import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import { reactive, ref } from 'vue'
import ts from 'typescript'

const component = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8')
const script = parse(component).descriptor.scriptSetup.content
const source = ts.createSourceFile('index.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const code = ts.transpileModule(source.statements
  .filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const draft = { title: '记忆之城', genre: '奇幻', tagline: '记忆是唯一的货币', premise: '你来到只能用记忆交易的城市，寻找突然失踪的姐姐。' }

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function createLobby() {
  const generated = deferred()
  const started = deferred()
  const concepts = [], sessions = [], navigation = [], errors = []
  const context = {
    reactive, ref, onMounted() {},
    navigateTo: async path => { navigation.push(path) },
    toastError: error => errors.push(error),
    rpgAPI: {
      generateWorld: concept => { concepts.push(concept); return generated.promise },
      createSession: data => { sessions.push({ ...data }); return started.promise },
    },
  }
  vm.runInNewContext(`${code}\nObject.assign(globalThis, { custom, worldConcept, generatingWorld, starting, selectedCharacterId, generateWorld, enterCustom, enterWorld })`, context)
  return { ui: context, generated, started, concepts, sessions, navigation, errors }
}

test('generation populates an editable draft without starting a session or consuming the chosen protagonist', async () => {
  const { ui, generated, concepts, sessions, navigation } = createLobby()
  ui.worldConcept.value = '  在记忆之城寻找姐姐  '
  ui.selectedCharacterId.value = 5
  const generation = ui.generateWorld()
  assert.equal(ui.generatingWorld.value, true)
  generated.resolve(draft)
  await generation
  assert.deepEqual({ ...ui.custom }, draft)
  assert.equal(ui.worldConcept.value, '  在记忆之城寻找姐姐  ')
  assert.equal(ui.selectedCharacterId.value, 5)
  assert.equal(ui.generatingWorld.value, false)
  assert.deepEqual(concepts, ['在记忆之城寻找姐姐'])
  assert.deepEqual(sessions, [])
  assert.deepEqual(navigation, [])
})

test('starting after generation sends all edited fields and the selected global protagonist', async () => {
  const { ui, generated, started, sessions, navigation } = createLobby()
  ui.worldConcept.value = '记忆之城'
  generated.resolve(draft)
  await ui.generateWorld()
  Object.assign(ui.custom, { title: '明日之城', genre: '悬疑', tagline: '明天将被遗忘', premise: '你在记忆商人的店里找到了姐姐的线索，收据上的日期却在明天。' })
  ui.selectedCharacterId.value = 5
  started.resolve({ id: 42 })
  await ui.enterCustom()
  assert.deepEqual(sessions, [{ ...ui.custom, global_character_id: 5 }])
  assert.deepEqual(navigation, ['/play/42'])
  assert.equal(ui.starting.value, false)
})

test('regeneration replaces the draft only after the new result succeeds', async () => {
  const { ui, generated } = createLobby()
  Object.assign(ui.custom, draft)
  ui.worldConcept.value = '在深海邮局送信'
  const generation = ui.generateWorld()
  assert.deepEqual({ ...ui.custom }, draft)
  const replacement = { title: '深海邮局', genre: '奇谈', tagline: '每封信都来自海底', premise: '你是深海邮局的一位邮差，今夜收到一封寄给自己的旧信。' }
  generated.resolve(replacement)
  await generation
  assert.deepEqual({ ...ui.custom }, replacement)
})

test('generation failure preserves the concept and draft and allows retry', async () => {
  const { ui, generated, concepts, errors } = createLobby()
  Object.assign(ui.custom, draft)
  ui.worldConcept.value = '原来的创意'
  const generation = ui.generateWorld()
  const failure = new Error('模型服务暂时连不上，请再试一次')
  generated.reject(failure)
  await generation
  assert.equal(ui.generatingWorld.value, false)
  assert.deepEqual({ ...ui.custom }, draft)
  assert.equal(ui.worldConcept.value, '原来的创意')
  assert.deepEqual(errors, [failure])
  ui.rpgAPI.generateWorld = async concept => { concepts.push(concept); return draft }
  await ui.generateWorld()
  assert.equal(concepts.length, 2)
})

test('generation blocks duplicate requests and both world start paths until it completes', async () => {
  const { ui, generated, concepts, sessions } = createLobby()
  ui.worldConcept.value = '一个创意'
  const generation = ui.generateWorld()
  await ui.generateWorld()
  await ui.enterCustom()
  await ui.enterWorld({ id: 7 })
  assert.equal(concepts.length, 1)
  assert.deepEqual(sessions, [])
  generated.resolve(draft)
  await generation
})

test('manual and preset starts still work and prevent generation or duplicate starts while pending', async () => {
  for (const preset of [false, true]) {
    const { ui, started, sessions, concepts, navigation } = createLobby()
    Object.assign(ui.custom, { ...draft, genre: '', tagline: '' })
    ui.worldConcept.value = '另一个创意'
    ui.selectedCharacterId.value = 9
    const starting = preset ? ui.enterWorld({ id: 7 }) : ui.enterCustom()
    assert.equal(ui.starting.value, true)
    await ui.generateWorld()
    await ui.enterWorld({ id: 8 })
    await ui.enterCustom()
    assert.equal(sessions.length, 1)
    assert.deepEqual(concepts, [])
    if (preset) {
      assert.deepEqual(sessions[0], { world_id: 7, global_character_id: 9 })
    } else {
      assert.deepEqual(sessions[0], { ...draft, genre: '原创', tagline: '', global_character_id: 9 })
    }
    started.resolve({ id: 23 })
    await starting
    assert.deepEqual(navigation, ['/play/23'])
    assert.equal(ui.starting.value, false)
  }
})

test('an empty concept does not call the generation API', async () => {
  const { ui, concepts } = createLobby()
  ui.worldConcept.value = '  '
  await ui.generateWorld()
  assert.deepEqual(concepts, [])
  assert.equal(ui.generatingWorld.value, false)
})
