/** 用 iframe 隔离渲染插件 UI，并通过 postMessage 提供受限的本地 Planning API。 */

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { InstalledPromaPlugin } from '@proma/shared'
import { cn } from '@/lib/utils'
import {
  executePluginBridgeRequest,
  getPluginUiUrl,
  isPluginBridgeRequest,
  type PluginBridgeContext,
} from '@/lib/plugin-ui-bridge'

interface PluginUiFrameProps {
  plugin: InstalledPromaPlugin
  workspaceSlug: string | null
  workspaceId: string | null
  className?: string
}

function currentTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function PluginUiFrame({
  plugin,
  workspaceSlug,
  workspaceId,
  className,
}: PluginUiFrameProps): React.ReactElement {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const [loadError, setLoadError] = React.useState(false)
  const contextRef = React.useRef<PluginBridgeContext>({
    workspaceSlug,
    workspaceId,
    theme: currentTheme(),
    plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
  })

  contextRef.current = {
    workspaceSlug,
    workspaceId,
    theme: currentTheme(),
    plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
  }

  const post = React.useCallback((message: unknown): void => {
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const postContext = React.useCallback((): void => {
    post({ source: 'proma-plugin-host', type: 'context', context: contextRef.current })
  }, [post])

  React.useEffect(() => {
    setLoadError(false)
    postContext()
  }, [plugin.id, plugin.version, postContext])

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data: unknown = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return
      const record = data as Record<string, unknown>
      if (record.source !== 'proma-plugin') return

      if (record.type === 'ready') {
        postContext()
        return
      }
      if (!isPluginBridgeRequest(data)) return
      void executePluginBridgeRequest(data, contextRef.current)
        .then((result) => {
          post({
            source: 'proma-plugin-host',
            type: 'response',
            id: data.id,
            ok: true,
            result,
          })
        })
        .catch((error: unknown) => {
          post({
            source: 'proma-plugin-host',
            type: 'response',
            id: data.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [post, postContext])

  React.useEffect(() => {
    return window.electronAPI.onPlanningChanged((change) => {
      post({ source: 'proma-plugin-host', type: 'event', event: 'planning:changed', payload: change })
    })
  }, [post])

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => postContext()
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [postContext])

  const src = getPluginUiUrl(plugin)
  if (!src) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        插件没有配置 UI 入口。
      </div>
    )
  }

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background', className)}>
      {loadError && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle size={14} />
          插件界面加载失败，请重新安装插件或检查 ui.entry。
        </div>
      )}
      <iframe
        ref={frameRef}
        key={plugin.id + '@' + plugin.version}
        src={src}
        title={plugin.name}
        className="min-h-0 w-full flex-1 border-0 bg-background"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        allow="clipboard-read; clipboard-write"
        onLoad={() => { setLoadError(false); postContext() }}
        onError={() => setLoadError(true)}
      />
    </div>
  )
}
