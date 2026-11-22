/**
 * usePluginsData — Proma 插件数据层
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { removePluginWorkspaceTabsAtom, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import type {
  InstalledPromaPlugin,
  PromaMarketplacePlugin,
  PromaPluginSettingsSnapshot,
  SavePromaPluginSettingsInput,
} from '@proma/shared'

export interface PluginsData {
  plugins: InstalledPromaPlugin[]
  marketplace: PromaMarketplacePlugin[]
  loading: boolean
  marketplaceLoading: boolean
  busyAction: string | null
  refresh: () => Promise<void>
  refreshMarketplace: () => Promise<void>
  installFromFolder: () => Promise<void>
  installFromZip: () => Promise<void>
  installBuiltin: (pluginId: string) => Promise<void>
  installMarketplace: (pluginId: string) => Promise<void>
  publishToMarketplace: (plugin: InstalledPromaPlugin) => Promise<void>
  openMarketplaceFolder: () => Promise<void>
  uninstall: (plugin: InstalledPromaPlugin) => Promise<void>
  openFolder: (plugin: InstalledPromaPlugin) => Promise<void>
  createTemplate: () => Promise<void>
  getSettings: (pluginId: string) => Promise<PromaPluginSettingsSnapshot>
  saveSettings: (pluginId: string, input: SavePromaPluginSettingsInput) => Promise<PromaPluginSettingsSnapshot>
}

export function usePluginsData(workspaceSlug: string): PluginsData {
  const [plugins, setPlugins] = React.useState<InstalledPromaPlugin[]>([])
  const [marketplace, setMarketplace] = React.useState<PromaMarketplacePlugin[]>([])
  const [loading, setLoading] = React.useState(true)
  const [marketplaceLoading, setMarketplaceLoading] = React.useState(true)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom)
  const removePluginWorkspaceTabs = useSetAtom(removePluginWorkspaceTabsAtom)
  const requestRef = React.useRef(0)

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!workspaceSlug) {
      setPlugins([])
      setLoading(false)
      return
    }
    const requestId = ++requestRef.current
    try {
      const next = await window.electronAPI.listWorkspacePlugins(workspaceSlug)
      if (requestRef.current !== requestId) return
      setPlugins(next)
    } catch (error) {
      if (requestRef.current !== requestId) return
      console.error('[Proma 插件] 加载失败:', error)
      toast.error('加载插件失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [workspaceSlug])

  const refreshMarketplace = React.useCallback(async (): Promise<void> => {
    if (!workspaceSlug) {
      setMarketplace([])
      setMarketplaceLoading(false)
      return
    }
    setMarketplaceLoading(true)
    try {
      setMarketplace(await window.electronAPI.listMarketplacePlugins(workspaceSlug))
    } catch (error) {
      console.error('[Proma 插件市场] 加载失败:', error)
      toast.error('加载插件市场失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setMarketplaceLoading(false)
    }
  }, [workspaceSlug])

  const refreshBoth = React.useCallback(async (): Promise<void> => {
    await Promise.all([refresh(), refreshMarketplace()])
  }, [refresh, refreshMarketplace])

  React.useEffect(() => {
    setLoading(true)
    void refresh()
    void refreshMarketplace()
    return () => {
      requestRef.current += 1
    }
  }, [refresh, refreshMarketplace])

  const installFromFolder = React.useCallback(async (): Promise<void> => {
    if (!workspaceSlug || busyAction) return
    setBusyAction('folder')
    try {
      const action = await window.electronAPI.installPluginFromFolder(workspaceSlug)
      if (action.canceled) return
      setPlugins((current) => [
        ...current.filter((plugin) => plugin.id !== action.result.plugin.id),
        action.result.plugin,
      ])
      bumpCapabilitiesVersion((version) => version + 1)
      toast.success('插件已安装', {
        description:
          action.result.plugin.name +
          '：' +
          action.result.installedSkills.length +
          ' 个 Skill，' +
          action.result.installedMcpServers.length +
          ' 个 MCP',
      })
      await refreshBoth()
    } catch (error) {
      console.error('[Proma 插件] 从文件夹安装失败:', error)
      toast.error('插件安装失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [workspaceSlug, busyAction, bumpCapabilitiesVersion, refreshBoth])

  const installFromZip = React.useCallback(async (): Promise<void> => {
    if (!workspaceSlug || busyAction) return
    setBusyAction('zip')
    try {
      const action = await window.electronAPI.installPluginFromZip(workspaceSlug)
      if (action.canceled) return
      setPlugins((current) => [
        ...current.filter((plugin) => plugin.id !== action.result.plugin.id),
        action.result.plugin,
      ])
      bumpCapabilitiesVersion((version) => version + 1)
      toast.success('插件已安装', {
        description:
          action.result.plugin.name +
          '：' +
          action.result.installedSkills.length +
          ' 个 Skill，' +
          action.result.installedMcpServers.length +
          ' 个 MCP',
      })
      await refreshBoth()
    } catch (error) {
      console.error('[Proma 插件] 从压缩包安装失败:', error)
      toast.error('插件安装失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [workspaceSlug, busyAction, bumpCapabilitiesVersion, refreshBoth])

  const installBuiltin = React.useCallback(async (pluginId: string): Promise<void> => {
    if (!workspaceSlug || busyAction) return
    setBusyAction('builtin:' + pluginId)
    try {
      const result = await window.electronAPI.installBuiltinPlugin(workspaceSlug, pluginId)
      setPlugins((current) => [
        ...current.filter((plugin) => plugin.id !== result.plugin.id),
        result.plugin,
      ])
      bumpCapabilitiesVersion((version) => version + 1)
      toast.success('内置插件已安装', { description: result.plugin.name })
      await refreshBoth()
    } catch (error) {
      console.error('[Proma 插件] 安装内置插件失败:', error)
      toast.error('安装内置插件失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [workspaceSlug, busyAction, bumpCapabilitiesVersion, refreshBoth])

  const installMarketplace = React.useCallback(async (pluginId: string): Promise<void> => {
    if (!workspaceSlug || busyAction) return
    setBusyAction('marketplace:' + pluginId)
    try {
      const result = await window.electronAPI.installMarketplacePlugin(workspaceSlug, pluginId)
      setPlugins((current) => [
        ...current.filter((plugin) => plugin.id !== result.plugin.id),
        result.plugin,
      ])
      bumpCapabilitiesVersion((version) => version + 1)
      toast.success('插件已安装', { description: result.plugin.name + ' v' + result.plugin.version })
      await refreshBoth()
    } catch (error) {
      console.error('[Proma 插件市场] 安装失败:', error)
      toast.error('从插件市场安装失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [workspaceSlug, busyAction, bumpCapabilitiesVersion, refreshBoth])

  const publishToMarketplace = React.useCallback(async (plugin: InstalledPromaPlugin): Promise<void> => {
    if (!workspaceSlug || busyAction) return
    setBusyAction('publish:' + plugin.id)
    try {
      const target = await window.electronAPI.publishPluginToMarketplace(workspaceSlug, plugin.id)
      toast.success('已加入插件市场', { description: target })
      await refreshMarketplace()
    } catch (error) {
      console.error('[Proma 插件市场] 加入市场失败:', error)
      toast.error('加入插件市场失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [workspaceSlug, busyAction, refreshMarketplace])

  const openMarketplaceFolder = React.useCallback(async (): Promise<void> => {
    try {
      await window.electronAPI.openMarketplaceFolder()
    } catch (error) {
      console.error('[Proma 插件市场] 打开目录失败:', error)
      toast.error('打开插件市场目录失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [])

  const uninstall = React.useCallback(async (plugin: InstalledPromaPlugin): Promise<void> => {
    if (!workspaceSlug || busyAction) return
    setBusyAction('uninstall:' + plugin.id)
    try {
      const result = await window.electronAPI.uninstallPlugin(workspaceSlug, plugin.id)
      setPlugins((current) => current.filter((item) => item.id !== plugin.id))
      // 先移除所有会话中的插件 Tab，避免卸载后残留无法加载的页面。
      removePluginWorkspaceTabs(plugin.id)
      bumpCapabilitiesVersion((version) => version + 1)
      const kept = result.keptSkills.length + result.keptMcpServers.length
      toast.success('插件已卸载', {
        description: kept > 0
          ? '检测到用户修改过的 Skill 或 MCP，已保留 ' + kept + ' 项未删除；相关插件 Tab 已关闭。'
          : '插件安装的 Skill 与 MCP 已移除，相关插件 Tab 已关闭。',
      })
      await refreshBoth()
    } catch (error) {
      console.error('[Proma 插件] 卸载失败:', error)
      toast.error('卸载插件失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [workspaceSlug, busyAction, bumpCapabilitiesVersion, refreshBoth, removePluginWorkspaceTabs])

  const openFolder = React.useCallback(async (plugin: InstalledPromaPlugin): Promise<void> => {
    if (!workspaceSlug) return
    try {
      await window.electronAPI.openPluginFolder(workspaceSlug, plugin.id)
    } catch (error) {
      console.error('[Proma 插件] 打开目录失败:', error)
      toast.error('打开插件目录失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [workspaceSlug])

  const createTemplate = React.useCallback(async (): Promise<void> => {
    if (busyAction) return
    setBusyAction('template')
    try {
      const directory = await window.electronAPI.createPluginTemplate()
      toast.success('插件模板已创建', { description: directory })
    } catch (error) {
      console.error('[Proma 插件] 创建模板失败:', error)
      toast.error('创建插件模板失败', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyAction(null)
    }
  }, [busyAction])

  const getSettings = React.useCallback(async (pluginId: string): Promise<PromaPluginSettingsSnapshot> => {
    return window.electronAPI.getPluginSettings(workspaceSlug, pluginId)
  }, [workspaceSlug])

  const saveSettings = React.useCallback(async (
    pluginId: string,
    input: SavePromaPluginSettingsInput,
  ): Promise<PromaPluginSettingsSnapshot> => {
    const snapshot = await window.electronAPI.savePluginSettings(workspaceSlug, pluginId, input)
    bumpCapabilitiesVersion((version) => version + 1)
    return snapshot
  }, [workspaceSlug, bumpCapabilitiesVersion])

  return {
    plugins,
    marketplace,
    loading,
    marketplaceLoading,
    busyAction,
    refresh,
    refreshMarketplace,
    installFromFolder,
    installFromZip,
    installBuiltin,
    installMarketplace,
    publishToMarketplace,
    openMarketplaceFolder,
    uninstall,
    openFolder,
    createTemplate,
    getSettings,
    saveSettings,
  }
}
