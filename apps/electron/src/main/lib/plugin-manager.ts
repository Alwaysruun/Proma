/**
 * Proma 插件管理器
 *
 * 插件是一个可安装的能力包：proma-plugin.json + 可选 skills/ + 可选 mcp.json。
 * 安装时把 Skills 复制到当前工作区，把 MCP 配置合并到工作区 mcp.json，
 * 并在 Proma 配置目录中记录归属，便于完整卸载。
 */

import AdmZip from 'adm-zip'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { BUILTIN_PROMA_PLUGINS } from '@proma/shared'
import {
  getAgentWorkspaceBySlug,
  getWorkspaceMcpConfig,
  getWorkspaceSkills,
  normalizeWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
} from './agent-workspace-manager'
import { getAgentWorkspacePath, getConfigDir, getInactiveSkillsDir, getWorkspaceSkillsDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { renameWithRetry, rmSyncWithRetry } from './fs-retry'
import type {
  InstalledPromaPlugin,
  McpServerEntry,
  PluginInstallOptions,
  PluginInstallResult,
  PluginUninstallResult,
  PromaPluginManifest,
  PromaPluginMcpServer,
  PromaPluginSettingField,
  PromaPluginSettingOption,
  PromaPluginSettingsSchema,
  PromaPluginUiSchema,
  PromaMarketplacePlugin,
  WorkspaceMcpConfig,
} from '@proma/shared'

const MANIFEST_NAMES = ['proma-plugin.json', 'plugin.json']
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024
const MAX_PLUGIN_FILES = 3000
const VALID_MCP_TYPES = new Set(['stdio', 'http', 'sse', 'streamableHttp', 'streamable-http', 'streamable_http'])
const VALID_SETTING_TYPES = new Set(['text', 'password', 'number', 'boolean', 'select'])
const SETTING_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const SETTING_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const UI_ICON_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

interface PluginRegistry {
  workspaces: Record<string, InstalledPromaPlugin[]>
}

interface SkillSource {
  slug: string
  directory: string
  fingerprint: string
}

function fail(message: string): never {
  throw new Error(message)
}

export function getPluginsDir(): string {
  const dir = join(getConfigDir(), 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getPluginRegistryPath(): string {
  return join(getPluginsDir(), 'installed.json')
}

function readRegistry(): PluginRegistry {
  const data = readJsonFileSafe<PluginRegistry>(getPluginRegistryPath())
  if (!data || typeof data !== 'object' || !data.workspaces || typeof data.workspaces !== 'object') {
    return { workspaces: {} }
  }
  return data
}

function writeRegistry(registry: PluginRegistry): void {
  writeJsonFileAtomic(getPluginRegistryPath(), registry)
}

function assertWorkspace(workspaceSlug: string): void {
  if (!getAgentWorkspaceBySlug(workspaceSlug)) fail('工作区不存在: ' + workspaceSlug)
}

function hasManifest(dir: string): boolean {
  return MANIFEST_NAMES.some((name) => existsSync(join(dir, name)))
}

function findManifestPath(root: string): string {
  for (const name of MANIFEST_NAMES) {
    const candidate = join(root, name)
    if (existsSync(candidate)) return candidate
  }
  fail('插件根目录缺少 proma-plugin.json')
}

function findPluginRoot(dir: string): string {
  if (hasManifest(dir)) return dir
  const candidates: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue
    const child = join(dir, entry.name)
    if (hasManifest(child)) candidates.push(child)
  }
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) fail('压缩包中找不到插件清单 proma-plugin.json')
  fail('压缩包中包含多个插件，请一次只安装一个插件')
}

function parseSettingOptions(value: unknown, fieldKey: string): PromaPluginSettingOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    fail('插件配置项 ' + fieldKey + ' 的 options 必须是非空数组')
  }
  const seen = new Set<string>()
  const options: PromaPluginSettingOption[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('插件配置项 ' + fieldKey + ' 的 options 格式无效')
    }
    const record = item as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const optionValue = typeof record.value === 'string' ? record.value.trim() : ''
    if (!label || !optionValue || seen.has(optionValue)) {
      fail('插件配置项 ' + fieldKey + ' 的 options 必须包含唯一且非空的 label/value')
    }
    seen.add(optionValue)
    options.push({ label, value: optionValue })
  }
  return options
}

function parsePluginSettings(value: unknown): PromaPluginSettingsSchema | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('插件 settings 必须是对象')
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    fail('插件 settings.fields 必须是非空数组')
  }
  if (raw.fields.length > 50) fail('插件配置项不能超过 50 个')

  const seenKeys = new Set<string>()
  const seenEnv = new Set<string>()
  const fields: PromaPluginSettingField[] = []

  for (const item of raw.fields) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('插件配置项格式无效')
    }
    const record = item as Record<string, unknown>
    const key = typeof record.key === 'string' ? record.key.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const type = typeof record.type === 'string' ? record.type.trim() : ''
    if (!SETTING_KEY_RE.test(key) || seenKeys.has(key)) {
      fail('插件配置项 key 无效或重复: ' + key)
    }
    if (!label) fail('插件配置项 ' + key + ' 缺少 label')
    if (!VALID_SETTING_TYPES.has(type)) {
      fail('插件配置项 ' + key + ' 的 type 无效: ' + type)
    }
    seenKeys.add(key)

    const field: PromaPluginSettingField = {
      key,
      label,
      type: type as PromaPluginSettingField['type'],
    }
    if (typeof record.description === 'string') field.description = record.description.trim()
    if (typeof record.placeholder === 'string') field.placeholder = record.placeholder.trim()
    if (record.required !== undefined) {
      if (typeof record.required !== 'boolean') fail('插件配置项 ' + key + ' 的 required 必须是布尔值')
      field.required = record.required
    }

    if (record.env !== undefined) {
      const env = typeof record.env === 'string' ? record.env.trim() : ''
      if (!SETTING_ENV_RE.test(env)) fail('插件配置项 ' + key + ' 的 env 无效')
      if (seenEnv.has(env)) fail('插件配置项环境变量重复: ' + env)
      seenEnv.add(env)
      field.env = env
    }

    if (type === 'select') {
      field.options = parseSettingOptions(record.options, key)
    } else if (record.options !== undefined) {
      fail('只有 select 配置项可以声明 options: ' + key)
    }

    if (type === 'number') {
      for (const name of ['min', 'max', 'step'] as const) {
        if (record[name] !== undefined) {
          if (typeof record[name] !== 'number' || !Number.isFinite(record[name])) {
            fail('插件配置项 ' + key + ' 的 ' + name + ' 必须是数字')
          }
          field[name] = record[name]
        }
      }
      if (field.step !== undefined && field.step <= 0) fail('插件配置项 ' + key + ' 的 step 必须大于 0')
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        fail('插件配置项 ' + key + ' 的 min 不能大于 max')
      }
    } else {
      for (const name of ['min', 'max', 'step'] as const) {
        if (record[name] !== undefined) fail('只有 number 配置项可以声明 ' + name + ': ' + key)
      }
    }

    if (record.default !== undefined) {
      if (type === 'password') fail('password 配置项不能设置 default: ' + key)
      if (type === 'boolean') {
        if (typeof record.default !== 'boolean') fail('插件配置项 ' + key + ' 的 default 必须是布尔值')
      } else if (type === 'number') {
        if (typeof record.default !== 'number' || !Number.isFinite(record.default)) {
          fail('插件配置项 ' + key + ' 的 default 必须是数字')
        }
        if (field.min !== undefined && record.default < field.min) fail('插件配置项 ' + key + ' 的 default 小于 min')
        if (field.max !== undefined && record.default > field.max) fail('插件配置项 ' + key + ' 的 default 大于 max')
      } else {
        if (typeof record.default !== 'string') fail('插件配置项 ' + key + ' 的 default 必须是字符串')
        if (type === 'select' && !field.options?.some((option) => option.value === record.default)) {
          fail('插件配置项 ' + key + ' 的 default 不在 options 中')
        }
      }
      field.default = record.default
    }

    fields.push(field)
  }

  return { fields }
}

function parsePluginUi(value: unknown, root: string): PromaPluginUiSchema | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('插件 ui 必须是对象')
  }
  const raw = value as Record<string, unknown>
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : ''
  if (!entry) fail('插件 ui.entry 必填')
  if (!/\.html?$/i.test(entry)) fail('插件 ui.entry 必须指向 HTML 文件')
  const entryPath = resolveInside(root, entry, '插件 UI')
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    fail('插件 UI 入口不存在: ' + entry)
  }

  const ui: PromaPluginUiSchema = { entry: entry.replace(/\\/g, '/') }
  if (raw.sidebar !== undefined) {
    if (!raw.sidebar || typeof raw.sidebar !== 'object' || Array.isArray(raw.sidebar)) {
      fail('插件 ui.sidebar 必须是对象')
    }
    const sidebar = raw.sidebar as Record<string, unknown>
    const title = typeof sidebar.title === 'string' ? sidebar.title.trim() : ''
    if (!title) fail('插件 ui.sidebar.title 必填')
    if (title.length > 40) fail('插件 ui.sidebar.title 不能超过 40 个字符')
    const icon = typeof sidebar.icon === 'string' ? sidebar.icon.trim().toLowerCase() : undefined
    if (icon !== undefined && !UI_ICON_RE.test(icon)) {
      fail('插件 ui.sidebar.icon 只能包含小写字母、数字和短横线')
    }
    if (sidebar.order !== undefined && (!Number.isInteger(sidebar.order) || Math.abs(sidebar.order as number) > 10000)) {
      fail('插件 ui.sidebar.order 必须是 -10000 到 10000 之间的整数')
    }
    if (sidebar.replaces !== undefined && sidebar.replaces !== 'todos' && sidebar.replaces !== 'calendar') {
      fail('插件 ui.sidebar.replaces 只能是 todos 或 calendar')
    }
    ui.sidebar = {
      title,
      ...(icon ? { icon } : {}),
      ...(sidebar.order !== undefined ? { order: sidebar.order as number } : {}),
      ...(sidebar.replaces !== undefined ? { replaces: sidebar.replaces as 'todos' | 'calendar' } : {}),
    }
  }
  return ui
}

export function readManifest(root: string): PromaPluginManifest {
  const manifestPath = findManifestPath(root)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    fail('插件清单不是有效的 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('插件清单必须是 JSON 对象')
  const raw = parsed as Record<string, unknown>

  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''

  if (!PLUGIN_ID_RE.test(id)) fail('插件 id 必须由字母、数字、点、下划线或短横线组成，且不超过 64 个字符')
  if (!name) fail('插件缺少 name')
  if (!version) fail('插件缺少 version')

  const manifest: PromaPluginManifest = { id, name, version }
  if (typeof raw.description === 'string') manifest.description = raw.description.trim()
  if (typeof raw.author === 'string') manifest.author = raw.author.trim()
  if (typeof raw.homepage === 'string') manifest.homepage = raw.homepage.trim()

  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills) || raw.skills.some((item) => typeof item !== 'string')) {
      fail('插件 skills 必须是字符串数组')
    }
    manifest.skills = (raw.skills as string[]).map((item) => item.trim()).filter(Boolean)
  }

  if (raw.mcpServers !== undefined) {
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object' || Array.isArray(raw.mcpServers)) {
      fail('插件 mcpServers 必须是对象')
    }
    manifest.mcpServers = raw.mcpServers as Record<string, PromaPluginMcpServer>
  }

  if (raw.settings !== undefined) {
    manifest.settings = parsePluginSettings(raw.settings)
  }

  if (raw.ui !== undefined) {
    manifest.ui = parsePluginUi(raw.ui, root)
  }

  return manifest
}

function resolveInside(root: string, relativePath: string, label: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized || isAbsolute(normalized)) fail(label + ' 路径必须是相对路径: ' + relativePath)
  const target = resolve(root, normalized)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) fail(label + ' 路径越界: ' + relativePath)
  return target
}

function inspectTree(root: string): void {
  let files = 0
  let bytes = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > 20) fail('插件目录层级过深')
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const target = join(dir, entry.name)
      const info = lstatSync(target)
      if (info.isSymbolicLink()) fail('插件不能包含符号链接: ' + relative(root, target))
      if (info.isDirectory()) {
        walk(target, depth + 1)
        continue
      }
      if (!info.isFile()) fail('插件包含不支持的文件类型: ' + relative(root, target))
      files += 1
      bytes += info.size
      if (files > MAX_PLUGIN_FILES) fail('插件文件数量超过上限 ' + MAX_PLUGIN_FILES)
      if (bytes > MAX_PLUGIN_BYTES) fail('插件体积超过上限 ' + Math.round(MAX_PLUGIN_BYTES / 1024 / 1024) + 'MB')
    }
  }

  walk(root, 0)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']'
  const record = value as Record<string, unknown>
  return '{' + Object.keys(record)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableStringify(record[key]))
    .join(',') + '}'
}

function fingerprintText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprintSkill(directory: string): string {
  const skillMd = join(directory, 'SKILL.md')
  if (!existsSync(skillMd)) return ''
  return fingerprintText(readFileSync(skillMd, 'utf-8'))
}

function collectSkills(root: string, manifest: PromaPluginManifest): SkillSource[] {
  const candidates: string[] = []

  if (manifest.skills && manifest.skills.length > 0) {
    for (const entry of manifest.skills) {
      const target = resolveInside(root, entry, 'skills')
      if (!existsSync(target)) fail('Skill 目录不存在: ' + entry)
      if (existsSync(join(target, 'SKILL.md'))) {
        candidates.push(target)
        continue
      }
      for (const child of readdirSync(target, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        const skillDir = join(target, child.name)
        if (existsSync(join(skillDir, 'SKILL.md'))) candidates.push(skillDir)
      }
    }
  } else {
    const skillsRoot = join(root, 'skills')
    if (existsSync(skillsRoot)) {
      for (const child of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        const skillDir = join(skillsRoot, child.name)
        if (existsSync(join(skillDir, 'SKILL.md'))) candidates.push(skillDir)
      }
    }
  }

  const seen = new Set<string>()
  const result: SkillSource[] = []
  for (const directory of candidates) {
    const normalized = resolve(directory)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const slug = basename(normalized)
    if (!SKILL_SLUG_RE.test(slug)) fail('Skill 目录名不合法: ' + slug)
    result.push({ slug, directory: normalized, fingerprint: fingerprintSkill(normalized) })
  }
  return result
}

function collectMcpServers(root: string, manifest: PromaPluginManifest): Record<string, PromaPluginMcpServer> {
  let fromFile: Record<string, PromaPluginMcpServer> = {}
  const mcpPath = join(root, 'mcp.json')
  if (existsSync(mcpPath)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    } catch {
      fail('mcp.json 不是有效的 JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('mcp.json 必须是 JSON 对象')
    const record = parsed as Record<string, unknown>
    const rawServers = record.servers && typeof record.servers === 'object' && !Array.isArray(record.servers)
      ? record.servers
      : record.mcpServers && typeof record.mcpServers === 'object' && !Array.isArray(record.mcpServers)
        ? record.mcpServers
        : record
    fromFile = rawServers as Record<string, PromaPluginMcpServer>
  }
  return { ...fromFile, ...(manifest.mcpServers ?? {}) }
}

function substitutePluginDir(value: unknown, pluginDir: string): unknown {
  if (typeof value === 'string') return value.split('$PLUGIN_DIR').join(pluginDir)
  if (Array.isArray(value)) return value.map((item) => substitutePluginDir(item, pluginDir))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) result[key] = substitutePluginDir(item, pluginDir)
    return result
  }
  return value
}

function normalizeMcpEntries(
  servers: Record<string, PromaPluginMcpServer>,
  pluginDir: string,
): Record<string, McpServerEntry> {
  const substituted = substitutePluginDir(servers, pluginDir) as Record<string, PromaPluginMcpServer>
  for (const [name, entry] of Object.entries(substituted)) {
    if (!MCP_NAME_RE.test(name)) fail('MCP 服务器名不合法: ' + name)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('MCP 配置无效: ' + name)
    if (entry.type !== undefined && !VALID_MCP_TYPES.has(entry.type)) {
      fail('MCP 传输类型不支持: ' + String(entry.type))
    }
    const isRemote = entry.type === 'http' || entry.type === 'sse'
      || entry.type === 'streamableHttp' || entry.type === 'streamable-http' || entry.type === 'streamable_http'
    if (isRemote || (!entry.type && entry.url)) {
      if (typeof entry.url !== 'string' || !entry.url.trim()) fail('远程 MCP 缺少 url: ' + name)
    } else {
      if (typeof entry.command !== 'string' || !entry.command.trim()) fail('stdio MCP 缺少 command: ' + name)
    }
  }

  const normalized = normalizeWorkspaceMcpConfig({
    servers: substituted as unknown as WorkspaceMcpConfig['servers'],
  }).servers

  if (Object.keys(normalized).length !== Object.keys(substituted).length) {
    fail('插件中的 MCP 配置无效或与 Proma 内置 MCP 重名')
  }
  for (const entry of Object.values(normalized)) {
    const record = entry as unknown as { enabled?: unknown }
    if (typeof record.enabled !== 'boolean') record.enabled = false
  }
  return normalized
}

function getPluginCacheDir(id: string, version: string): string {
  return join(getPluginsDir(), id, version)
}

function cachePlugin(root: string, manifest: PromaPluginManifest, source: string): string {
  const target = getPluginCacheDir(manifest.id, manifest.version)
  const markerPath = join(target, '.proma-plugin.json')
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as { id?: unknown; version?: unknown }
      if (marker.id === manifest.id && marker.version === manifest.version) return target
    } catch {
      // 缓存损坏，重新复制
    }
  }

  if (existsSync(target)) rmSyncWithRetry(target, { recursive: true, force: true })
  const staging = target + '.tmp-' + randomBytes(6).toString('hex')
  mkdirSync(dirname(target), { recursive: true })
  cpSync(root, staging, {
    recursive: true,
    filter: (src) => !/(^|[\\/])\.git([\\/]|$)/.test(src),
  })
  writeJsonFileAtomic(join(staging, '.proma-plugin.json'), {
    id: manifest.id,
    version: manifest.version,
    source,
    cachedAt: new Date().toISOString(),
  })
  renameWithRetry(staging, target)
  return target
}

function installPluginFromRoot(
  workspaceSlug: string,
  root: string,
  source: string,
  options: PluginInstallOptions,
): PluginInstallResult {
  assertWorkspace(workspaceSlug)
  const info = lstatSync(root)
  if (!info.isDirectory()) fail('插件路径不是目录: ' + root)
  if (info.isSymbolicLink()) fail('插件根目录不能是符号链接')

  inspectTree(root)
  const manifest = readManifest(root)
  const pluginDir = cachePlugin(root, manifest, source)
  const skills = collectSkills(pluginDir, manifest)
  const rawMcpServers = collectMcpServers(pluginDir, manifest)
  const mcpServers = normalizeMcpEntries(rawMcpServers, pluginDir)

  if (skills.length === 0 && Object.keys(mcpServers).length === 0 && !manifest.ui) {
    fail('插件至少需要包含一个 Skill、MCP 服务器或 UI 入口')
  }

  const registry = readRegistry()
  const previous = (registry.workspaces[workspaceSlug] ?? []).find((plugin) => plugin.id === manifest.id)
  if (previous) {
    if (!options.overwrite) fail('插件已安装: ' + manifest.id + ' ' + previous.version)
    uninstallPlugin(workspaceSlug, manifest.id)
  }

  const activeDir = getWorkspaceSkillsDir(workspaceSlug)
  const inactiveDir = getInactiveSkillsDir(workspaceSlug)
  for (const skill of skills) {
    if (existsSync(join(activeDir, skill.slug)) || existsSync(join(inactiveDir, skill.slug))) {
      fail('同名 Skill 已存在: ' + skill.slug)
    }
  }

  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
  for (const name of Object.keys(mcpServers)) {
    if (mcpConfig.servers[name]) fail('同名 MCP 服务器已存在: ' + name)
  }

  const createdSkills: string[] = []
  try {
    for (const skill of skills) {
      const destination = join(activeDir, skill.slug)
      cpSync(skill.directory, destination, {
        recursive: true,
        filter: (src) => !/(^|[\\/])\.git([\\/]|$)/.test(src),
      })
      createdSkills.push(destination)
    }

    const nextMcpConfig: WorkspaceMcpConfig = {
      servers: { ...mcpConfig.servers, ...mcpServers },
    }
    saveWorkspaceMcpConfig(workspaceSlug, nextMcpConfig)

    const skillFingerprints: Record<string, string> = {}
    for (const skill of skills) skillFingerprints[skill.slug] = skill.fingerprint
    const mcpServerFingerprints: Record<string, string> = {}
    for (const [name, entry] of Object.entries(mcpServers)) {
      mcpServerFingerprints[name] = fingerprintText(stableStringify(entry))
    }

    const record: InstalledPromaPlugin = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      installedAt: new Date().toISOString(),
      source,
      directory: pluginDir,
      skills: skills.map((skill) => skill.slug),
      mcpServers: Object.keys(mcpServers),
      ...(manifest.settings ? { settings: manifest.settings } : {}),
      ...(manifest.ui ? { ui: manifest.ui } : {}),
      skillFingerprints,
      mcpServerFingerprints,
    }

    const nextRegistry = readRegistry()
    nextRegistry.workspaces[workspaceSlug] = [
      ...(nextRegistry.workspaces[workspaceSlug] ?? []).filter((plugin) => plugin.id !== manifest.id),
      record,
    ]
    writeRegistry(nextRegistry)

    console.log('[Proma 插件] 已安装 ' + manifest.id + '@' + manifest.version + ' -> ' + workspaceSlug)
    return {
      plugin: record,
      installedSkills: record.skills,
      installedMcpServers: record.mcpServers,
    }
  } catch (error) {
    for (const directory of createdSkills) {
      try {
        rmSyncWithRetry(directory, { recursive: true, force: true })
      } catch {
        // 回滚失败时保留目录，避免误删用户文件
      }
    }
    try {
      saveWorkspaceMcpConfig(workspaceSlug, mcpConfig)
    } catch {
      // 回滚 MCP 配置失败时保留错误现场
    }
    throw error
  }
}

export function installPluginFromFolder(
  workspaceSlug: string,
  folderPath: string,
  options: PluginInstallOptions = {},
): PluginInstallResult {
  const selected = resolve(folderPath)
  if (!existsSync(selected)) fail('插件目录不存在: ' + folderPath)
  const root = findPluginRoot(selected)
  return installPluginFromRoot(workspaceSlug, root, selected, options)
}

export function installPluginFromZip(
  workspaceSlug: string,
  zipPath: string,
  options: PluginInstallOptions = {},
): PluginInstallResult {
  if (!existsSync(zipPath)) fail('插件压缩包不存在: ' + zipPath)
  const tempDir = join(tmpdir(), 'proma-plugin-' + randomBytes(8).toString('hex'))
  mkdirSync(tempDir, { recursive: true })
  try {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    if (entries.length > MAX_PLUGIN_FILES) fail('压缩包文件数量超过上限 ' + MAX_PLUGIN_FILES)
    let totalBytes = 0
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const entryName = entry.entryName.replace(/\\/g, '/')
      if (entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) fail('压缩包包含绝对路径: ' + entryName)
      if (entryName.split('/').includes('..')) fail('压缩包包含越界路径: ' + entryName)
      totalBytes += entry.header.size
      if (totalBytes > MAX_PLUGIN_BYTES) fail('压缩包体积超过上限 ' + Math.round(MAX_PLUGIN_BYTES / 1024 / 1024) + 'MB')
    }
    zip.extractAllTo(tempDir, true)
    const root = findPluginRoot(tempDir)
    return installPluginFromRoot(workspaceSlug, root, zipPath, options)
  } finally {
    try {
      rmSyncWithRetry(tempDir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不阻塞安装结果
    }
  }
}

export function listPlugins(workspaceSlug: string): InstalledPromaPlugin[] {
  assertWorkspace(workspaceSlug)
  return (readRegistry().workspaces[workspaceSlug] ?? []).map((plugin) => {
    try {
      const manifest = readManifest(plugin.directory)
      return {
        ...plugin,
        ...(manifest.settings ? { settings: manifest.settings } : {}),
        ...(manifest.ui ? { ui: manifest.ui } : {}),
      }
    } catch {
      return plugin
    }
  })
}

export function getInstalledPlugin(workspaceSlug: string, pluginId: string): InstalledPromaPlugin {
  const plugin = (readRegistry().workspaces[workspaceSlug] ?? []).find((item) => item.id === pluginId)
  if (!plugin) fail('插件未安装: ' + pluginId)
  try {
    const manifest = readManifest(plugin.directory)
    return {
      ...plugin,
      ...(manifest.settings ? { settings: manifest.settings } : {}),
      ...(manifest.ui ? { ui: manifest.ui } : {}),
    }
  } catch {
    return plugin
  }
}

/** 协议处理器按 id + 版本定位插件缓存目录；不信任渲染进程传入的绝对路径。 */
export function resolvePluginUiRoot(pluginId: string, version: string): string | null {
  if (!PLUGIN_ID_RE.test(pluginId) || !version) return null
  const registry = readRegistry()
  for (const plugins of Object.values(registry.workspaces)) {
    for (const plugin of plugins) {
      if (plugin.id !== pluginId || plugin.version !== version) continue
      try {
        if (statSync(plugin.directory).isDirectory()) return plugin.directory
      } catch {
        // 缓存目录已损坏时继续查找其他工作区记录
      }
    }
  }
  return null
}

/** 解析 Proma 自带插件的源目录；开发环境与打包环境都可用。 */
export function resolveBuiltinPluginSource(pluginId: string): string | null {
  if (!BUILTIN_PROMA_PLUGINS.some((plugin) => plugin.id === pluginId)) return null
  const candidates = [
    resolve(process.cwd(), 'plugins', pluginId),
    resolve(process.cwd(), '..', 'plugins', pluginId),
    resolve(process.cwd(), '..', '..', 'plugins', pluginId),
  ]
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'builtin-plugins', pluginId))
  return candidates.find((candidate) => existsSync(join(candidate, 'proma-plugin.json'))) ?? null
}

/** 安装一个 Proma 自带插件；源目录不存在时明确报错。 */
export function installBuiltinPlugin(
  workspaceSlug: string,
  pluginId: string,
  options: PluginInstallOptions = {},
): PluginInstallResult {
  const source = resolveBuiltinPluginSource(pluginId)
  if (!source) fail('内置插件资源不存在: ' + pluginId)
  return installPluginFromFolder(workspaceSlug, source, options)
}

/** 用户插件市场目录；卸载插件不会动这里，方便随时重新安装。 */
export function getMarketplaceDir(): string {
  const dir = join(getConfigDir(), 'marketplace')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getProjectPluginDirs(): string[] {
  const candidates = [
    resolve(process.cwd(), 'plugins'),
    resolve(process.cwd(), '..', 'plugins'),
    resolve(process.cwd(), '..', '..', 'plugins'),
  ]
  return [...new Set(candidates)].filter((dir) => existsSync(dir))
}

function isBuiltinPluginId(pluginId: string): boolean {
  return BUILTIN_PROMA_PLUGINS.some((plugin) => plugin.id === pluginId)
}

function countManifestSkills(root: string, manifest: PromaPluginManifest): number {
  if (manifest.skills && manifest.skills.length > 0) return manifest.skills.length
  const skillsRoot = join(root, 'skills')
  if (!existsSync(skillsRoot)) return 0
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .length
}

/** 读取一个插件文件夹的展示信息；无效或缺少清单时返回 null。 */
export function readMarketplaceFolder(
  root: string,
  origin: PromaMarketplacePlugin['origin'],
): PromaMarketplacePlugin | null {
  try {
    const pluginRoot = findPluginRoot(resolve(root))
    const manifest = readManifest(pluginRoot)
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      source: pluginRoot,
      sourceType: 'folder',
      origin,
      builtin: isBuiltinPluginId(manifest.id) || origin === 'builtin',
      installedVersion: null,
      skillCount: countManifestSkills(pluginRoot, manifest),
      mcpServerCount: Object.keys(collectMcpServers(pluginRoot, manifest)).length,
      hasUi: Boolean(manifest.ui),
    }
  } catch (error) {
    console.warn('[Proma 插件市场] 跳过无效插件目录 ' + root + ':', error)
    return null
  }
}

function countZipSkills(
  entries: ReturnType<AdmZip['getEntries']>,
  rootPrefix: string,
  manifest: PromaPluginManifest,
): number {
  if (manifest.skills && manifest.skills.length > 0) return manifest.skills.length
  const slugs = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (!name.startsWith(rootPrefix + 'skills/') || !/\/SKILL\.md$/i.test(name)) continue
    const rest = name.slice((rootPrefix + 'skills/').length)
    const slug = rest.split('/')[0]
    if (slug) slugs.add(slug)
  }
  return slugs.size
}

function countZipMcpServers(entries: ReturnType<AdmZip['getEntries']>, rootPrefix: string): number {
  const manifestEntry = entries.find((entry) => (
    !entry.isDirectory
    && entry.entryName.replace(/\\/g, '/') === rootPrefix + 'mcp.json'
  ))
  let fromFile = 0
  if (manifestEntry) {
    try {
      const parsed = JSON.parse(manifestEntry.getData().toString('utf-8')) as Record<string, unknown>
      const servers = parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
        ? parsed.servers
        : parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
          ? parsed.mcpServers
          : parsed
      fromFile = Object.keys(servers as Record<string, unknown>).length
    } catch {
      fromFile = 0
    }
  }
  return fromFile
}

/** 读取一个插件 zip 的展示信息；不展开压缩包，只读取清单。 */
export function readMarketplaceZip(
  zipPath: string,
  origin: PromaMarketplacePlugin['origin'],
): PromaMarketplacePlugin | null {
  try {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    const manifestEntries = entries.filter((entry) => (
      !entry.isDirectory
      && /^(?:[^/]+\/)?(?:proma-plugin|plugin)\.json$/i.test(entry.entryName.replace(/\\/g, '/'))
    ))
    if (manifestEntries.length === 0) return null
    const roots = new Set(manifestEntries.map((entry) => {
      const name = entry.entryName.replace(/\\/g, '/')
      return name.slice(0, name.lastIndexOf('/') + 1)
    }))
    if (roots.size !== 1) return null
    const chosen = manifestEntries.find((entry) => /proma-plugin\.json$/i.test(entry.entryName))
      ?? manifestEntries[0]!
    const raw = JSON.parse(chosen.getData().toString('utf-8')) as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const version = typeof raw.version === 'string' ? raw.version.trim() : ''
    if (!PLUGIN_ID_RE.test(id) || !name || !version) return null
    const manifest: PromaPluginManifest = { id, name, version }
    const rootPrefix = chosen.entryName.replace(/\\/g, '/').slice(0, chosen.entryName.replace(/\\/g, '/').lastIndexOf('/') + 1)
    const manifestMcp = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
      ? Object.keys(raw.mcpServers as Record<string, unknown>).length
      : 0
    return {
      id,
      name,
      version,
      ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
      ...(typeof raw.author === 'string' && raw.author.trim() ? { author: raw.author.trim() } : {}),
      ...(typeof raw.homepage === 'string' && raw.homepage.trim() ? { homepage: raw.homepage.trim() } : {}),
      source: resolve(zipPath),
      sourceType: 'zip',
      origin,
      builtin: isBuiltinPluginId(id) || origin === 'builtin',
      installedVersion: null,
      skillCount: countZipSkills(entries, rootPrefix, manifest),
      mcpServerCount: Math.max(manifestMcp, countZipMcpServers(entries, rootPrefix)),
      hasUi: Boolean(raw.ui && typeof raw.ui === 'object' && !Array.isArray(raw.ui)),
    }
  } catch {
    return null
  }
}

/** 列出插件市场：用户市场目录、仓库 plugins/ 与 Proma 内置插件。同一 id 只保留最先扫描到的来源。 */
export function listMarketplacePlugins(workspaceSlug: string): PromaMarketplacePlugin[] {
  const installed = new Map(listPlugins(workspaceSlug).map((plugin) => [plugin.id, plugin.version]))
  const found = new Map<string, PromaMarketplacePlugin>()

  const add = (item: PromaMarketplacePlugin | null): void => {
    if (!item || found.has(item.id)) return
    found.set(item.id, { ...item, installedVersion: installed.get(item.id) ?? null })
  }

  const marketplaceDir = getMarketplaceDir()
  for (const entry of readdirSync(marketplaceDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(marketplaceDir, entry.name)
    if (entry.isDirectory()) add(readMarketplaceFolder(path, 'marketplace'))
    else if (/\.zip$/i.test(entry.name)) add(readMarketplaceZip(path, 'marketplace'))
  }

  for (const dir of getProjectPluginDirs()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) add(readMarketplaceFolder(path, 'project'))
      else if (/\.zip$/i.test(entry.name)) add(readMarketplaceZip(path, 'project'))
    }
  }

  for (const plugin of BUILTIN_PROMA_PLUGINS) {
    const source = resolveBuiltinPluginSource(plugin.id)
    if (source) add(readMarketplaceFolder(source, 'builtin'))
  }

  return [...found.values()].sort((a, b) => {
    const originOrder = { builtin: 0, project: 1, marketplace: 2 }
    return originOrder[a.origin] - originOrder[b.origin] || a.name.localeCompare(b.name)
  })
}

/** 从市场来源一键安装；始终以最新扫描结果为准，避免渲染进程传入任意路径。 */
export function installMarketplacePlugin(workspaceSlug: string, pluginId: string): PluginInstallResult {
  const item = listMarketplacePlugins(workspaceSlug).find((plugin) => plugin.id === pluginId)
  if (!item) fail('插件市场中找不到: ' + pluginId)
  if (item.sourceType === 'zip') {
    return installPluginFromZip(workspaceSlug, item.source, { overwrite: true })
  }
  return installPluginFromFolder(workspaceSlug, item.source, { overwrite: true })
}

/** 把已安装插件复制到用户市场目录，卸载后仍可从市场一键装回。 */
export function publishPluginToMarketplace(workspaceSlug: string, pluginId: string): string {
  const plugin = getInstalledPlugin(workspaceSlug, pluginId)
  const source = existsSync(plugin.source) ? plugin.source : plugin.directory
  if (!existsSync(source)) fail('插件源已不存在，无法加入市场: ' + pluginId)
  const info = statSync(source)

  if (info.isDirectory()) {
    const target = join(getMarketplaceDir(), plugin.id)
    if (resolve(source) !== resolve(target)) {
      if (existsSync(target)) rmSyncWithRetry(target, { recursive: true, force: true })
      const staleZip = join(getMarketplaceDir(), plugin.id + '.zip')
      if (existsSync(staleZip)) rmSyncWithRetry(staleZip, { force: true })
      cpSync(source, target, {
        recursive: true,
        filter: (src) => !/(^|[\\/])\.git([\\/]|$)/.test(src),
      })
    }
    return target
  }

  if (info.isFile() && /\.zip$/i.test(source)) {
    const target = join(getMarketplaceDir(), plugin.id + '.zip')
    if (resolve(source) !== resolve(target)) {
      if (existsSync(target)) rmSyncWithRetry(target, { force: true })
      const staleFolder = join(getMarketplaceDir(), plugin.id)
      if (existsSync(staleFolder)) rmSyncWithRetry(staleFolder, { recursive: true, force: true })
      copyFileSync(source, target)
    }
    return target
  }

  fail('不支持的插件来源: ' + source)
}

/**
 * 首次创建工作区时安装内置 Todo / 日程插件。
 * 标记文件确保用户卸载后不会在下次启动时被自动装回。
 */
export function seedBuiltinPlugins(workspaceSlug: string): void {
  let workspaceDir: string
  try {
    workspaceDir = getAgentWorkspacePath(workspaceSlug)
  } catch {
    return
  }
  const marker = join(workspaceDir, '.proma-builtin-plugins-seeded')
  if (existsSync(marker)) return

  const installed = new Set(listPlugins(workspaceSlug).map((plugin) => plugin.id))
  let failed = false
  for (const plugin of BUILTIN_PROMA_PLUGINS) {
    if (installed.has(plugin.id)) continue
    try {
      installBuiltinPlugin(workspaceSlug, plugin.id)
      console.log('[Proma 插件] 已安装内置插件 ' + plugin.id + ' -> ' + workspaceSlug)
    } catch (error) {
      failed = true
      console.warn('[Proma 插件] 内置插件初始化失败 ' + plugin.id + ':', error)
    }
  }
  // 安装失败时不写标记，下次启动还能补装；成功后标记会阻止卸载的插件被装回。
  if (failed) return
  try {
    writeFileSync(marker, new Date().toISOString(), 'utf-8')
  } catch (error) {
    console.warn('[Proma 插件] 写入内置插件标记失败:', error)
  }
}

export function uninstallPlugin(workspaceSlug: string, pluginId: string): PluginUninstallResult {
  assertWorkspace(workspaceSlug)
  const registry = readRegistry()
  const record = (registry.workspaces[workspaceSlug] ?? []).find((item) => item.id === pluginId)
  if (!record) fail('插件未安装: ' + pluginId)

  const removedSkills: string[] = []
  const keptSkills: string[] = []
  const removedMcpServers: string[] = []
  const keptMcpServers: string[] = []

  for (const slug of record.skills) {
    const active = join(getWorkspaceSkillsDir(workspaceSlug), slug)
    const inactive = join(getInactiveSkillsDir(workspaceSlug), slug)
    const directory = existsSync(active) ? active : existsSync(inactive) ? inactive : null
    if (!directory) continue
    if (fingerprintSkill(directory) === record.skillFingerprints[slug]) {
      rmSyncWithRetry(directory, { recursive: true, force: true })
      removedSkills.push(slug)
    } else {
      keptSkills.push(slug)
    }
  }

  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
  let mcpChanged = false
  for (const name of record.mcpServers) {
    const entry = mcpConfig.servers[name]
    if (!entry) continue
    if (fingerprintText(stableStringify(entry)) === record.mcpServerFingerprints[name]) {
      delete mcpConfig.servers[name]
      removedMcpServers.push(name)
      mcpChanged = true
    } else {
      keptMcpServers.push(name)
    }
  }
  if (mcpChanged) saveWorkspaceMcpConfig(workspaceSlug, mcpConfig)

  const nextRegistry = readRegistry()
  nextRegistry.workspaces[workspaceSlug] = (nextRegistry.workspaces[workspaceSlug] ?? [])
    .filter((item) => item.id !== pluginId)
  if (nextRegistry.workspaces[workspaceSlug].length === 0) {
    delete nextRegistry.workspaces[workspaceSlug]
  }
  writeRegistry(nextRegistry)

  console.log('[Proma 插件] 已卸载 ' + pluginId + ' <- ' + workspaceSlug)
  return { removedSkills, keptSkills, removedMcpServers, keptMcpServers }
}

export function createPluginTemplate(): string {
  const dir = join(getPluginsDir(), 'templates', 'hello-plugin')
  if (existsSync(dir)) return dir

  mkdirSync(join(dir, 'skills', 'hello'), { recursive: true })
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeJsonFileAtomic(join(dir, 'proma-plugin.json'), {
    id: 'hello-plugin',
    name: 'Hello Plugin',
    version: '1.0.0',
    description: '示例 Proma 插件：包含一个 Skill，可按需添加 MCP 服务器。',
    skills: ['skills/hello'],
    settings: {
      fields: [
        {
          key: 'exampleValue',
          label: '示例配置',
          type: 'text',
          default: '',
          description: '插件可通过环境变量读取该值。',
          env: 'HELLO_PLUGIN_EXAMPLE_VALUE',
        },
      ],
    },
    ui: {
      entry: 'ui/index.html',
      sidebar: {
        title: 'Hello Plugin',
        icon: 'puzzle',
        order: 100,
      },
    },
  })
  writeFileSync(
    join(dir, 'ui', 'index.html'),
    [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      '  <title>Hello Plugin</title>',
      '  <style>',
      '    body { margin: 0; padding: 24px; background: #f7f7f8; color: #1f2328; font: 14px/1.6 system-ui, sans-serif; }',
      '    .card { max-width: 560px; margin: 0 auto; padding: 20px; border: 1px solid rgba(0,0,0,.08); border-radius: 12px; background: #fff; }',
      '    code { padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.06); }',
      '    @media (prefers-color-scheme: dark) {',
      '      body { background: #17191e; color: #e8eaed; }',
      '      .card { background: #1f2229; border-color: rgba(255,255,255,.1); }',
      '      code { background: rgba(255,255,255,.08); }',
      '    }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div class="card">',
      '    <h1>Hello Plugin</h1>',
      '    <p>这个页面由 <code>ui/index.html</code> 渲染。左侧栏入口来自清单里的 <code>ui.sidebar</code>。</p>',
      '    <p>调用 <code>window.proma.planning</code> 可以读写 Todo 和日程。</p>',
      '  </div>',
      '  <script src="/__proma__/bridge.js"></script>',
      '</body>',
      '</html>',
    ].join('\n'),
    'utf-8',
  )
  writeFileSync(
    join(dir, 'skills', 'hello', 'SKILL.md'),
    [
      '---',
      'name: Hello Plugin',
      'description: 示例插件 Skill。安装后可在 Agent 中通过 /hello-plugin 或提及方式使用。',
      'version: 1.0.0',
      '---',
      '',
      '# Hello Plugin',
      '',
      '这是一个由 Proma 插件模板创建的 Skill。',
      '',
      '你可以修改本文件，或在插件目录中增加 mcp.json 来声明 MCP 服务器。',
      '',
    ].join('\n'),
    'utf-8',
  )
  writeFileSync(
    join(dir, 'mcp.json.example'),
    JSON.stringify({
      servers: {
        'hello-mcp': {
          type: 'stdio',
          command: 'node',
          args: ['$PLUGIN_DIR/server/index.js'],
          enabled: false,
        },
      },
    }, null, 2),
    'utf-8',
  )
  writeFileSync(
    join(dir, 'README.md'),
    [
      '# Proma 插件模板',
      '',
      '目录结构：',
      '',
      '- proma-plugin.json：插件清单',
      '- skills/<slug>/SKILL.md：插件提供的 Skills',
      '- mcp.json：可选，声明 MCP 服务器',
      '- settings：可选，在插件的「配置」对话框展示字段，并通过 env 注入 MCP 子进程',
      '- ui/index.html：可选，插件界面；清单 ui.sidebar 可在左侧栏注册入口',
      '',
      '把 mcp.json.example 改名为 mcp.json 即可声明 MCP。',
      'MCP 的 command / args / env / url / headers 中可以使用 $PLUGIN_DIR，安装时会替换成插件缓存目录。',
      '',
      '安装方式：Proma → Agent 技能 → 插件 → 从文件夹安装。',
      '',
      '界面开发不需要启动 Electron：bun run plugins:preview <本插件目录>。',
      '',
    ].join('\n'),
    'utf-8',
  )
  return dir
}
