import { describe, expect, test } from 'bun:test'
import { aggregateUsageHistory, localDateKey, type UsageRecord } from './usage-history-aggregate'

const day1 = new Date(2026, 10, 20, 10, 0, 0).getTime()
const day2 = new Date(2026, 10, 21, 11, 0, 0).getTime()

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    timestamp: day1,
    model: 'model-a',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    ...overrides,
  }
}

describe('用量历史聚合', () => {
  test('按天、模型、会话汇总 token 与费用', () => {
    const recordsBySession = new Map<string, UsageRecord[]>([
      ['session-a', [
        record({ timestamp: day1, model: 'model-a', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, costUsd: 0.01 }),
        record({ timestamp: day2, model: 'model-b', inputTokens: 200, outputTokens: 100, costUsd: 0.02 }),
      ]],
      ['session-b', [
        record({ timestamp: 0, model: 'model-a', inputTokens: 10, outputTokens: 5, costUsd: 0.005 }),
      ]],
    ])

    const snapshot = aggregateUsageHistory([
      { id: 'session-a', title: '会话 A', workspaceId: 'ws-1', updatedAt: day2, modelId: 'model-a' },
      { id: 'session-b', title: '会话 B', updatedAt: day2, modelId: 'model-a' },
      { id: 'session-empty', title: '空会话', updatedAt: day2 },
    ], recordsBySession)

    expect(snapshot.recordCount).toBe(3)
    expect(snapshot.totals.totalTokens).toBe(480)
    expect(snapshot.totals.costUsd).toBeCloseTo(0.035, 6)
    expect(snapshot.totals.runs).toBe(3)

    expect(snapshot.days.map((day) => day.date)).toEqual([localDateKey(day1), localDateKey(day2)])
    expect(snapshot.days[0]?.totalTokens).toBe(165)
    expect(snapshot.days[1]?.totalTokens).toBe(315)

    expect(snapshot.models[0]?.model).toBe('model-b')
    expect(snapshot.models[0]?.totalTokens).toBe(300)
    const modelA = snapshot.models.find((model) => model.model === 'model-a')
    expect(modelA?.totalTokens).toBe(180)
    expect(modelA?.runs).toBe(2)

    expect(snapshot.modelDays).toHaveLength(3)
    expect(snapshot.sessions.map((session) => session.id)).toEqual(['session-a', 'session-b'])
    expect(snapshot.sessions[0]?.totalTokens).toBe(465)
    expect(snapshot.sessions[1]?.totalTokens).toBe(15)
  })

  test('没有时间戳的记录使用会话更新时间', () => {
    const snapshot = aggregateUsageHistory(
      [{ id: 'session-c', title: '会话 C', updatedAt: day2 }],
      new Map([['session-c', [record({ timestamp: 0, model: 'model-c', inputTokens: 7, outputTokens: 3 })]]]),
    )

    expect(snapshot.days).toHaveLength(1)
    expect(snapshot.days[0]?.date).toBe(localDateKey(day2))
    expect(snapshot.totals.totalTokens).toBe(10)
  })
})
