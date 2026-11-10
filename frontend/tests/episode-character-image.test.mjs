import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parse as parseComponent } from '@vue/compiler-sfc'
import { parse as parseScript } from '@babel/parser'
import { computed, effectScope, nextTick, ref, watch } from 'vue'

const component = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const script = parseComponent(component).descriptor.scriptSetup.content
const statements = parseScript(script, { sourceType: 'module' }).program.body
const statement = predicate => {
  const node = statements.find(predicate)
  assert.ok(node)
  return script.slice(node.start, node.end)
}
const namedFunction = name => statement(node => node.type === 'FunctionDeclaration' && node.id.name === name)
const variable = name => statement(node => node.type === 'VariableDeclaration' && node.declarations.some(declaration => declaration.id.name === name))
const watcher = statement(node => node.type === 'ExpressionStatement' && node.expression.callee?.name === 'watch'
  && node.expression.arguments[0]?.name === 'shouldPollGenTasks')
const unmountHook = statement(node => node.type === 'ExpressionStatement' && node.expression.callee?.name === 'onBeforeUnmount')
const code = [
  ...['syncCharacterImage', 'characterImageRevision', 'saveAssetDetail', 'loadGenTasks', 'stopGenTasksPolling', 'refresh', 'refreshData'].map(namedFunction),
  ...['genTaskLoadFailures', 'genTaskActiveCount', 'shouldPollGenTasks', 'refreshPromise', 'refreshAgain', 'refreshingTasks'].map(variable),
  watcher, unmountHook,
  'Object.assign(globalThis, { saveAssetDetail, refresh, stopGenTasksPolling })',
].join('\n')

function createWorkbench() {
  const original = { id: 4, appearance: '旧外貌', physique: '', personality: '', styling: '', final_prompt: '旧提示词',
    image_url: 'static/images/old.png', imageUrl: 'static/images/old.png', local_path: 'static/images/old.png',
    localPath: 'static/images/old.png', image_revision: 0, imageRevision: 0 }
  const state = { character: { ...original }, tasks: [], preparing: false, characterRequest: null }
  const timers = new Map()
  let timerId = 0
  let unmount = () => {}
  const context = {
    ref, computed, watch,
    dramaId: 1, episodeNumber: 1,
    drama: ref(null), episode: ref({ id: 2 }), chars: ref([{ ...original }]), scenes: ref([]), propItems: ref([]),
    sbs: ref([]), mergeData: ref(null), selectedVideoSbIds: ref([]), selectedSb: ref(null), scriptStep: ref(0),
    epId: ref(2), panelRestored: false,
    genTasks: ref([]), genMerges: ref([]), assetImagesPending: ref(false), genTasksTimer: null,
    pendingVideoIds: ref([]), failedVideoMessages: ref({}),
    assetDetail: ref({ open: true, type: 'character', item: { ...original } }),
    assetDetailDraft: ref({ appearance: '新外貌', physique: '', personality: '', styling: '' }),
    assetPromptDraft: ref('旧提示词'), assetPromptDirty: ref(false), savingAssetDetail: ref(false),
    dramaAPI: { get: async () => ({ episodes: [{ id: 2, episode_number: 1 }] }) },
    episodeAPI: {
      scenes: async () => [], props: async () => [], storyboards: async () => [],
      characters: async () => state.characterRequest ? state.characterRequest() : [{ ...state.character }],
    },
    characterAPI: { update: async (_id, payload) => {
      state.character = { ...state.character, ...payload, final_prompt: null, image_url: null, imageUrl: null,
        local_path: null, localPath: null, image_revision: 1, imageRevision: 1 }
      state.preparing = true
      return { ...state.character, imageUrl: 'static/images/stale-alias.png', localPath: 'static/images/stale-alias.png' }
    } },
    sceneAPI: {}, propAPI: {},
    taskAPI: { listByEpisode: async () => ({ tasks: state.tasks, merges: [], asset_images_pending: state.preparing }) },
    mergeAPI: { status: async () => null }, loadExportMerges: async () => {}, hasVid: () => false,
    toast: { success() {}, info() {} }, toastError(error) { throw error }, t: key => key,
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearInterval(id) { timers.delete(id) },
    onBeforeUnmount(fn) { unmount = fn }, window: { removeEventListener() {} }, handleImageViewerKeydown() {},
  }
  const scope = effectScope()
  scope.run(() => vm.runInNewContext(code, context))
  return {
    context, state, original, timers,
    async tick() { for (const fn of [...timers.values()]) await fn(); await nextTick() },
    close() { unmount(); scope.stop() },
  }
}

test('saving tracks preparation and image generation while preserving the open draft', async () => {
  const workbench = createWorkbench()
  const { context: ui, state, timers } = workbench
  try {
    assert.equal(await ui.saveAssetDetail(), true)
    assert.equal(ui.assetDetail.value.item.image_url, null)
    assert.equal(ui.assetDetail.value.item.imageUrl, null)
    assert.equal(ui.chars.value[0].local_path, null)
    assert.equal(ui.chars.value[0].localPath, null)
    await ui.refresh()
    await nextTick()
    assert.equal(timers.size, 1)
    await workbench.tick()
    assert.equal(timers.size, 1)

    ui.assetDetailDraft.value.appearance = '尚未保存的外貌'
    ui.assetPromptDraft.value = '尚未保存的提示词'
    ui.assetPromptDirty.value = true
    state.preparing = false
    state.tasks = [{ type: 'image', character_id: 4, status: 'processing' }]
    await workbench.tick()
    assert.equal(timers.size, 1)

    state.character = { ...state.character, image_url: 'static/images/new.png', local_path: 'static/images/new.png' }
    state.tasks = [{ type: 'image', character_id: 4, status: 'completed' }]
    await workbench.tick()
    assert.equal(timers.size, 0)
    assert.equal(ui.chars.value[0].image_url, 'static/images/new.png')
    assert.equal(ui.assetDetail.value.item.image_url, 'static/images/new.png')
    assert.equal(ui.assetDetail.value.item.imageUrl, 'static/images/new.png')
    assert.equal(ui.assetDetailDraft.value.appearance, '尚未保存的外貌')
    assert.equal(ui.assetPromptDraft.value, '尚未保存的提示词')
    assert.equal(ui.assetPromptDirty.value, true)
  } finally { workbench.close() }
})

test('a refresh started before a save cannot restore an older image', async () => {
  const workbench = createWorkbench()
  const { context: ui, state, original } = workbench
  let firstStarted, secondStarted, releaseFirst, releaseSecond
  const first = new Promise(resolve => { releaseFirst = resolve })
  const second = new Promise(resolve => { releaseSecond = resolve })
  const firstRequest = new Promise(resolve => { firstStarted = resolve })
  const secondRequest = new Promise(resolve => { secondStarted = resolve })
  let calls = 0
  state.characterRequest = async () => {
    if (++calls === 1) { firstStarted(); await first; return [{ ...original }] }
    if (calls === 2) { secondStarted(); await second }
    return [{ ...state.character }]
  }
  try {
    const refreshing = ui.refresh()
    await firstRequest
    assert.equal(await ui.saveAssetDetail(), true)
    releaseFirst()
    await secondRequest
    assert.equal(ui.chars.value[0].image_revision, 1)
    assert.equal(ui.chars.value[0].image_url, null)
    assert.equal(ui.assetDetail.value.item.imageUrl, null)
    releaseSecond()
    await refreshing
  } finally {
    releaseFirst()
    releaseSecond()
    workbench.close()
  }
})
