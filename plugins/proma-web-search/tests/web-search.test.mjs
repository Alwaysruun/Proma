import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../server/lib/config.mjs'
import { isPrivateIp, parsePublicPageUrl } from '../server/lib/fetch-page.mjs'
import { htmlToMarkdown, parseBingResults } from '../server/lib/html.mjs'
import { searchWeb } from '../server/lib/search.mjs'

describe('Bing 结果解析', () => {
  test('解析标题、摘要并还原 Bing 跳转链接', () => {
    const encoded = Buffer.from('https://example.com/article').toString('base64url')
    const html = [
      '<ol id="b_results">',
      '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1' + encoded + '">Example <b>Title</b></a></h2>',
      '<div class="b_caption"><p>Example snippet &amp; more.</p></div></li>',
      '</ol>',
    ].join('')

    expect(parseBingResults(html, 5)).toEqual([
      {
        title: 'Example Title',
        url: 'https://example.com/article',
        snippet: 'Example snippet & more.',
      },
    ])
  })

  test('从 HTML 提取 Markdown 正文', () => {
    const body = '这是一段足够长的正文内容。'.repeat(20)
    const html = '<html><head><title>测试页面</title></head><body><article><h1>标题</h1><p>' + body + '</p></article></body></html>'
    const markdown = htmlToMarkdown(html)
    expect(markdown).toContain('测试页面')
    expect(markdown).toContain('这是一段足够长的正文内容。')
  })
})

describe('公开 URL 校验', () => {
  test('拒绝本机、内网和带凭证的 URL', () => {
    expect(parsePublicPageUrl('http://localhost:3000')).toBeNull()
    expect(parsePublicPageUrl('http://127.0.0.1/a')).toBeNull()
    expect(parsePublicPageUrl('http://192.168.1.10/a')).toBeNull()
    expect(parsePublicPageUrl('https://user:pass@example.com/a')).toBeNull()
  })

  test('接受公开 HTTPS 地址并移除 fragment', () => {
    expect(parsePublicPageUrl('https://example.com/docs?q=1#section')).toBe('https://example.com/docs?q=1')
  })

  test('识别常见私网地址', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true)
    expect(isPrivateIp('172.16.1.1')).toBe(true)
    expect(isPrivateIp('8.8.8.8')).toBe(false)
  })
})

describe('配置', () => {
  test('自动选择已配置的搜索源', () => {
    const config = loadConfig({
      PROMA_WEB_SEARCH_CONFIG_JSON: JSON.stringify({
        defaultProvider: 'auto',
        providers: { tavily: { apiKey: 'tvly-test' } },
      }),
    })
    expect(config.defaultProvider).toBe('tavily')
  })

  test('cindy 作为 auto 兼容别名', () => {
    const config = loadConfig({
      PROMA_WEB_SEARCH_CONFIG_JSON: JSON.stringify({ defaultProvider: 'cindy' }),
    })
    expect(config.defaultProvider).toBe('bing')
  })

  test('未配置 Key 的搜索源返回明确错误', async () => {
    const config = loadConfig({
      PROMA_WEB_SEARCH_CONFIG_JSON: JSON.stringify({ defaultProvider: 'bing' }),
    })
    const result = await searchWeb({ query: 'test', provider: 'brave' }, config)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('NOT_CONFIGURED')
  })
})

describe('MCP 握手', () => {
  test('返回工具清单', async () => {
    const serverPath = fileURLToPath(new URL('../server/index.mjs', import.meta.url))
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() || ''
      lines.push(...parts.filter(Boolean))
    })

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 响应超时')), 5000)
      const check = setInterval(() => {
        if (lines.length >= 2) {
          clearInterval(check)
          clearTimeout(timer)
          resolve(undefined)
        }
      }, 20)
    })

    child.kill()
    const messages = lines.map((line) => JSON.parse(line))
    const list = messages.find((message) => message.id === 2)
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['search_web', 'fetch_page'])
  })
})
