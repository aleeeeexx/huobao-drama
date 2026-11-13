import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import { computed, reactive, ref } from 'vue'
import ts from 'typescript'

const component = readFileSync(new URL('../app/pages/characters.vue', import.meta.url), 'utf8')
const script = parse(component).descriptor.scriptSetup.content
const source = ts.createSourceFile('characters.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const code = ts.transpileModule(source.statements
  .filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function createLibrary() {
  let unmount = () => {}
  let resolve, reject
  const response = new Promise((done, fail) => { resolve = done; reject = fail })
  const deletedIds = []
  const savedRequests = []
  const imageRequests = []
  const imageStyles = []
  let generatedImageUrl = ''
  let generatedCharacterId = 0
  const messages = []
  const warnings = []
  const openedImages = []
  const errors = []
  const context = {
    computed, reactive, ref, onMounted() {}, onBeforeUnmount: callback => { unmount = callback },
    window: { confirm: () => true, open: (...args) => openedImages.push(args) },
    publicMediaUrl: url => url?.startsWith('static/') ? `/${url}` : url || '',
    setTimeout: callback => { callback(); return 0 },
    clearTimeout() {},
    stylePresetAPI: { list: async () => [{ name: '真人电影', value: 'live-action' }, { name: '动漫', value: 'anime' }] },
    globalCharacterAPI: {
      delete: async id => { deletedIds.push(id); await response },
      update: async (id, payload) => { savedRequests.push({ id, payload }); return response },
      create: async payload => { savedRequests.push({ payload }); const saved = await response; context.characters.value.push(saved); return saved },
      generateImage: async (id, style) => { imageRequests.push(id); imageStyles.push(style); generatedCharacterId = id; generatedImageUrl = '/static/generated.png'; return { image_generation_id: 42 } },
      list: async () => context.characters.value.map(character => character.id === generatedCharacterId && generatedImageUrl
        ? { ...character, image_url: generatedImageUrl }
        : character),
    },
    taskAPI: { get: async id => ({ id, status: 'completed', localPath: 'static/generated.png' }) },
    toast: { success: message => messages.push(message), warning: (message, options) => warnings.push({ message, options }) },
    toastError: error => errors.push(error),
  }
  vm.runInNewContext(`${code}\nObject.assign(globalThis, { characters, draft, saving, generatingImage, imageGenerationStage, generationBrief, stylePresets, imageStyle, stylesLoading, styleLoadError, canGenerateImage, loadStyles, startNew, edit, save, remove, generatePortrait, generate })`, context)
  context.stylePresets.value = [{ name: '真人电影', value: 'live-action' }, { name: '动漫', value: 'anime' }]
  context.imageStyle.value = 'live-action'
  context.stylesLoading.value = false
  context.characters.value = [{ id: 1, name: '角色 A' }, { id: 2, name: '角色 B' }]
  context.edit(context.characters.value[0])
  return { ui: context, deletedIds, savedRequests, imageRequests, imageStyles, errors, messages, warnings, openedImages, resolve, reject, unmount: () => unmount() }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('styles load from the shared presets and default to the first enabled preset', async () => {
  const { ui } = createLibrary()
  ui.imageStyle.value = ''
  await ui.loadStyles()
  assert.equal(ui.imageStyle.value, 'live-action')
  assert.equal(ui.canGenerateImage.value, true)
  ui.imageStyle.value = 'anime'
  await ui.loadStyles()
  assert.equal(ui.imageStyle.value, 'anime')
})

test('loading, unavailable, and failed styles prevent saving or submitting a portrait', async () => {
  const { ui, imageRequests, savedRequests } = createLibrary()
  ui.stylesLoading.value = true
  await ui.generatePortrait()
  assert.equal(ui.canGenerateImage.value, false)
  ui.stylePresetAPI.list = async () => []
  await ui.loadStyles()
  assert.equal(ui.imageStyle.value, '')
  assert.equal(ui.canGenerateImage.value, false)
  await ui.generatePortrait()
  ui.stylePresetAPI.list = async () => { throw new Error('服务不可用') }
  await ui.loadStyles()
  assert.match(ui.styleLoadError.value, /加载失败/)
  assert.equal(ui.stylesLoading.value, false)
  assert.equal(ui.canGenerateImage.value, false)
  await ui.generatePortrait()
  assert.deepEqual(imageRequests, [])
  assert.deepEqual(savedRequests, [])
})

test('generation keeps the chosen style through saving and displays prompt preparation before polling', async () => {
  const { ui, imageStyles, resolve } = createLibrary()
  const preparation = deferred()
  const submitted = deferred()
  const polling = deferred()
  const completed = deferred()
  const generateImage = ui.globalCharacterAPI.generateImage
  ui.globalCharacterAPI.generateImage = async (...args) => {
    submitted.resolve()
    await preparation.promise
    return generateImage(...args)
  }
  ui.taskAPI.get = async () => { polling.resolve(); return completed.promise }
  ui.imageStyle.value = 'anime'
  const generation = ui.generatePortrait()
  assert.match(ui.imageGenerationStage.value, /保存角色资料/)
  ui.imageStyle.value = 'live-action'
  resolve({ id: 1, name: '角色 A' })
  await submitted.promise
  assert.match(ui.imageGenerationStage.value, /准备参考图提示词/)
  assert.equal(ui.generatingImage.value, true)
  preparation.resolve()
  await polling.promise
  assert.deepEqual(imageStyles, ['anime'])
  assert.match(ui.imageGenerationStage.value, /参考图生成中/)
  completed.resolve({ status: 'completed', localPath: 'static/generated.png' })
  await generation
  assert.equal(ui.generatingImage.value, false)
  assert.equal(ui.imageGenerationStage.value, '')
})

test('a rejected generation request preserves the image and releases the generation state', async () => {
  const { ui, errors, resolve } = createLibrary()
  ui.edit({ id: 1, name: '角色 A', image_url: '/static/old.png' })
  ui.globalCharacterAPI.generateImage = async () => { throw new Error('所选视觉风格不存在或已停用，请重新选择') }
  const generation = ui.generatePortrait()
  resolve({ id: 1, name: '角色 A', image_url: '/static/old.png' })
  await generation
  assert.equal(ui.draft.image_url, '/static/old.png')
  assert.match(errors[0]?.message, /视觉风格/)
  assert.equal(ui.generatingImage.value, false)
  assert.equal(ui.imageGenerationStage.value, '')
})

test('saving a character preserves another character selected during the request', async () => {
  const { ui, savedRequests, resolve } = createLibrary()
  const saving = ui.save()
  ui.edit(ui.characters.value[1])
  ui.draft.role = '角色 B 尚未保存的身份'
  resolve({ id: 1, name: '角色 A', role: '已保存的身份' })
  await saving
  assert.equal(savedRequests[0].id, 1)
  assert.equal(ui.draft.id, 2)
  assert.equal(ui.draft.role, '角色 B 尚未保存的身份')
  assert.equal(ui.saving.value, false)
})

test('saving a character preserves further edits to the same draft', async () => {
  const { ui, savedRequests, resolve } = createLibrary()
  ui.draft.role = '提交的身份'
  const saving = ui.save()
  ui.draft.role = '提交之后继续编辑的身份'
  resolve({ id: 1, name: '角色 A', role: '提交的身份' })
  await saving
  assert.equal(savedRequests[0].payload.role, '提交的身份')
  assert.equal(ui.draft.id, 1)
  assert.equal(ui.draft.role, '提交之后继续编辑的身份')
})

test('creating a character keeps its new id without discarding further edits', async () => {
  const { ui, savedRequests, resolve } = createLibrary()
  ui.startNew()
  ui.draft.name = '新角色'
  const saving = ui.save()
  ui.draft.role = '提交之后继续编辑的身份'
  resolve({ id: 3, name: '新角色' })
  await saving
  assert.equal(ui.draft.id, 3)
  assert.equal(ui.draft.role, '提交之后继续编辑的身份')
  await ui.save()
  assert.equal(savedRequests[1].id, 3)
})

test('a create response preserves another new draft opened during the request', async () => {
  const { ui, resolve } = createLibrary()
  ui.startNew()
  ui.draft.name = '提交的新角色'
  const saving = ui.save()
  ui.startNew()
  ui.draft.name = '另一份未保存的角色'
  resolve({ id: 3, name: '提交的新角色' })
  await saving
  assert.equal(ui.draft.id, 0)
  assert.equal(ui.draft.name, '另一份未保存的角色')
})

test('an unchanged draft accepts the saved character returned by the server', async () => {
  const { ui, resolve } = createLibrary()
  const saving = ui.save()
  resolve({ id: 1, name: '角色 A', role: '服务端返回的身份' })
  await saving
  assert.equal(ui.draft.id, 1)
  assert.equal(ui.draft.role, '服务端返回的身份')
})

test('saving a stale profile after returning to the page preserves the background portrait', async () => {
  for (const previousImage of [null, '/static/old.png']) {
    const { ui } = createLibrary()
    let stored = { id: 1, name: '角色 A', image_url: previousImage }
    const requests = []
    ui.edit(stored)
    ui.globalCharacterAPI.update = async (id, payload) => {
      requests.push(payload)
      stored = { ...stored, ...payload }
      return { ...stored }
    }
    ui.globalCharacterAPI.list = async () => [{ ...stored }]
    stored.image_url = '/static/background.png'
    ui.draft.role = '只修改身份'
    await ui.save()
    assert.equal(Object.hasOwn(requests[0], 'image_url'), false)
    assert.equal(stored.image_url, '/static/background.png')
    assert.equal(ui.draft.image_url, '/static/background.png')
    ui.draft.role = '再次修改身份'
    await ui.save()
    assert.equal(Object.hasOwn(requests[1], 'image_url'), false)
    assert.equal(stored.image_url, '/static/background.png')
  }
})

test('profile edits made during a save preserve the new server image and advance its baseline', async () => {
  const { ui, savedRequests, resolve } = createLibrary()
  ui.edit({ id: 1, name: '角色 A', image_url: '/static/old.png' })
  const saving = ui.save()
  ui.draft.role = '保存期间继续修改的身份'
  resolve({ id: 1, name: '角色 A', image_url: '/static/background.png' })
  await saving
  assert.equal(ui.draft.role, '保存期间继续修改的身份')
  assert.equal(ui.draft.image_url, '/static/background.png')
  await ui.save()
  assert.equal(Object.hasOwn(savedRequests[1].payload, 'image_url'), false)
})

test('manual image replacement and clearing are saved once and retained as the new baseline', async () => {
  for (const manualImage of ['/static/manual.png', '']) {
    const { ui } = createLibrary()
    let stored = { id: 1, name: '角色 A', image_url: '/static/old.png' }
    const requests = []
    ui.edit(stored)
    ui.globalCharacterAPI.update = async (id, payload) => {
      requests.push(payload)
      stored = { ...stored, ...payload }
      return { ...stored }
    }
    ui.globalCharacterAPI.list = async () => [{ ...stored }]
    ui.draft.image_url = manualImage
    await ui.save()
    assert.equal(requests[0].image_url, manualImage || null)
    assert.equal(stored.image_url, manualImage || null)
    ui.draft.role = '修改身份'
    await ui.save()
    assert.equal(Object.hasOwn(requests[1], 'image_url'), false)
    assert.equal(ui.draft.image_url, manualImage)
  }
})

test('deleting a character preserves another character selected during the request', async () => {
  const { ui, deletedIds, resolve } = createLibrary()
  const removing = ui.remove()
  assert.equal(ui.saving.value, true)
  ui.edit(ui.characters.value[1])
  ui.draft.role = '尚未保存的身份'
  resolve()
  await removing
  assert.deepEqual(deletedIds, [1])
  assert.deepEqual(Array.from(ui.characters.value, character => character.id), [2])
  assert.equal(ui.draft.id, 2)
  assert.equal(ui.draft.role, '尚未保存的身份')
  assert.equal(ui.saving.value, false)
})

test('deleting the selected character clears its editor', async () => {
  const { ui, resolve } = createLibrary()
  const removing = ui.remove()
  resolve()
  await removing
  assert.deepEqual(Array.from(ui.characters.value, character => character.id), [2])
  assert.equal(ui.draft.id, 0)
  assert.equal(ui.draft.name, '')
  assert.equal(ui.saving.value, false)
})

test('a failed deletion preserves the roster and the current draft', async () => {
  const { ui, errors, reject } = createLibrary()
  const removing = ui.remove()
  ui.edit(ui.characters.value[1])
  ui.draft.name = '尚未保存的姓名'
  const error = new Error('删除请求失败')
  reject(error)
  await removing
  assert.deepEqual(Array.from(ui.characters.value, character => character.id), [1, 2])
  assert.equal(ui.draft.id, 2)
  assert.equal(ui.draft.name, '尚未保存的姓名')
  assert.deepEqual(errors, [error])
  assert.equal(ui.saving.value, false)
})

test('generating a portrait saves the current draft and updates its preview after the task completes', async () => {
  const { ui, savedRequests, imageRequests, resolve, messages, warnings } = createLibrary()
  ui.draft.appearance = '银灰短发'
  const generation = ui.generatePortrait()
  resolve({ id: 1, name: '角色 A', appearance: '银灰短发' })
  await generation
  assert.equal(savedRequests.length, 1)
  assert.equal(savedRequests[0].payload.appearance, '银灰短发')
  assert.deepEqual(imageRequests, [1])
  assert.equal(ui.draft.image_url, '/static/generated.png')
  assert.equal(ui.generatingImage.value, false)
  assert.equal(messages.includes('角色参考图已生成，可在后续世界中复用'), true)
  assert.deepEqual(warnings, [])
  ui.draft.role = '生成后只修改身份'
  await ui.save()
  assert.equal(Object.hasOwn(savedRequests[1].payload, 'image_url'), false)
})

test('a new character can generate a portrait after being saved', async () => {
  const { ui, imageRequests, resolve } = createLibrary()
  ui.startNew()
  ui.draft.name = '新角色'
  const generation = ui.generatePortrait()
  resolve({ id: 3, name: '新角色' })
  await generation
  assert.deepEqual(imageRequests, [3])
  assert.equal(ui.draft.id, 3)
  assert.equal(ui.draft.image_url, '/static/generated.png')
})

test('portrait completion preserves image and profile edits made while waiting', async () => {
  const { ui, resolve } = createLibrary()
  const started = deferred()
  const result = deferred()
  ui.taskAPI.get = async () => { started.resolve(); return result.promise }
  const generation = ui.generatePortrait()
  resolve({ id: 1, name: '角色 A' })
  await started.promise
  ui.draft.image_url = '/static/manual.png'
  ui.draft.role = '尚未保存的新身份'
  result.resolve({ status: 'completed', localPath: 'static/generated.png' })
  await generation
  assert.equal(ui.draft.image_url, '/static/manual.png')
  assert.equal(ui.draft.role, '尚未保存的新身份')
})

test('an unapplied portrait reports the changed or deleted character and offers the generated image', async () => {
  for (const remainingCharacter of [
    { id: 1, name: '角色 A', appearance: '新的外貌', image_url: null },
    { id: 1, name: '角色 A', image_url: '/static/old.png' },
    { id: 1, name: '角色 A', image_url: '/static/manual.png' },
    null,
  ]) {
    const { ui, resolve, messages, warnings, openedImages, errors } = createLibrary()
    ui.edit({ id: 1, name: '角色 A', image_url: '/static/old.png' })
    const started = deferred()
    const result = deferred()
    ui.taskAPI.get = async () => { started.resolve(); return result.promise }
    const generation = ui.generatePortrait()
    resolve({ id: 1, name: '角色 A', image_url: '/static/old.png' })
    await started.promise
    ui.globalCharacterAPI.list = async () => remainingCharacter ? [{ ...remainingCharacter }] : []
    result.resolve({ status: 'completed', localPath: 'static/generated.png' })
    await generation
    assert.equal(messages.includes('角色参考图已生成，可在后续世界中复用'), false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, remainingCharacter ? /未应用/ : /已删除/)
    assert.equal(warnings[0].options.action.label, '查看生成图')
    warnings[0].options.action.onClick()
    assert.deepEqual(openedImages, [['/static/generated.png', '_blank', 'noopener,noreferrer']])
    if (remainingCharacter) assert.equal(ui.draft.image_url, remainingCharacter.image_url || '')
    assert.equal(ui.generatingImage.value, false)
    assert.deepEqual(errors, [])
  }
})

test('portrait generation blocks draft generation and duplicate image submissions', async () => {
  const { ui, imageRequests, resolve, errors } = createLibrary()
  ui.generationBrief.value = '另一个角色'
  const generation = ui.generatePortrait()
  await ui.generate()
  await ui.generatePortrait()
  resolve({ id: 1, name: '角色 A' })
  await generation
  assert.deepEqual(imageRequests, [1])
  assert.deepEqual(errors, [])
})

test('a failed portrait task preserves the previous image and reports its error', async () => {
  const { ui, resolve, errors } = createLibrary()
  ui.draft.image_url = '/static/old.png'
  ui.taskAPI.get = async () => ({ status: 'failed', errorMsg: '图片服务不可用' })
  const generation = ui.generatePortrait()
  resolve({ id: 1, name: '角色 A', image_url: '/static/old.png' })
  await generation
  assert.equal(ui.draft.image_url, '/static/old.png')
  assert.equal(errors[0]?.message, '图片服务不可用')
  assert.equal(ui.generatingImage.value, false)
})

test('leaving the page cancels the polling timer and prevents further task requests', async () => {
  const { ui, resolve, unmount, errors, messages } = createLibrary()
  const scheduled = deferred()
  const cleared = []
  let requests = 0
  ui.taskAPI.get = async () => { requests++; return { status: 'processing' } }
  ui.setTimeout = () => { scheduled.resolve(); return 73 }
  ui.clearTimeout = id => cleared.push(id)
  const generation = ui.generatePortrait()
  resolve({ id: 1, name: '角色 A' })
  await scheduled.promise
  const previousMessages = messages.length
  unmount()
  await generation
  assert.deepEqual(cleared, [73])
  assert.equal(requests, 1)
  assert.equal(messages.length, previousMessages)
  assert.deepEqual(errors, [])
})

test('leaving the page while saving prevents a new image task from being submitted', async () => {
  const { ui, resolve, unmount, imageRequests, messages } = createLibrary()
  const generation = ui.generatePortrait()
  unmount()
  resolve({ id: 1, name: '角色 A' })
  await generation
  assert.deepEqual(imageRequests, [])
  assert.deepEqual(messages, [])
})
