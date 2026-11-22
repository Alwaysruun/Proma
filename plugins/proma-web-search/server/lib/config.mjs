import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = 'proma-web-search'
export const SUPPORTED_PROVIDERS = ['auto', 'bing', 'brave', 'tavily', 'deepseek']

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeProvider(value) {
  if (typeof value !== 'string') return 'auto'
  const provider = value.trim().toLowerCase()
  if (provider === 'cindy') return 'auto'
  return SUPPORTED_PROVIDERS.includes(provider) ? provider : 'auto'
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('[proma-web-search] 读取配置失败 ' + path + ': ' + message + '\n')
    return undefined
  }
}

function mergeConfig(base, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const providers = raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)
    ? raw.providers
    : {}
  const next = {
    ...base,
    defaultProvider: raw.defaultProvider === undefined
      ? base.defaultProvider
      : normalizeProvider(raw.defaultProvider),
    timeoutMs: raw.timeoutMs === undefined
      ? base.timeoutMs
      : clampNumber(raw.timeoutMs, 5000, 120000, base.timeoutMs),
    maxResults: raw.maxResults === undefined
      ? base.maxResults
      : clampNumber(raw.maxResults, 1, 10, base.maxResults),
    providers: {
      brave: { ...base.providers.brave },
      tavily: { ...base.providers.tavily },
      deepseek: { ...base.providers.deepseek },
    },
  }

  for (const name of ['brave', 'tavily', 'deepseek']) {
    const item = providers[name]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.apiKey === 'string') next.providers[name].apiKey = item.apiKey.trim()
  }
  return next
}

export function getPluginDir() {
  return pluginDir
}

export function getConfigPaths(env = process.env) {
  const home = homedir()
  return [
    join(pluginDir, 'config.json'),
    join(home, '.proma', 'web-search.json'),
    join(home, '.proma-dev', 'web-search.json'),
    ...(env.PROMA_WEB_SEARCH_CONFIG ? [env.PROMA_WEB_SEARCH_CONFIG] : []),
  ]
}

export function loadConfig(env = process.env) {
  let config = {
    defaultProvider: 'auto',
    timeoutMs: 30000,
    maxResults: 5,
    providers: {
      brave: { apiKey: '' },
      tavily: { apiKey: '' },
      deepseek: { apiKey: '' },
    },
  }

  for (const path of getConfigPaths(env)) {
    if (existsSync(path)) config = mergeConfig(config, readJson(path))
  }

  if (env.PROMA_WEB_SEARCH_CONFIG_JSON) {
    try {
      config = mergeConfig(config, JSON.parse(env.PROMA_WEB_SEARCH_CONFIG_JSON))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write('[proma-web-search] PROMA_WEB_SEARCH_CONFIG_JSON 不是有效 JSON: ' + message + '\n')
    }
  }

  if (env.PROMA_WEB_SEARCH_PROVIDER || env.PROMA_WEB_SEARCH_DEFAULT_PROVIDER) {
    config.defaultProvider = normalizeProvider(env.PROMA_WEB_SEARCH_PROVIDER || env.PROMA_WEB_SEARCH_DEFAULT_PROVIDER)
  }
  if (env.PROMA_WEB_SEARCH_TIMEOUT_MS) {
    config.timeoutMs = clampNumber(env.PROMA_WEB_SEARCH_TIMEOUT_MS, 5000, 120000, config.timeoutMs)
  }
  if (env.PROMA_WEB_SEARCH_MAX_RESULTS) {
    config.maxResults = clampNumber(env.PROMA_WEB_SEARCH_MAX_RESULTS, 1, 10, config.maxResults)
  }

  for (const name of ['brave', 'tavily', 'deepseek']) {
    const envName = name.toUpperCase() + '_API_KEY'
    if (env[envName]) config.providers[name].apiKey = String(env[envName]).trim()
  }

  if (config.defaultProvider === 'auto') {
    if (config.providers.tavily.apiKey) config.defaultProvider = 'tavily'
    else if (config.providers.brave.apiKey) config.defaultProvider = 'brave'
    else if (config.providers.deepseek.apiKey) config.defaultProvider = 'deepseek'
    else config.defaultProvider = 'bing'
  }

  return config
}

export function hasProviderKey(config, provider) {
  return Boolean(config.providers?.[provider]?.apiKey)
}
