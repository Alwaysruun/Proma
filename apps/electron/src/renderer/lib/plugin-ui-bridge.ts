/**
 * 渲染进程侧的插件 UI 请求执行器。
 *
 * 插件 iframe 通过 postMessage 发来白名单方法，这里转调已有的 electronAPI。
 * 插件无法直接拿到 ipcRenderer，也不会接触主进程文件系统。
 */

import type {
  CalendarEventListQuery,
  CreateCalendarEventInput,
  CreateTodoInput,
  InstalledPromaPlugin,
  TodoListQuery,
  UpdateCalendarEventInput,
  UpdateTodoInput,
} from '@proma/shared'

export interface PluginBridgeRequest {
  source: 'proma-plugin'
  type: 'request'
  id: string
  method: string
  params?: unknown
}

export interface PluginBridgeContext {
  workspaceSlug: string | null
  workspaceId: string | null
  theme: 'light' | 'dark'
  plugin: Pick<InstalledPromaPlugin, 'id' | 'name' | 'version'>
}

export function isPluginBridgeRequest(value: unknown): value is PluginBridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.source === 'proma-plugin'
    && record.type === 'request'
    && typeof record.id === 'string'
    && record.id.length > 0
    && record.id.length <= 120
    && typeof record.method === 'string'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireId(params: Record<string, unknown>): string {
  const id = params.id
  if (typeof id !== 'string' || !id.trim()) throw new Error('缺少记录 id')
  return id
}

/** 只允许插件访问本地 Planning 数据与只读上下文。 */
export async function executePluginBridgeRequest(
  request: PluginBridgeRequest,
  context: PluginBridgeContext,
): Promise<unknown> {
  const params = isObject(request.params) ? request.params : {}
  switch (request.method) {
    case 'plugin.getContext':
      return context
    case 'planning.listTodos':
      return window.electronAPI.listTodos(params as TodoListQuery)
    case 'planning.createTodo':
      return window.electronAPI.createTodo(params as unknown as CreateTodoInput)
    case 'planning.updateTodo':
      return window.electronAPI.updateTodo(params as unknown as UpdateTodoInput)
    case 'planning.deleteTodo':
      return window.electronAPI.deleteTodo(requireId(params))
    case 'planning.listCalendarEvents':
      return window.electronAPI.listCalendarEvents(params as CalendarEventListQuery)
    case 'planning.createCalendarEvent':
      return window.electronAPI.createCalendarEvent(params as unknown as CreateCalendarEventInput)
    case 'planning.updateCalendarEvent':
      return window.electronAPI.updateCalendarEvent(params as unknown as UpdateCalendarEventInput)
    case 'planning.deleteCalendarEvent':
      return window.electronAPI.deleteCalendarEvent(requireId(params))
    case 'planning.listGroups': {
      const scope = params.scope
      if (scope !== 'todo' && scope !== 'calendar') throw new Error('分组范围非法')
      return window.electronAPI.listPlanningGroups(scope)
    }
    case 'planning.listTags':
      return window.electronAPI.listPlanningTags()
    default:
      throw new Error('插件调用了未授权的方法: ' + request.method)
  }
}

export function getPluginUiUrl(plugin: InstalledPromaPlugin): string | null {
  if (!plugin.ui) return null
  const entry = plugin.ui.entry
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return 'proma-plugin://' + plugin.id + '/' + encodeURIComponent(plugin.version) + '/' + entry
}
