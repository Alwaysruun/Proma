const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

function getCharset(contentType, buffer) {
  const fromHeader = /charset\s*=\s*[']?([^;'\s]+)/i.exec(contentType || '')
  if (fromHeader) return fromHeader[1].trim().toLowerCase()

  const head = buffer.subarray(0, 4096).toString('latin1')
  const fromMeta = /<meta[^>]+charset\s*=\s*[']?([^'\s/>]+)/i.exec(head)
  return fromMeta ? fromMeta[1].trim().toLowerCase() : 'utf-8'
}

function decodeBuffer(buffer, contentType) {
  const charset = getCharset(contentType, buffer)
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

async function readBody(response, maxBytes) {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      const remaining = Math.max(0, maxBytes - (total - value.byteLength))
      if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // 读取已结束，忽略取消错误。
      }
      break
    }
    chunks.push(Buffer.from(value))
  }

  return { buffer: Buffer.concat(chunks), truncated }
}

export async function requestText(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
        accept: '*/*',
        ...(options.headers || {}),
      },
      body: options.body,
      redirect: options.redirect || 'follow',
      signal: controller.signal,
    })

    const { buffer, truncated } = await readBody(response, maxBytes)
    const contentType = response.headers.get('content-type') || ''
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      contentType,
      url: response.url,
      body: decodeBuffer(buffer, contentType),
      truncated,
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('请求超时（' + timeoutMs + 'ms）')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
