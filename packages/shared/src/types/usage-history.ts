/** 本地 Agent 用量历史。数据来自会话 JSONL 中每次 Agent 运行的 usage。 */

export interface UsageHistoryBucket {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number
  /** 产生用量的 Agent 运行次数 */
  runs: number
}

export interface UsageHistoryDay extends UsageHistoryBucket {
  /** 本地时区日期，格式 YYYY-MM-DD */
  date: string
}

export interface UsageHistoryModel extends UsageHistoryBucket {
  model: string
}

/** 按天 + 模型拆分，供设置页切换时间范围时重新聚合。 */
export interface UsageHistoryModelDay extends UsageHistoryBucket {
  date: string
  model: string
}

export interface UsageHistorySession extends UsageHistoryBucket {
  id: string
  title: string
  workspaceId?: string
  /** 会话最近一次使用的模型 */
  model?: string
  updatedAt: number
}

export interface UsageHistorySnapshot {
  generatedAt: number
  totals: UsageHistoryBucket
  days: UsageHistoryDay[]
  modelDays: UsageHistoryModelDay[]
  models: UsageHistoryModel[]
  sessions: UsageHistorySession[]
  /** 实际读取到的用量记录数量 */
  recordCount: number
}

export const USAGE_HISTORY_IPC_CHANNEL = 'agent:get-usage-history'
