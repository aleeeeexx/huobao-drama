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
  let resolve, reject
  const response = new Promise((done, fail) => { resolve = done; reject = fail })
  const deletedIds = []
  const savedRequests = []
  const errors = []
  const context = {
    computed, reactive, ref, onMounted() {},
    window: { confirm: () => true },
    globalCharacterAPI: {
      delete: async id => { deletedIds.push(id); await response },
      update: async (id, payload) => { savedRequests.push({ id, payload }); return response },
      create: async payload => { savedRequests.push({ payload }); return response },
      list: async () => context.characters.value,
    },
    toast: { success() {} }, toastError: error => errors.push(error),
  }
  vm.runInNewContext(`${code}\nObject.assign(globalThis, { characters, draft, saving, startNew, edit, save, remove })`, context)
  context.characters.value = [{ id: 1, name: '角色 A' }, { id: 2, name: '角色 B' }]
  context.edit(context.characters.value[0])
  return { ui: context, deletedIds, savedRequests, errors, resolve, reject }
}

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
