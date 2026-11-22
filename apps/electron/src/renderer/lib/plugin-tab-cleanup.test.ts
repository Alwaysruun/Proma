import { describe, expect, test } from 'bun:test'
import type { AgentSidePanelTab, AgentWorkspaceTab, PluginWorkspaceTab } from '@/atoms/agent-atoms'
import { removePluginTabFromOpenMap, resetPluginActiveTabs } from './plugin-tab-cleanup'

const pluginTab = 'plugin:proma-calendar' as PluginWorkspaceTab

describe('插件 Tab 清理', () => {
  test('从所有会话移除目标插件 Tab，并删除空会话', () => {
    const previous: Record<string, AgentWorkspaceTab[]> = {
      a: ['todos', pluginTab, 'calendar'],
      b: ['plugins'],
      c: [pluginTab],
    }
    const next = removePluginTabFromOpenMap(previous, pluginTab)
    expect(next.a).toEqual(['todos', 'calendar'])
    expect(next.b).toEqual(['plugins'])
    expect(next.c).toBeUndefined()
    expect(previous.a).toEqual(['todos', pluginTab, 'calendar'])
  })

  test('没有目标 Tab 时保持原对象引用', () => {
    const previous: Record<string, AgentWorkspaceTab[]> = {
      a: ['todos'],
    }
    expect(removePluginTabFromOpenMap(previous, pluginTab)).toBe(previous)
  })

  test('活动 Tab 是目标插件时回退到文件', () => {
    const previous = new Map<string, AgentSidePanelTab | 'browser' | 'preview'>([
      ['a', pluginTab],
      ['b', 'todos'],
    ])
    const next = resetPluginActiveTabs(previous, pluginTab)
    expect(next.get('a')).toBe('files')
    expect(next.get('b')).toBe('todos')
    expect(previous.get('a')).toBe(pluginTab)
  })

  test('没有活动插件 Tab 时保持原 Map 引用', () => {
    const previous = new Map<string, AgentSidePanelTab | 'browser' | 'preview'>([['a', 'files']])
    expect(resetPluginActiveTabs(previous, pluginTab)).toBe(previous)
  })
})
