#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { loadConfig } from './lib/config.mjs'
import { fetchPage } from './lib/fetch-page.mjs'
import { searchWeb } from './lib/search.mjs'

const SERVER_NAME = 'proma-web-search'
const SERVER_VERSION = '1.0.0'
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'search_web',
    description: '搜索公网网页。默认使用 Proma 本地搜索（Bing），也可配置 Brave、Tavily 或 DeepSeek API Key。返回 { provider, results, note }。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 2000,
          description: '搜索关键词，保留用户意图，不要自行扩写。',
        },
        provider: {
          type: 'string',
          enum: ['auto', 'cindy', 'bing', 'brave', 'tavily', 'deepseek'],
          description: '搜索源。通常省略；cindy 在 Proma 中等同于 auto。',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: '返回条数，默认 5，最多 10。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: '读取一个经用户确认可公开访问的网页正文。配置 Tavily Key 时使用 Tavily Extract，否则使用 Proma 本地正文提取。返回 Markdown 或文本。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          maxLength: 2048,
          description: '要读取的单个公开 HTTP(S) 页面绝对地址，不能包含用户名或密码。',
        },
        confirm_public_url: {
          type: 'boolean',
          description: '仅在用户明确确认 URL 是公开页面、不含会话/重置/签名/webhook 凭证且允许读取后传 true。',
        },
        extract_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: '读取深度，默认 basic；动态页面或表格可用 advanced。',
        },
      },
      required: ['url', 'confirm_public_url'],
    },
  },
]

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function sendResult(id, value) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      isError: value && typeof value === 'object' && value.ok === false,
    },
  })
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function callTool(name, args) {
  if (name === 'search_web') return searchWeb(args || {}, loadConfig())
  if (name === 'fetch_page') return fetchPage(args || {}, loadConfig())
  return { ok: false, errorCode: 'UNKNOWN_TOOL', message: '未知工具：' + name }
}

async function handleRequest(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return
  const id = message.id
  const method = message.method
  if (typeof method !== 'string') return

  if (method === 'initialize') {
    const requested = message.params && typeof message.params.protocolVersion === 'string'
      ? message.params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: '使用 search_web 搜索公网信息，使用 fetch_page 读取用户确认过的公开网页正文。',
      },
    })
    return
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const params = message.params || {}
    if (typeof params.name !== 'string') {
      sendError(id, -32602, 'tools/call 缺少工具名')
      return
    }
    try {
      const result = await callTool(params.name, params.arguments)
      sendResult(id, result)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      process.stderr.write('[proma-web-search] 工具调用失败: ' + text + '\n')
      sendResult(id, { ok: false, errorCode: 'INTERNAL', message: text })
    }
    return
  }

  sendError(id, -32601, 'Method not found: ' + method)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    sendError(null, -32700, 'Parse error')
    return
  }
  void handleRequest(message).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write('[proma-web-search] 请求处理失败: ' + detail + '\n')
    if (message && message.id !== undefined) {
      sendResult(message.id, { ok: false, errorCode: 'INTERNAL', message: detail })
    }
  })
})

input.on('close', () => {
  process.exit(0)
})
