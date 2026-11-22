/** 卸载插件时的 Tab 清理纯函数；不依赖 Jotai，便于测试。 */

import type { AgentSidePanelTab, AgentWorkspaceTab, PluginWorkspaceTab } from '@/atoms/agent-atoms'

export function removePluginTabFromOpenMap(
  previous: Record<string, AgentWorkspaceTab[]>,
  target: PluginWorkspaceTab,
): Record<string, AgentWorkspaceTab[]> {
  let changed = false
  const next: Record<string, AgentWorkspaceTab[]> = {}
  for (const [sessionId, tabs] of Object.entries(previous)) {
    const filtered = tabs.filter((tab) => tab !== target)
    if (filtered.length !== tabs.length) changed = true
    if (filtered.length > 0) next[sessionId] = filtered
  }
  return changed ? next : previous
}

export function resetPluginActiveTabs(
  previous: Map<string, AgentSidePanelTab | 'browser' | 'preview'>,
  target: PluginWorkspaceTab,
): Map<string, AgentSidePanelTab | 'browser' | 'preview'> {
  let changed = false
  const next = new Map(previous)
  for (const [sessionId, activeTab] of previous) {
    if (activeTab !== target) continue
    next.set(sessionId, 'files')
    changed = true
  }
  return changed ? next : previous
}
