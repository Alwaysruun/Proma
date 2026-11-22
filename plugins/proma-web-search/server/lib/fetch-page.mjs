import { lookup } from 'node:dns/promises'
import { htmlToMarkdown } from './html.mjs'
import { requestText } from './http.mjs'

const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract'
const MAX_URL_CHARS = 2048
const MAX_CONTENT_CHARS = 50000
const MAX_RESPONSE_CHARS = 1000000
const FETCH_TIMEOUT_MS = 55000

function fail(errorCode, message) {
  return { ok: false, errorCode, message }
}

function stripBrackets(value) {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

export function isPrivateIp(address) {
  const value = String(address || '').toLowerCase().split('%')[0]
  if (!value) return true

  if (value.includes('.')) {
    const parts = value.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
    const [a, b, c] = parts
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) return true
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true
    if (a === 203 && b === 0 && c === 113) return true
    return false
  }

  if (value === '::' || value === '::1') return true
  if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7))
  if (/^(fc|fd|fe[89ab]|ff)/.test(value)) return true
  if (value.startsWith('2001:db8:')) return true
  return false
}

function isClearlyNonPublicHostname(hostname) {
  const host = stripBrackets(hostname)
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true
  if (host.includes(':')) return isPrivateIp(host)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateIp(host)
  return false
}

export function parsePublicPageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) return null
  if (value !== value.trim() || value.includes('\\')) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password || !parsed.hostname) return null
    if (isClearlyNonPublicHostname(parsed.hostname)) return null
    parsed.hash = ''
    return parsed.href
  } catch {
    return null
  }
}

async function resolvePublicUrl(value) {
  const parsed = parsePublicPageUrl(value)
  if (!parsed) throw new Error('url 必须是最多 2048 字符、不含凭证的公开 HTTP(S) 绝对地址。')

  const url = new URL(parsed)
  if (!url.hostname.includes(':') && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true })
    if (addresses.length === 0 || addresses.some((item) => isPrivateIp(item.address))) {
      throw new Error('该 URL 指向内网或本机地址，已拒绝读取。')
    }
  }
  return parsed
}

function tavilyHttpError(status) {
  if (status === 401) return 'Tavily API Key 无效或未配置，请检查 Key。'
  if (status === 403) return 'Tavily 拒绝了正文读取请求，请检查 API Key 权限。'
  if (status === 429) return 'Tavily 请求过于频繁，请稍后重试。'
  if (status === 432 || status === 433) return 'Tavily 额度不足，请检查账户。'
  if (status >= 500) return 'Tavily 正文读取服务暂时不可用，请稍后重试。'
  return 'Tavily 无法处理这个网页。'
}

async function tavilyExtract(url, depth, config) {
  const response = await requestText(TAVILY_EXTRACT_URL, {
    method: 'POST',
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_CHARS,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer ' + config.providers.tavily.apiKey,
    },
    body: JSON.stringify({
      urls: url,
      extract_depth: depth,
      include_images: false,
      include_favicon: false,
      format: 'markdown',
      timeout: depth === 'advanced' ? 45 : 20,
    }),
  })

  if (!response.ok) return fail('HTTP_ERROR', tavilyHttpError(response.status))
  if (response.truncated) return fail('RESPONSE_TOO_LARGE', 'Tavily 返回的数据过大，无法安全解析。')

  let data
  try {
    data = JSON.parse(response.body)
  } catch {
    return fail('RESPONSE_INVALID', 'Tavily 返回了无法解析的数据。')
  }
  if (!data || !Array.isArray(data.results) || !Array.isArray(data.failed_results)) {
    return fail('RESPONSE_INVALID', 'Tavily 返回的数据格式异常。')
  }
  if (data.results.length === 0 && data.failed_results.length > 0) {
    return fail('PAGE_UNREADABLE', 'Tavily 无法读取这个网页。')
  }
  if (data.results.length !== 1) return fail('RESPONSE_INVALID', 'Tavily 返回了意外的结果数量。')

  const item = data.results[0]
  const resultUrl = parsePublicPageUrl(item && item.url)
  if (!resultUrl || typeof item.raw_content !== 'string') {
    return fail('RESPONSE_INVALID', 'Tavily 返回的网页结果格式异常。')
  }
  const content = item.raw_content.trim()
  if (!content) return fail('PAGE_EMPTY', '网页没有可读取的正文。')

  const contentChars = content.length
  const truncated = contentChars > MAX_CONTENT_CHARS
  return {
    ok: true,
    provider: 'tavily',
    url: resultUrl,
    content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content,
    format: 'markdown',
    extract_depth: depth,
    content_chars: contentChars,
    truncated,
    content_is_untrusted: true,
  }
}

async function nativeFetch(url, depth, config) {
  let current = url
  let response

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    current = await resolvePublicUrl(current)
    response = await requestText(current, {
      redirect: 'manual',
      timeoutMs: config.timeoutMs,
      maxBytes: MAX_RESPONSE_CHARS,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location) return fail('HTTP_ERROR', '网页返回了缺少 Location 的重定向。')
    current = new URL(location, current).href
  }

  if (!response) return fail('NETWORK_ERROR', '网页请求没有返回结果。')
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    return fail('TOO_MANY_REDIRECTS', '网页重定向次数过多。')
  }
  if (!response.ok) return fail('HTTP_ERROR', '网页返回 HTTP ' + response.status + '。')
  if (response.truncated) return fail('RESPONSE_TOO_LARGE', '网页内容超过 1MB，无法安全读取。')

  const contentType = response.contentType.toLowerCase()
  let content
  let format = 'text'
  if (contentType.includes('html') || (!contentType && /<html|<body/i.test(response.body))) {
    content = htmlToMarkdown(response.body)
    format = 'markdown'
  } else if (contentType.includes('json')) {
    try {
      content = JSON.stringify(JSON.parse(response.body), null, 2)
    } catch {
      content = response.body
    }
    format = 'json'
  } else if (contentType.includes('text/') || contentType.includes('xml') || !contentType) {
    content = response.body
  } else {
    return fail('UNSUPPORTED_CONTENT', '暂不支持读取 ' + (contentType || '未知类型') + ' 内容。')
  }

  content = String(content || '').trim()
  if (!content) return fail('PAGE_EMPTY', '网页没有可读取的正文。')
  const contentChars = content.length
  const truncated = contentChars > MAX_CONTENT_CHARS
  return {
    ok: true,
    provider: 'native',
    url: current,
    content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content,
    format,
    extract_depth: depth,
    content_chars: contentChars,
    truncated,
    content_is_untrusted: true,
  }
}

export async function fetchPage(args, config) {
  const requestedUrl = parsePublicPageUrl(args && args.url)
  if (!requestedUrl) {
    return fail('INVALID_INPUT', 'url 必须是最多 2048 字符、不含凭证的公开 HTTP(S) 绝对地址。')
  }
  if (!args || args.confirm_public_url !== true) {
    return fail(
      'CONFIRM_REQUIRED',
      '发送前必须先让用户明确确认：该 URL 是公开页面，完整路径和查询参数不含会话、重置、签名或 webhook 凭证；确认后传 confirm_public_url:true 重试。',
    )
  }

  const depth = args.extract_depth === 'advanced' ? 'advanced' : 'basic'
  if (args.extract_depth !== undefined && args.extract_depth !== 'basic' && args.extract_depth !== 'advanced') {
    return fail('INVALID_INPUT', 'extract_depth 只支持 basic / advanced。')
  }

  try {
    await resolvePublicUrl(requestedUrl)
    if (config.providers.tavily.apiKey) return await tavilyExtract(requestedUrl, depth, config)
    return await nativeFetch(requestedUrl, depth, config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail('NETWORK_ERROR', message)
  }
}
