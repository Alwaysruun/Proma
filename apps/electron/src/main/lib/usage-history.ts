/** 从本地 Agent 会话 JSONL 读取每次运行的 usage，并交给纯聚合模块。 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { AgentSessionMeta, UsageHistorySnapshot } from '@proma/shared'
import { getAgentSessionMessagesPath } from './config-paths'
import { listAgentSessions } from './agent-session-manager'
import {
  aggregateUsageHistory,
  type UsageRecord,
} from './usage-history-aggregate'

export { aggregateUsageHistory, type UsageRecord } from './usage-history-aggregate'

interface CachedSessionUsage {
  mtimeMs: number
  size: number
  records: UsageRecord[]
}

const usageCache = new Map<string, CachedSessionUsage>()

function toNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function pickModel(record: Record<string, unknown>, fallback: string): string {
  const channelModelId = record._channelModelId
  if (typeof channelModelId === 'string' && channelModelId.trim()) return channelModelId
  const modelUsage = record.modelUsage
  if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
    const first = Object.keys(modelUsage as Record<string, unknown>)[0]
    if (first) return first
  }
  const message = record.message
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const model = (message as Record<string, unknown>).model
    if (typeof model === 'string' && model.trim()) return model
  }
  return fallback
}

function parseUsage(record: Record<string, unknown>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} | null {
  const usage = record.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const raw = usage as Record<string, unknown>
  const inputTokens = toNonNegativeNumber(raw.input_tokens)
  const outputTokens = toNonNegativeNumber(raw.output_tokens)
  const cacheReadTokens = toNonNegativeNumber(raw.cache_read_input_tokens)
  const cacheCreationTokens = toNonNegativeNumber(raw.cache_creation_input_tokens)
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return null
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readUsageRecords(sessionId: string, fallbackModel: string): UsageRecord[] {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return []

  let info
  try {
    info = statSync(filePath)
  } catch {
    return []
  }
  const cached = usageCache.get(sessionId)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.records
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const hasResult = raw.includes('"type":"result"')
  const records: UsageRecord[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    if (hasResult) {
      if (!line.includes('"type":"result"')) continue
    } else if (!line.includes('"type":"assistant"')) {
      continue
    }

    const parsed = parseLine(line)
    if (!parsed) continue
    const isResult = parsed.type === 'result'
    if (isResult && parsed.isSyntheticCompactionResult === true) continue
    const usage = parseUsage(parsed)
    if (!usage) continue

    records.push({
      timestamp: toNonNegativeNumber(parsed._createdAt),
      model: pickModel(parsed, fallbackModel),
      ...usage,
      costUsd: isResult ? toNonNegativeNumber(parsed.total_cost_usd) : 0,
    })
  }

  usageCache.set(sessionId, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    records,
  })
  return records
}

export function getUsageHistory(): UsageHistorySnapshot {
  const sessions = listAgentSessions()
  const recordsBySession = new Map<string, UsageRecord[]>()
  for (const session of sessions) {
    recordsBySession.set(session.id, readUsageRecords(session.id, session.modelId ?? '未知模型'))
  }
  return aggregateUsageHistory(
    sessions.map((session: AgentSessionMeta) => ({
      id: session.id,
      title: session.title,
      workspaceId: session.workspaceId,
      updatedAt: session.updatedAt,
      modelId: session.modelId,
    })),
    recordsBySession,
  )
}
