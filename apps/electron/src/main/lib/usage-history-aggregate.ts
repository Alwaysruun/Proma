/** 用量历史纯聚合逻辑；不依赖 Electron，便于测试。 */

import type {
  UsageHistoryBucket,
  UsageHistoryDay,
  UsageHistoryModel,
  UsageHistoryModelDay,
  UsageHistorySession,
  UsageHistorySnapshot,
} from '@proma/shared'

export interface UsageRecord {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export interface UsageHistorySessionMeta {
  id: string
  title: string
  workspaceId?: string
  updatedAt: number
  modelId?: string
}

export function emptyUsageBucket(): UsageHistoryBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    runs: 0,
  }
}

function addRecord(bucket: UsageHistoryBucket, record: UsageRecord): void {
  bucket.inputTokens += record.inputTokens
  bucket.outputTokens += record.outputTokens
  bucket.cacheReadTokens += record.cacheReadTokens
  bucket.cacheCreationTokens += record.cacheCreationTokens
  bucket.totalTokens += record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheCreationTokens
  bucket.costUsd += record.costUsd
  bucket.runs += 1
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

export function aggregateUsageHistory(
  sessions: readonly UsageHistorySessionMeta[],
  recordsBySession: ReadonlyMap<string, readonly UsageRecord[]>,
): UsageHistorySnapshot {
  const totals = emptyUsageBucket()
  const days = new Map<string, UsageHistoryDay>()
  const models = new Map<string, UsageHistoryModel>()
  const modelDays = new Map<string, UsageHistoryModelDay>()
  const sessionRows: UsageHistorySession[] = []
  let recordCount = 0

  for (const session of sessions) {
    const records = recordsBySession.get(session.id) ?? []
    if (records.length === 0) continue
    const sessionBucket = emptyUsageBucket()
    let latestModel: string | undefined

    for (const record of records) {
      const timestamp = record.timestamp > 0 ? record.timestamp : session.updatedAt
      addRecord(totals, record)
      addRecord(sessionBucket, record)
      recordCount += 1
      latestModel = record.model

      const dayKey = localDateKey(timestamp)
      let day = days.get(dayKey)
      if (!day) {
        day = { date: dayKey, ...emptyUsageBucket() }
        days.set(dayKey, day)
      }
      addRecord(day, record)

      let model = models.get(record.model)
      if (!model) {
        model = { model: record.model, ...emptyUsageBucket() }
        models.set(record.model, model)
      }
      addRecord(model, record)

      const modelDayKey = dayKey + '\u0000' + record.model
      let modelDay = modelDays.get(modelDayKey)
      if (!modelDay) {
        modelDay = { date: dayKey, model: record.model, ...emptyUsageBucket() }
        modelDays.set(modelDayKey, modelDay)
      }
      addRecord(modelDay, record)
    }

    const modelName = latestModel ?? session.modelId
    sessionRows.push({
      ...sessionBucket,
      id: session.id,
      title: session.title,
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(modelName ? { model: modelName } : {}),
      updatedAt: session.updatedAt,
    })
  }

  return {
    generatedAt: Date.now(),
    totals,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    modelDays: [...modelDays.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)),
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd),
    sessions: sessionRows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500),
    recordCount,
  }
}
