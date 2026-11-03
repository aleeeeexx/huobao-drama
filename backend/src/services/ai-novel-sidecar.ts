/**
 * 拉起旁边的 ai-novel 进程，并把它的 HTTP 转到织界同源路径。
 * 已经在目标端口上的本服务会被直接复用，不会再起一个。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const AI_NOVEL_MOUNT = '/ai-novel-app'
const START_TIMEOUT_MS = 10_000

export type AiNovelSidecarStatus = {
  running: boolean
  port: number
  root: string | null
  managed: boolean
  message: string
}

let child: ChildProcess | null = null
let preferredRoot: string | undefined
let state: AiNovelSidecarStatus = {
  running: false,
  port: 5681,
  root: null,
  managed: false,
  message: '',
}
let starting: Promise<AiNovelSidecarStatus> | null = null

export function aiNovelPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_NOVEL_PORT
  if (raw == null || raw === '') return 5681
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 5681
  return port
}

export function bookDatabasePath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AI_NOVEL_DB) return env.AI_NOVEL_DB
  if (env.HUOBAO_DATA_DIR) return path.join(env.HUOBAO_DATA_DIR, 'ai-novel', 'books.sqlite')
  return null
}

export function resolveAiNovelRoot(candidates: Array<string | undefined | null>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const root = path.resolve(candidate)
    if (fs.existsSync(path.join(root, 'server.mjs')) && fs.existsSync(path.join(root, 'public', 'index.html'))) {
      return root
    }
  }
  return null
}

export function upstreamPath(requestPath: string): string | null {
  if (requestPath === AI_NOVEL_MOUNT || requestPath === `${AI_NOVEL_MOUNT}/`) return '/'
  const prefix = `${AI_NOVEL_MOUNT}/`
  if (!requestPath.startsWith(prefix)) return null
  return requestPath.slice(AI_NOVEL_MOUNT.length)
}

export function getAiNovelSidecarStatus(): AiNovelSidecarStatus {
  return { ...state }
}

async function probe(port: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 800)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json().catch(() => null) as { ok?: boolean, service?: string } | null
    return body?.ok === true && body.service === 'ai-novel'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function sidecarCommandEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AI_NOVEL_PORT: String(port) }
  if ('electron' in process.versions) env.ELECTRON_RUN_AS_NODE = '1'
  const database = bookDatabasePath(env)
  if (database) env.AI_NOVEL_DB = database
  return env
}

function rememberExit(proc: ChildProcess, port: number) {
  proc.on('exit', (code) => {
    if (child === proc) child = null
    if (state.managed && state.port === port) {
      state = {
        ...state,
        running: false,
        managed: false,
        message: code ? `小说模块已退出（${code}）` : state.message,
      }
    }
  })
}

async function killChild(): Promise<void> {
  const proc = child
  child = null
  state = { ...state, running: false, managed: false }
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 2000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.kill()
  })
}

function readStream(proc: ChildProcess): { stderr: () => string } {
  let stderr = ''
  proc.stdout?.on('data', (chunk) => {
    process.stdout.write(`[ai-novel] ${chunk}`)
  })
  proc.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000)
    process.stderr.write(`[ai-novel] ${chunk}`)
  })
  return { stderr: () => stderr.trim() }
}

async function waitUntilReady(port: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probe(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return probe(port)
}

async function runEnsure(options: { root?: string }): Promise<AiNovelSidecarStatus> {
  if (options.root) preferredRoot = options.root
  const port = aiNovelPort()
  if (await probe(port)) {
    state = { running: true, port, root: state.root ?? preferredRoot ?? null, managed: Boolean(child), message: '' }
    return getAiNovelSidecarStatus()
  }
  if (child) await killChild()
  if (process.env.AI_NOVEL_AUTOSTART === '0') {
    state = {
      running: false,
      port,
      root: preferredRoot ?? null,
      managed: false,
      message: '已设置 AI_NOVEL_AUTOSTART=0，不会自动启动。',
    }
    return getAiNovelSidecarStatus()
  }
  const root = resolveAiNovelRoot([process.env.AI_NOVEL_ROOT, preferredRoot])
  if (!root) {
    state = {
      running: false,
      port,
      root: null,
      managed: false,
      message: '找不到 ai-novel 目录（需要其中的 server.mjs）。',
    }
    return getAiNovelSidecarStatus()
  }
  const env = sidecarCommandEnv(port)
  const proc = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = proc
  state = { running: false, port, root, managed: true, message: '' }
  const output = readStream(proc)
  let spawnError = ''
  proc.once('error', (error) => {
    spawnError = error.message
  })
  rememberExit(proc, port)
  const ready = await waitUntilReady(port)
  if (!ready || child !== proc) {
    const detail = spawnError || output.stderr() || `端口 ${port} 上没有在 ${START_TIMEOUT_MS / 1000} 秒内就绪`
    if (child === proc) await killChild()
    state = { running: false, port, root, managed: false, message: detail }
    console.warn(`[ai-novel] 未启动：${detail}`)
    return getAiNovelSidecarStatus()
  }
  state = { running: true, port, root, managed: true, message: '' }
  console.log(`[ai-novel] ready on http://127.0.0.1:${port}`)
  return getAiNovelSidecarStatus()
}

export function ensureAiNovelSidecar(options: { root?: string } = {}): Promise<AiNovelSidecarStatus> {
  if (options.root) preferredRoot = options.root
  if (!starting) {
    starting = runEnsure(options).finally(() => {
      starting = null
    })
  }
  return starting
}

export function stopAiNovelSidecar(): Promise<void> {
  return killChild()
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export async function forwardAiNovelRequest(request: Request, port: number): Promise<Response> {
  const url = new URL(request.url)
  const pathname = upstreamPath(url.pathname)
  if (!pathname) return jsonResponse(404, { ok: false, message: '没有这个地址' })
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: request.signal,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}${pathname}${url.search}`, init)
    const responseHeaders = new Headers(upstream.headers)
    for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']) {
      responseHeaders.delete(name)
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  } catch {
    return jsonResponse(503, { ok: false, message: '小说模块没有响应' })
  }
}

process.on('exit', () => {
  child?.kill()
})
