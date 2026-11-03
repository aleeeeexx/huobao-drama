/**
 * 读取织界正在使用的文本模型。
 * 选择规则与 backend/src/services/ai.ts 的 getActiveConfig('text') 一致：
 * service_type=text、已启用、官方 provider、priority 最高；同优先级取 id 较小的一条。
 * model 列是 JSON 数组，用第一项。地址拼接与 backend/src/services/adapters/url.ts 一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..')

export const OFFICIAL_TEXT_PROVIDERS = ['openai', 'gemini', 'volcengine']

export function huobaoSqlitePath() {
  const sqlitePath = (process.env.SQLITE_PATH || '').trim()
  if (sqlitePath) return sqlitePath
  const dataDir = (process.env.HUOBAO_DATA_DIR || '').trim()
  if (dataDir) return path.join(dataDir, 'huobao.sqlite3')
  return path.join(repoRoot, 'data', 'huobao.sqlite3')
}

export function joinProviderUrl(baseUrl, requiredPrefix, requestPath) {
  const normalizedBase = (baseUrl || '').replace(/\/+$/, '')
  const normalizedPrefix = normalizeSegment(requiredPrefix)
  const normalizedPath = normalizeSegment(requestPath)

  if (!normalizedBase) {
    return `${normalizedPrefix}${normalizedPath}`
  }

  try {
    const url = new URL(normalizedBase)
    const currentPath = url.pathname.replace(/\/+$/, '')
    const mergedPrefix = currentPath.endsWith(normalizedPrefix)
      ? currentPath
      : `${currentPath}${normalizedPrefix}`
    url.pathname = `${mergedPrefix}${normalizedPath}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    const basePath = normalizedBase.endsWith(normalizedPrefix)
      ? normalizedBase
      : `${normalizedBase}${normalizedPrefix}`
    return `${basePath}${normalizedPath}`
  }
}

function normalizeSegment(segment) {
  if (!segment) return ''
  return segment.startsWith('/') ? segment : `/${segment}`
}

function firstModel(raw) {
  if (raw == null) return ''
  const text = String(raw).trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return String(parsed[0] || '').trim()
    if (typeof parsed === 'string') return parsed.trim()
  } catch {
    // 少数旧行直接存了模型名
  }
  return text
}

function parseTemperature(settings) {
  if (!settings) return null
  try {
    const temperature = JSON.parse(settings)?.temperature
    return typeof temperature === 'number' && Number.isFinite(temperature) ? temperature : null
  } catch {
    return null
  }
}

function selectActiveTextConfig(rows) {
  const active = rows
    .filter(row => row.is_active && OFFICIAL_TEXT_PROVIDERS.includes(String(row.provider || '').trim().toLowerCase()))
    .sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0) || (Number(left.id) || 0) - (Number(right.id) || 0))
  const chosen = active[0]
  if (!chosen) return null
  return {
    id: Number(chosen.id),
    provider: String(chosen.provider || '').trim().toLowerCase(),
    baseUrl: String(chosen.base_url || '').trim(),
    apiKey: String(chosen.api_key || '').trim(),
    model: firstModel(chosen.model),
    temperature: parseTemperature(chosen.settings),
  }
}

function openDatabase(dbPath) {
  let db
  try {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 })
    } catch {
      db = new DatabaseSync(dbPath, { timeout: 5000 })
    }
    db.exec('PRAGMA query_only = ON')
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

export function readHuobaoTextConfig(dbPath = huobaoSqlitePath()) {
  if (!dbPath || !fs.existsSync(dbPath)) return null
  let db
  try {
    db = openDatabase(dbPath)
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_service_configs'`).get()
    if (!table) return null
    const rows = db.prepare(`
      SELECT id, provider, base_url, api_key, model, priority, is_active, settings
      FROM ai_service_configs
      WHERE service_type = 'text'
    `).all()
    return selectActiveTextConfig(rows)
  } catch (error) {
    const reason = error instanceof Error ? error.message : '读取失败'
    throw new Error(`无法读取织界文本模型配置：${reason}`)
  } finally {
    db?.close()
  }
}
