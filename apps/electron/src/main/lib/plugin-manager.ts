/**
 * Proma 插件管理器
 *
 * 插件是一个可安装的能力包：proma-plugin.json + 可选 skills/ + 可选 mcp.json。
 * 安装时把 Skills 复制到当前工作区，把 MCP 配置合并到工作区 mcp.json，
 * 并在 Proma 配置目录中记录归属，便于完整卸载。
 */

import AdmZip from 'adm-zip'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  getAgentWorkspaceBySlug,
  getWorkspaceMcpConfig,
  getWorkspaceSkills,
  normalizeWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
} from './agent-workspace-manager'
import { getConfigDir, getInactiveSkillsDir, getWorkspaceSkillsDir } from './config-paths'
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

  if (skills.length === 0 && Object.keys(mcpServers).length === 0) {
    fail('插件至少需要包含一个 Skill 或 MCP 服务器')
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
      return manifest.settings ? { ...plugin, settings: manifest.settings } : plugin
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
    return manifest.settings ? { ...plugin, settings: manifest.settings } : plugin
  } catch {
    return plugin
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
  })
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
      '',
      '把 mcp.json.example 改名为 mcp.json 即可声明 MCP。',
      'MCP 的 command / args / env / url / headers 中可以使用 $PLUGIN_DIR，安装时会替换成插件缓存目录。',
      '',
      '安装方式：Proma → Agent 技能 → 插件 → 从文件夹安装。',
      '',
    ].join('\n'),
    'utf-8',
  )
  return dir
}
