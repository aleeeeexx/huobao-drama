import 'dotenv/config'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import rpg from './routes/rpg.js'
import novel from './routes/novel.js'
import aiNovel, { proxyAiNovelApp } from './routes/aiNovel.js'
import { AI_NOVEL_MOUNT, ensureAiNovelSidecar } from './services/ai-novel-sidecar.js'
import { bootstrapCodeccConfigs } from './services/codecc-config.js'
import { bootstrapGrsaiConfigs } from './services/grsai-config.js'
import { bootstrapNovarisConfigs } from './services/novaris-config.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { resumeInterruptedTasks } from './services/generation.js'
import { DATA_ROOT } from './utils/paths.js'

/** Node 默认 250ms 就换下一个地址。到 codecc 的握手经常更慢，会被收成 fetch failed。 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 2000
setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check（version 供部署巡检/更新检查核对当前运行版本）
app.get('/api/v1/health', (c) => c.json({
  status: 'ok',
  version: process.env.HUOBAO_VERSION || undefined,
  timestamp: new Date().toISOString(),
}))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)
api.route('/rpg', rpg)
api.route('/novel', novel)
api.route('/ai-novel', aiNovel)

app.route('/api/v1', api)

// 旁边的小说模块。顶栏「AI 建书」走 /ai-novel，页面里的界面经这里转到本机服务。
// 必须写在前端静态兜底之前，否则会被 SPA 的 index.html 接走。
app.use('*', async (c, next) => {
  if (c.req.path !== AI_NOVEL_MOUNT && !c.req.path.startsWith(`${AI_NOVEL_MOUNT}/`)) {
    await next()
    return
  }
  return proxyAiNovelApp(c)
})

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
await bootstrapCodeccConfigs()
await bootstrapGrsaiConfigs()
await bootstrapNovarisConfigs()
console.log(`🚀 幻书 TS server on http://localhost:${port}`)

await resumeInterruptedTasks()

const aiNovelRoot = path.join(projectRoot, 'ai-novel')
void ensureAiNovelSidecar({ root: aiNovelRoot }).then((status) => {
  if (status.running) console.log(`📚 AI 建书已就绪，顶栏进入 /ai-novel`)
  else console.warn(`📚 AI 建书未启动：${status.message}`)
})

// 建书接口用 SSE 把多步生成一直推到结束，可能超过 Node 默认 5 分钟的 requestTimeout。
const httpServer = serve({ fetch: app.fetch, port })
if ('requestTimeout' in httpServer && 'headersTimeout' in httpServer) {
  httpServer.requestTimeout = 0
  httpServer.headersTimeout = 0
}
