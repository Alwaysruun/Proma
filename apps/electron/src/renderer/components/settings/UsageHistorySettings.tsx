/** 设置页 · 用量历史：按时间、模型和会话汇总本地 Agent token 与费用。 */

import * as React from 'react'
import { BarChart3, Coins, Loader2, RefreshCw } from 'lucide-react'
import type { UsageHistoryBucket, UsageHistoryModel, UsageHistorySnapshot } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const RANGE_OPTIONS = [
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
  { label: '全部', days: 0 },
] as const

const tokenFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const fullTokenFormatter = new Intl.NumberFormat('zh-CN')

function formatTokens(value: number): string {
  return value > 0 ? tokenFormatter.format(value) : '0'
}

function formatFullTokens(value: number): string {
  return fullTokenFormatter.format(value)
}

function formatCost(value: number): string {
  if (value <= 0) return '$0'
  if (value < 0.01) return '$' + value.toFixed(4)
  if (value < 1) return '$' + value.toFixed(3)
  return '$' + value.toFixed(2)
}

function emptyBucket(): UsageHistoryBucket {
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

function addBuckets(buckets: readonly UsageHistoryBucket[]): UsageHistoryBucket {
  const result = emptyBucket()
  for (const bucket of buckets) {
    result.inputTokens += bucket.inputTokens
    result.outputTokens += bucket.outputTokens
    result.cacheReadTokens += bucket.cacheReadTokens
    result.cacheCreationTokens += bucket.cacheCreationTokens
    result.totalTokens += bucket.totalTokens
    result.costUsd += bucket.costUsd
    result.runs += bucket.runs
  }
  return result
}

function cutoffFor(days: number): number | null {
  if (days === 0) return null
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.getTime() - (days - 1) * 86400000
}

function formatDate(date: string): string {
  return date.slice(5).replace('-', '/')
}

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-border/70 bg-background/60 px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground/80">{hint}</div>}
    </div>
  )
}

export function UsageHistorySettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<UsageHistorySnapshot | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [rangeDays, setRangeDays] = React.useState<number>(30)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await window.electronAPI.getUsageHistory())
    } catch (loadError) {
      console.error('[用量历史] 读取失败:', loadError)
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const cutoff = React.useMemo(() => cutoffFor(rangeDays), [rangeDays])
  const days = React.useMemo(() => {
    if (!snapshot) return []
    return cutoff === null
      ? snapshot.days
      : snapshot.days.filter((day) => new Date(day.date + 'T00:00:00').getTime() >= cutoff)
  }, [snapshot, cutoff])
  const totals = React.useMemo(() => addBuckets(days), [days])

  const models = React.useMemo<UsageHistoryModel[]>(() => {
    if (!snapshot) return []
    const source = cutoff === null
      ? snapshot.modelDays
      : snapshot.modelDays.filter((row) => new Date(row.date + 'T00:00:00').getTime() >= cutoff)
    const map = new Map<string, UsageHistoryModel>()
    for (const row of source) {
      let entry = map.get(row.model)
      if (!entry) {
        entry = { model: row.model, ...emptyBucket() }
        map.set(row.model, entry)
      }
      entry.inputTokens += row.inputTokens
      entry.outputTokens += row.outputTokens
      entry.cacheReadTokens += row.cacheReadTokens
      entry.cacheCreationTokens += row.cacheCreationTokens
      entry.totalTokens += row.totalTokens
      entry.costUsd += row.costUsd
      entry.runs += row.runs
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd)
  }, [snapshot, cutoff])

  const sessions = React.useMemo(() => {
    if (!snapshot) return []
    const source = cutoff === null
      ? snapshot.sessions
      : snapshot.sessions.filter((session) => session.updatedAt >= cutoff)
    return source.slice(0, 50)
  }, [snapshot, cutoff])

  const chartDays = days.slice(-31)
  const chartMax = Math.max(1, ...chartDays.map((day) => day.totalTokens))

  if (loading && !snapshot) {
    return (
      <div className="flex items-center gap-2 py-20 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        正在汇总本地会话用量...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <BarChart3 size={18} className="text-primary" />
            用量历史
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
            根据本地 Agent 会话记录汇总 token 与费用。费用仅统计渠道返回的金额，未返回费用的运行显示为 $0。
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          刷新
        </Button>
      </div>

      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.days}
            type="button"
            onClick={() => setRangeDays(option.days)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs transition-colors',
              rangeDays === option.days
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          读取用量历史失败：{error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="总 Token"
          value={formatFullTokens(totals.totalTokens)}
          hint={'输入 ' + formatTokens(totals.inputTokens) + ' · 输出 ' + formatTokens(totals.outputTokens)}
        />
        <SummaryCard
          label="缓存 Token"
          value={formatTokens(totals.cacheReadTokens + totals.cacheCreationTokens)}
          hint={'读取 ' + formatTokens(totals.cacheReadTokens) + ' · 写入 ' + formatTokens(totals.cacheCreationTokens)}
        />
        <SummaryCard label="费用（USD）" value={formatCost(totals.costUsd)} hint="渠道返回的累计费用" />
        <SummaryCard label="Agent 运行" value={fullTokenFormatter.format(totals.runs) + ' 次'} hint="按每次 run 的 result 统计" />
      </div>

      <section className="rounded-xl border border-border/70 bg-background/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">每日 Token</h3>
          <span className="text-xs text-muted-foreground">最近 {chartDays.length} 天</span>
        </div>
        {chartDays.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">这个时间范围内还没有用量记录。</div>
        ) : (
          <div className="flex h-40 items-end gap-1 overflow-x-auto pb-1">
            {chartDays.map((day) => (
              <div key={day.date} className="group flex min-w-[18px] flex-1 flex-col items-center justify-end gap-1">
                <div
                  className="w-full max-w-8 rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                  style={{ height: Math.max(2, Math.round((day.totalTokens / chartMax) * 132)) + 'px' }}
                  title={day.date + ' · ' + formatFullTokens(day.totalTokens) + ' tokens · ' + formatCost(day.costUsd)}
                />
                <span className="text-[10px] tabular-nums text-muted-foreground">{formatDate(day.date)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Coins size={15} className="text-muted-foreground" />
          按模型
        </h3>
        {models.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">
            暂无模型用量。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/70">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">模型</th>
                  <th className="px-4 py-2.5 text-right font-medium">运行</th>
                  <th className="px-4 py-2.5 text-right font-medium">Token</th>
                  <th className="px-4 py-2.5 text-right font-medium">费用</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.model} className="border-t border-border/60">
                    <td className="max-w-[240px] truncate px-4 py-2.5 text-foreground">{model.model}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{model.runs}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{formatFullTokens(model.totalTokens)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatCost(model.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BarChart3 size={15} className="text-muted-foreground" />
          按会话
        </h3>
        {sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">
            暂无会话用量。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/70">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">会话</th>
                  <th className="px-4 py-2.5 font-medium">模型</th>
                  <th className="px-4 py-2.5 text-right font-medium">Token</th>
                  <th className="px-4 py-2.5 text-right font-medium">费用</th>
                  <th className="px-4 py-2.5 text-right font-medium">最近使用</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="border-t border-border/60">
                    <td className="max-w-[280px] truncate px-4 py-2.5 text-foreground" title={session.title}>{session.title}</td>
                    <td className="max-w-[180px] truncate px-4 py-2.5 text-muted-foreground">{session.model ?? '未知'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{formatFullTokens(session.totalTokens)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatCost(session.costUsd)}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                      {new Date(session.updatedAt).toLocaleDateString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {snapshot && snapshot.sessions.length > sessions.length && (
          <p className="text-[11px] text-muted-foreground">仅显示最近 {sessions.length} 个会话。</p>
        )}
      </section>

      {snapshot && snapshot.recordCount === 0 && (
        <div className="rounded-xl border border-dashed border-border/70 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">还没有可统计的 Agent 用量</p>
          <p className="mt-1 text-xs text-muted-foreground">完成一次 Agent 对话后，这里会显示 token 与费用。</p>
        </div>
      )}
    </div>
  )
}
