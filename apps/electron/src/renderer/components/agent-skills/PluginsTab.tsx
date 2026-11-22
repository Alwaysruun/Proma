/**
 * PluginsTab — Proma 插件管理
 *
 * 插件 = proma-plugin.json + 可选 Skills + 可选 MCP + 可选 UI。
 * 安装后 Skills/MCP 会进入当前项目，UI 入口可在左侧栏注册；卸载时只移除插件自己安装且未被用户修改的部分。
 */

import * as React from 'react'
import { Download, FileArchive, FolderOpen, Loader2, Package, Plus, RefreshCw, Settings2, Store, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { BUILTIN_PROMA_PLUGINS } from '@proma/shared'
import type { InstalledPromaPlugin, PromaMarketplacePlugin } from '@proma/shared'
import { PluginSettingsDialog } from './PluginSettingsDialog'
import { usePluginsData } from './usePluginsData'

const MANIFEST_EXAMPLE = [
  '{',
  '  "id": "my-plugin",',
  '  "name": "My Plugin",',
  '  "version": "1.0.0",',
  '  "description": "自定义插件",',
  '  "skills": ["skills/my-skill"],',
  '  "mcpServers": {',
  '    "my-mcp": {',
  '      "type": "stdio",',
  '      "command": "node",',
  '      "args": ["$PLUGIN_DIR/server/index.js"]',
  '    }',
  '  },',
  '  "settings": {',
  '    "fields": [',
  '      { "key": "apiKey", "label": "API Key", "type": "password", "env": "MY_API_KEY" }',
  '    ]',
  '  },',
  '  "ui": {',
  '    "entry": "ui/index.html",',
  '    "sidebar": { "title": "我的插件", "icon": "puzzle", "order": 100 }',
  '  }',
  '}',
].join('\n')

const DIRECTORY_EXAMPLE = [
  'my-plugin/',
  '  proma-plugin.json',
  '  skills/',
  '    my-skill/',
  '      SKILL.md',
  '  mcp.json          # 可选',
  '  ui/              # 可选：插件界面',
  '    index.html',
].join('\n')

function formatInstalledAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString()
}

function PluginCard({
  plugin,
  busy,
  publishing,
  onConfigure,
  onOpen,
  onPublish,
  onUninstall,
}: {
  plugin: InstalledPromaPlugin
  busy: boolean
  publishing: boolean
  onConfigure: () => void
  onOpen: () => void
  onPublish: () => void
  onUninstall: () => void
}): React.ReactElement {
  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-border/60 bg-content-area p-4 transition-colors hover:border-border">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2 text-primary">
          <Package size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{plugin.name}</span>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{plugin.version}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{plugin.id}</div>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[40px] text-[13px] leading-6 text-muted-foreground">
        {plugin.description || '暂无描述'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {plugin.skills.length} Skills
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {plugin.mcpServers.length} MCP
        </span>
        {plugin.installedAt && (
          <span className="text-muted-foreground/60">{formatInstalledAt(plugin.installedAt)} 安装</span>
        )}
      </div>

      {(plugin.skills.length > 0 || plugin.mcpServers.length > 0) && (
        <div className="truncate text-[11px] text-muted-foreground/60">
          {[...plugin.skills, ...plugin.mcpServers].join(' · ')}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-end gap-1.5">
        {(plugin.settings?.fields.length ?? 0) > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={onConfigure} disabled={busy}>
            <Settings2 size={14} />
            配置
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onOpen} disabled={busy}>
          <FolderOpen size={14} />
          打开目录
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onPublish} disabled={busy || publishing}>
          {publishing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          加入市场
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onUninstall}
          disabled={busy}
          className="text-muted-foreground hover:text-destructive"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          卸载
        </Button>
      </div>
    </div>
  )
}

function MarketplaceCard({
  item,
  busy,
  onInstall,
}: {
  item: PromaMarketplacePlugin
  busy: boolean
  onInstall: () => void
}): React.ReactElement {
  const installed = item.installedVersion !== null
  const sameVersion = item.installedVersion === item.version
  const actionLabel = installed ? (sameVersion ? '重新安装' : '更新到 v' + item.version) : '安装'
  const originLabel = item.builtin ? '内置' : item.origin === 'project' ? '项目' : '市场'

  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-border/60 bg-content-area p-4 transition-colors hover:border-border">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2 text-primary">
          <Store size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{item.version}
            </span>
            <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              {originLabel}
            </span>
            {item.sourceType === 'zip' && (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                ZIP
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.id}</div>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[40px] text-[13px] leading-6 text-muted-foreground">
        {item.description || '暂无描述'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {item.skillCount} Skills
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {item.mcpServerCount} MCP
        </span>
        {item.hasUi && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">界面</span>
        )}
        {installed && (
          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
            已安装 v{item.installedVersion}
          </span>
        )}
        {installed && !sameVersion && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-primary">可更新</span>
        )}
      </div>

      <div className="truncate text-[11px] text-muted-foreground/60" title={item.source}>
        {item.source}
      </div>

      <div className="mt-auto flex items-center justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={installed && sameVersion ? 'outline' : 'default'}
          onClick={onInstall}
          disabled={busy}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : installed ? <RefreshCw size={14} /> : <Download size={14} />}
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}

export function PluginsTab({
  workspaceSlug,
  search,
}: {
  workspaceSlug: string
  search: string
}): React.ReactElement {
  const data = usePluginsData(workspaceSlug)
  const [view, setView] = React.useState<'installed' | 'marketplace'>('installed')
  const [pendingUninstall, setPendingUninstall] = React.useState<InstalledPromaPlugin | null>(null)
  const [settingsPlugin, setSettingsPlugin] = React.useState<InstalledPromaPlugin | null>(null)

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return data.plugins
    return data.plugins.filter((plugin) =>
      [plugin.name, plugin.id, plugin.description ?? ''].some((value) => value.toLowerCase().includes(query)),
    )
  }, [data.plugins, search])

  const missingBuiltins = React.useMemo(
    () => view === 'installed'
      ? BUILTIN_PROMA_PLUGINS.filter((item) => !data.plugins.some((plugin) => plugin.id === item.id))
      : [],
    [data.plugins, view],
  )

  const marketFiltered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return data.marketplace
    return data.marketplace.filter((plugin) =>
      [plugin.name, plugin.id, plugin.description ?? '', plugin.author ?? ''].some((value) => value.toLowerCase().includes(query)),
    )
  }, [data.marketplace, search])

  if (!workspaceSlug) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        请先在 Agent 模式下选择一个项目，再安装插件。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void data.installFromFolder()}
          disabled={data.busyAction !== null}
        >
          {data.busyAction === 'folder' ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
          从文件夹安装
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void data.installFromZip()}
          disabled={data.busyAction !== null}
        >
          {data.busyAction === 'zip' ? <Loader2 size={14} className="animate-spin" /> : <FileArchive size={14} />}
          从压缩包安装
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void data.createTemplate()}
          disabled={data.busyAction !== null}
        >
          {data.busyAction === 'template' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          创建插件模板
        </Button>
      </div>

      <div className="flex w-fit items-center gap-1 rounded-lg bg-muted/50 p-1">
        <Button
          type="button"
          size="sm"
          variant={view === 'installed' ? 'secondary' : 'ghost'}
          onClick={() => setView('installed')}
        >
          已安装 {data.plugins.length}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === 'marketplace' ? 'secondary' : 'ghost'}
          onClick={() => setView('marketplace')}
        >
          插件市场 {data.marketplace.length}
        </Button>
      </div>

      {!data.loading && missingBuiltins.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-content-area/50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Package size={16} className="text-primary" />
            内置插件
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            Todo 和日程由 Proma 内置插件提供。安装后会出现在左侧栏，也可以随时卸载。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {missingBuiltins.map((item) => {
              const busy = data.busyAction === 'builtin:' + item.id
              return (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void data.installBuiltin(item.id)}
                  disabled={data.busyAction !== null}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  安装 {item.name}
                </Button>
              )
            })}
          </div>
        </div>
      )}

      {view === 'marketplace' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] leading-5 text-muted-foreground">
              市场和仓库里的插件卸载后仍会保留，可随时一键装回。
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void data.openMarketplaceFolder()}>
                <FolderOpen size={14} />
                打开市场目录
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void data.refreshMarketplace()}
                disabled={data.marketplaceLoading}
              >
                {data.marketplaceLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                刷新
              </Button>
            </div>
          </div>

          {data.marketplaceLoading ? (
            <div className="py-20 text-center text-sm text-muted-foreground">加载中...</div>
          ) : marketFiltered.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {marketFiltered.map((item) => (
                <MarketplaceCard
                  key={item.id}
                  item={item}
                  busy={data.busyAction === 'marketplace:' + item.id}
                  onInstall={() => void data.installMarketplace(item.id)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 bg-content-area/40 px-6 py-10">
              <div className="mx-auto max-w-xl space-y-3 text-center">
                <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
                  <Store size={16} className="text-primary" />
                  插件市场还是空的
                </div>
                <p className="text-[13px] leading-6 text-muted-foreground">
                  把插件文件夹或 zip 放进市场目录，或者在“已安装”里点“加入市场”。卸载插件不会删除市场里的副本。
                </p>
                <Button type="button" size="sm" onClick={() => void data.openMarketplaceFolder()}>
                  <FolderOpen size={14} />
                  打开市场目录
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : data.loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground">加载中...</div>
      ) : filtered.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              busy={data.busyAction === 'uninstall:' + plugin.id}
              publishing={data.busyAction === 'publish:' + plugin.id}
              onConfigure={() => setSettingsPlugin(plugin)}
              onOpen={() => void data.openFolder(plugin)}
              onPublish={() => void data.publishToMarketplace(plugin)}
              onUninstall={() => setPendingUninstall(plugin)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/70 bg-content-area/40 px-6 py-10">
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Package size={16} className="text-primary" />
              {data.plugins.length === 0 ? '还没有安装插件' : '没有匹配的插件'}
            </div>
            <p className="text-[13px] leading-6 text-muted-foreground">
              插件可以携带 Skills、MCP 服务器和自定义界面。安装后能力会注册到当前项目，界面可按清单出现在左侧栏；卸载时只移除插件安装且未被修改的内容。
            </p>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">最小目录结构</p>
              <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 text-[12px] leading-5 text-foreground/80">
                {DIRECTORY_EXAMPLE}
              </pre>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">proma-plugin.json</p>
              <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 text-[12px] leading-5 text-foreground/80">
                {MANIFEST_EXAMPLE}
              </pre>
            </div>
            <p className="text-xs leading-5 text-muted-foreground/70">
              MCP 的 command、args、env、url 和 headers 支持 <code className="rounded bg-muted px-1 py-0.5">$PLUGIN_DIR</code>，
              安装时会替换成插件缓存目录。也可以直接使用插件的“创建插件模板”按钮生成一份可编辑的示例。
            </p>
            <p className="text-xs leading-5 text-muted-foreground/70">
              开发插件界面不需要启动 Electron：在仓库运行 <code className="rounded bg-muted px-1 py-0.5">bun run plugins:preview plugins/&lt;目录&gt;</code>，
              浏览器会打开带模拟数据的预览页。
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingUninstall !== null}
        onOpenChange={(open) => { if (!open) setPendingUninstall(null) }}
        title={'卸载插件「' + (pendingUninstall?.name ?? '') + '」？'}
        description="插件安装的 Skills 和 MCP 会被移除；如果内容已被你修改，Proma 会保留修改过的部分。"
        confirmLabel="卸载"
        loadingLabel="卸载中..."
        loading={pendingUninstall !== null && data.busyAction === 'uninstall:' + pendingUninstall.id}
        onConfirm={async () => {
          if (!pendingUninstall) return
          await data.uninstall(pendingUninstall)
          setPendingUninstall(null)
        }}
      />

      <PluginSettingsDialog
        open={settingsPlugin !== null}
        onOpenChange={(open) => { if (!open) setSettingsPlugin(null) }}
        plugin={settingsPlugin}
        getSettings={data.getSettings}
        saveSettings={data.saveSettings}
        onSaved={() => void data.refresh()}
      />
    </div>
  )
}
