/**
 * Proma 插件配置存储。
 *
 * 非敏感字段写入插件目录下的 settings.json；password 字段使用 Electron
 * safeStorage 加密后保存，不会写入工作区 mcp.json，也不会返回给渲染进程。
 */

import { safeStorage } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFileSafe, writeTextFileAtomic } from './safe-file'
import { getInstalledPlugin, getPluginsDir, listPlugins, readManifest } from './plugin-manager'
import type {
  PromaPluginSettingField,
  PromaPluginSettingsSchema,
  PromaPluginSettingsSnapshot,
  SavePromaPluginSettingsInput,
} from '@proma/shared'

const SECRET_PREFIX = 'safeStorage:v1:'
const MAX_SECRET_LENGTH = 8192

interface StoredPluginSettings {
  values: Record<string, string | number | boolean>
  secrets: Record<string, string>
}

function getSettingsPath(pluginId: string): string {
  const directory = join(getPluginsDir(), pluginId)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return join(directory, 'settings.json')
}

function readStoredSettings(pluginId: string): StoredPluginSettings {
  const data = readJsonFileSafe<StoredPluginSettings>(getSettingsPath(pluginId))
  if (!data || typeof data !== 'object') return { values: {}, secrets: {} }
  return {
    values: data.values && typeof data.values === 'object' && !Array.isArray(data.values) ? data.values : {},
    secrets: data.secrets && typeof data.secrets === 'object' && !Array.isArray(data.secrets) ? data.secrets : {},
  }
}

function writeStoredSettings(pluginId: string, settings: StoredPluginSettings): void {
  writeTextFileAtomic(getSettingsPath(pluginId), JSON.stringify(settings, null, 2))
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法保存插件密钥。请恢复系统 Keychain/Secret Service 后重试。')
  }
  return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value: string): string | undefined {
  if (!value) return undefined
  if (!value.startsWith(SECRET_PREFIX)) return value
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'))
  } catch (error) {
    console.warn('[Proma 插件配置] 解密密钥失败:', error)
    return undefined
  }
}

function getSchema(workspaceSlug: string, pluginId: string): PromaPluginSettingsSchema {
  const plugin = getInstalledPlugin(workspaceSlug, pluginId)
  const manifest = readManifest(plugin.directory)
  if (!manifest.settings || manifest.settings.fields.length === 0) {
    throw new Error('插件没有配置项: ' + pluginId)
  }
  return manifest.settings
}

function defaultValue(field: PromaPluginSettingField): string | number | boolean {
  if (field.default !== undefined) return field.default
  if (field.type === 'boolean') return false
  if (field.type === 'number') return field.min ?? 0
  if (field.type === 'select') return field.options?.[0]?.value ?? ''
  return ''
}

function normalizeFieldValue(field: PromaPluginSettingField, value: unknown): string | number | boolean {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('配置项 ' + field.label + ' 必须是布尔值')
    return value
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('配置项 ' + field.label + ' 必须是数字')
    }
    if (field.min !== undefined && value < field.min) throw new Error('配置项 ' + field.label + ' 不能小于 ' + field.min)
    if (field.max !== undefined && value > field.max) throw new Error('配置项 ' + field.label + ' 不能大于 ' + field.max)
    return value
  }
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (field.type === 'select' && !field.options?.some((option) => option.value === text)) {
    throw new Error('配置项 ' + field.label + ' 的值不在可选范围内')
  }
  return text
}

export function getPluginSettingsSnapshot(workspaceSlug: string, pluginId: string): PromaPluginSettingsSnapshot {
  const schema = getSchema(workspaceSlug, pluginId)
  const stored = readStoredSettings(pluginId)
  const values: Record<string, string | number | boolean> = {}
  const configuredSecrets: string[] = []

  for (const field of schema.fields) {
    if (field.type === 'password') {
      if (typeof stored.secrets[field.key] === 'string' && stored.secrets[field.key]) {
        configuredSecrets.push(field.key)
      }
      continue
    }
    try {
      const value = stored.values[field.key] !== undefined
        ? stored.values[field.key]
        : defaultValue(field)
      values[field.key] = normalizeFieldValue(field, value)
    } catch {
      values[field.key] = defaultValue(field)
    }
  }

  return { pluginId, schema, values, configuredSecrets }
}

export function savePluginSettings(
  workspaceSlug: string,
  pluginId: string,
  input: SavePromaPluginSettingsInput,
): PromaPluginSettingsSnapshot {
  const schema = getSchema(workspaceSlug, pluginId)
  const stored = readStoredSettings(pluginId)
  const next: StoredPluginSettings = {
    values: { ...stored.values },
    secrets: { ...stored.secrets },
  }
  const inputValues = input && input.values && typeof input.values === 'object' ? input.values : {}
  const clearSecrets = new Set(Array.isArray(input?.clearSecrets) ? input.clearSecrets : [])

  for (const field of schema.fields) {
    if (field.type === 'password') {
      if (clearSecrets.has(field.key)) {
        delete next.secrets[field.key]
        continue
      }
      const raw = inputValues[field.key]
      if (typeof raw === 'string' && raw.trim()) {
        const secret = raw.trim()
        if (secret.length > MAX_SECRET_LENGTH) throw new Error('配置项 ' + field.label + ' 过长')
        next.secrets[field.key] = encryptSecret(secret)
      } else if (field.required && !next.secrets[field.key]) {
        throw new Error('请填写 ' + field.label)
      }
      continue
    }

    const raw = inputValues[field.key]
    if (raw === undefined) {
      if (field.required) throw new Error('请填写 ' + field.label)
      continue
    }
    const value = normalizeFieldValue(field, raw)
    if (field.required && value === '') throw new Error('请填写 ' + field.label)
    next.values[field.key] = value
  }

  writeStoredSettings(pluginId, next)
  return getPluginSettingsSnapshot(workspaceSlug, pluginId)
}

/** 返回某个 MCP server 所属插件的配置环境变量；不会把密钥写入 mcp.json。 */
export function getPluginSettingsEnv(
  workspaceSlug: string | undefined,
  mcpServerName: string,
): Record<string, string> | undefined {
  if (!workspaceSlug || !mcpServerName) return undefined

  let plugin
  try {
    plugin = listPlugins(workspaceSlug).find((item) => item.mcpServers.includes(mcpServerName))
  } catch {
    return undefined
  }
  if (!plugin) return undefined

  let schema: PromaPluginSettingsSchema | undefined
  try {
    schema = readManifest(plugin.directory).settings
  } catch {
    return undefined
  }
  if (!schema) return undefined

  const stored = readStoredSettings(plugin.id)
  const env: Record<string, string> = {}
  for (const field of schema.fields) {
    if (!field.env) continue
    let value: string | number | boolean | undefined
    if (field.type === 'password') {
      const encrypted = stored.secrets[field.key]
      if (!encrypted) continue
      value = decryptSecret(encrypted)
    } else {
      value = stored.values[field.key]
    }
    if (value === undefined || value === '') continue
    env[field.env] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  }
  return Object.keys(env).length > 0 ? env : undefined
}
