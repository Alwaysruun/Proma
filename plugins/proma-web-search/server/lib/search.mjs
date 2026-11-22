import { getConfigPaths, hasProviderKey, SUPPORTED_PROVIDERS } from './config.mjs'
import { parseBingResults } from './html.mjs'
import { requestText } from './http.mjs'

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'
const TAVILY_URL = 'https://api.tavily.com/search'
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/tools/search'
const PROVIDER_LABELS = {
  bing: 'Bing',
  brave: 'Brave',
  tavily: 'Tavily',
  deepseek: 'DeepSeek',
}

function fail(errorCode, message) {
  return { ok: false, errorCode, message }
}

function clampLimit(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(10, Math.max(1, Math.floor(number)))
}

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider
}

function configHint() {
  return '可在 ' + getConfigPaths()[0] + ' 或 ~/.proma/web-search.json 中配置 API Key。'
}

function parseJson(body) {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

async function searchBing(query, limit, config) {
  const chinese = /[\u3400-\u9fff]/.test(query)
  const params = new URLSearchParams({
    q: query,
    count: String(limit),
    setlang: chinese ? 'zh-hans' : 'en',
    cc: chinese ? 'cn' : 'us',
  })
  const response = await requestText('https://www.bing.com/search?' + params.toString(), {
    timeoutMs: config.timeoutMs,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': chinese ? 'zh-CN,zh;q=0.9,en;q=0.6' : 'en-US,en;q=0.9',
    },
  })

  if (!response.ok) {
    return fail('HTTP_ERROR', 'Bing 返回 HTTP ' + response.status + '，请稍后重试或配置 Brave/Tavily。')
  }

  const results = parseBingResults(response.body, limit)
  if (results.length === 0) {
    if (/captcha|challenge|anomaly|verify you are human/i.test(response.body)) {
      return fail('UPSTREAM_BLOCKED', 'Bing 要求人机验证。请配置 Brave 或 Tavily API Key，或在 Proma 中重试。')
    }
    return fail('NO_RESULTS', 'Bing 没有返回可用结果，请缩短查询或配置 Brave/Tavily。')
  }

  return {
    ok: true,
    provider: 'bing',
    results,
    note: 'Bing 找到 ' + results.length + ' 条结果。',
  }
}

async function searchBrave(query, limit, config) {
  if (!hasProviderKey(config, 'brave')) {
    return fail('NOT_CONFIGURED', '未配置 Brave API Key。' + configHint())
  }
  const params = new URLSearchParams({ q: query, count: String(limit) })
  const response = await requestText(BRAVE_URL + '?' + params.toString(), {
    timeoutMs: config.timeoutMs,
    headers: {
      accept: 'application/json',
      'x-subscription-token': config.providers.brave.apiKey,
    },
  })
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : 'HTTP_ERROR'
    return fail(code, 'Brave 返回 HTTP ' + response.status + '，请检查 API Key 或稍后重试。')
  }
  const data = parseJson(response.body)
  const items = data && data.web && Array.isArray(data.web.results) ? data.web.results : []
  const results = items.slice(0, limit).map((item) => ({
    title: String(item.title || ''),
    url: String(item.url || ''),
    snippet: String(item.description || ''),
  })).filter((item) => item.title && item.url)
  return {
    ok: true,
    provider: 'brave',
    results,
    note: 'Brave 找到 ' + results.length + ' 条结果。',
  }
}

async function searchTavily(query, limit, config) {
  if (!hasProviderKey(config, 'tavily')) {
    return fail('NOT_CONFIGURED', '未配置 Tavily API Key。' + configHint())
  }
  const response = await requestText(TAVILY_URL, {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer ' + config.providers.tavily.apiKey,
    },
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  })
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : 'HTTP_ERROR'
    return fail(code, 'Tavily 返回 HTTP ' + response.status + '，请检查 API Key 或稍后重试。')
  }
  const data = parseJson(response.body)
  const items = data && Array.isArray(data.results) ? data.results : []
  const results = items.slice(0, limit).map((item) => ({
    title: String(item.title || ''),
    url: String(item.url || ''),
    snippet: String(item.content || ''),
  })).filter((item) => item.title && item.url)
  return {
    ok: true,
    provider: 'tavily',
    results,
    note: 'Tavily 找到 ' + results.length + ' 条结果。',
  }
}

function deepSeekFailure(code) {
  const messages = {
    INVALID_INPUT: 'DeepSeek 搜索参数无效，请使用 1–128 个 Unicode 字符的查询后重试。',
    AUTH_REJECTED: 'DeepSeek API Key 无效，请更新 Key。',
    PERMISSION_DENIED: 'DeepSeek 搜索请求未获授权，请检查账号权限。',
    QUOTA_EXHAUSTED: 'DeepSeek 账户余额不足，请充值后再搜索。',
    RATE_LIMITED: 'DeepSeek 搜索请求过于频繁，请稍后重试。',
    UPSTREAM_UNAVAILABLE: 'DeepSeek 搜索服务暂时不可用，请检查网络后重试。',
    UPSTREAM_REJECTED: 'DeepSeek 未接受搜索请求，请检查账号权限或稍后重试。',
    RESPONSE_INVALID: 'DeepSeek 返回的搜索结果格式无效或过大。',
  }
  return fail(code, messages[code] || 'DeepSeek 搜索失败，请稍后重试。')
}

async function searchDeepSeek(query, limit, config) {
  if (!hasProviderKey(config, 'deepseek')) {
    return fail('NOT_CONFIGURED', '未配置 DeepSeek API Key。' + configHint())
  }
  if (Array.from(query).length > 128) return deepSeekFailure('INVALID_INPUT')

  const response = await requestText(DEEPSEEK_URL, {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer ' + config.providers.deepseek.apiKey,
    },
    body: JSON.stringify({ query, count: limit, need_content: false }),
  })
  if (!response.ok) {
    const codes = {
      400: 'INVALID_INPUT',
      401: 'AUTH_REJECTED',
      402: 'QUOTA_EXHAUSTED',
      403: 'PERMISSION_DENIED',
      408: 'UPSTREAM_UNAVAILABLE',
      413: 'INVALID_INPUT',
      429: 'RATE_LIMITED',
    }
    return deepSeekFailure(codes[response.status] || (response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_REJECTED'))
  }
  const data = parseJson(response.body)
  if (!data || !Array.isArray(data.results)) return deepSeekFailure('RESPONSE_INVALID')
  const results = data.results.slice(0, limit).map((item) => ({
    title: String(item.title || ''),
    url: String(item.url || ''),
    snippet: String(item.summary || item.snippet || ''),
  })).filter((item) => item.title && item.url)
  return {
    ok: true,
    provider: 'deepseek',
    results,
    note: 'DeepSeek 找到 ' + results.length + ' 条结果。',
  }
}

export async function searchWeb(args, config) {
  const query = args && typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return fail('INVALID_INPUT', 'query 不能为空。')
  if (query.length > 2000) return fail('INVALID_INPUT', 'query 过长（上限 2000 字符）。')

  const requested = args && typeof args.provider === 'string' ? args.provider.trim().toLowerCase() : ''
  if (requested && requested !== 'cindy' && !SUPPORTED_PROVIDERS.includes(requested)) {
    return fail('INVALID_INPUT', 'provider 只支持 auto / cindy / bing / brave / tavily / deepseek。')
  }

  let provider = requested === 'cindy' || !requested ? config.defaultProvider : requested
  if (provider === 'auto') provider = 'bing'
  const limit = clampLimit(args && args.limit, config.maxResults || 5)

  try {
    if (provider === 'bing') return await searchBing(query, limit, config)
    if (provider === 'brave') return await searchBrave(query, limit, config)
    if (provider === 'tavily') return await searchTavily(query, limit, config)
    if (provider === 'deepseek') return await searchDeepSeek(query, limit, config)
    return fail('INVALID_INPUT', '未知搜索源：' + provider)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail('NETWORK_ERROR', providerLabel(provider) + ' 搜索失败：' + message)
  }
}
