/**
 * 独立插件预览服务器。
 *
 * 不启动 Electron 开发环境，直接运行：
 *   bun run plugins:preview plugins/proma-todos
 *
 * 页面使用 /__proma__/bridge.js 的模拟实现，数据保存在浏览器 localStorage。
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { PLUGIN_UI_BRIDGE_SCRIPT } from '../packages/shared/src/utils/plugin-ui-bridge'

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const BLUE = '\x1b[34m'
const MUTED = '\x1b[90m'
const RED = '\x1b[31m'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

interface ManifestShape {
  name?: string
  version?: string
  ui?: { entry?: string }
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: bun run plugins:preview <插件目录> [--port=5174]')
  process.exit(0)
}

const portArg = args.find((arg) => arg.startsWith('--port='))
const port = portArg ? Number(portArg.slice('--port='.length)) : 5174
const dirArg = args.find((arg) => !arg.startsWith('-')) ?? 'plugins/proma-todos'
const root = resolve(process.cwd(), dirArg)
const manifestPath = join(root, 'proma-plugin.json')

if (!existsSync(manifestPath)) {
  console.error(RED + '找不到插件清单: ' + manifestPath + RESET)
  process.exit(1)
}

let manifest: ManifestShape
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestShape
} catch (error) {
  console.error(RED + '插件清单不是有效的 JSON: ' + String(error) + RESET)
  process.exit(1)
}

const entry = (manifest.ui?.entry ?? 'ui/index.html').replace(/\\/g, '/')
const entryPath = join(root, entry)
if (!existsSync(entryPath)) {
  console.error(RED + '插件 UI 入口不存在: ' + entryPath + RESET)
  process.exit(1)
}

const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()

function broadcastReload(): void {
  for (const client of reloadClients) {
    try {
      client.enqueue(encoder.encode('data: reload\n\n'))
    } catch {
      reloadClients.delete(client)
    }
  }
}

let watchTimer: ReturnType<typeof setInterval> | null = null
try {
  const watcher = watch(root, { recursive: true }, () => broadcastReload())
  watcher.on('error', () => undefined)
} catch {
  const mtimes = new Map<string, number>()
  watchTimer = setInterval(() => {
    let changed = false
    const visit = (dir: string): void => {
      for (const entryName of readdirSync(dir)) {
        if (entryName === 'node_modules' || entryName === '.git') continue
        const target = join(dir, entryName)
        const info = statSync(target)
        if (info.isDirectory()) { visit(target); continue }
        const previous = mtimes.get(target)
        if (previous !== undefined && previous !== info.mtimeMs) changed = true
        mtimes.set(target, info.mtimeMs)
      }
    }
    visit(root)
    if (changed) broadcastReload()
  }, 1500)
}

function isInside(target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function injectReload(html: string): string {
  const script = '<script>new EventSource("/__proma__/events").onmessage=function(){location.reload()}</script>'
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/__proma__/bridge.js') {
      return new Response(PLUGIN_UI_BRIDGE_SCRIPT, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    if (url.pathname === '/__proma__/events') {
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller
          reloadClients.add(controller)
          controller.enqueue(encoder.encode('data: connected\n\n'))
        },
        cancel() {
          if (controllerRef) reloadClients.delete(controllerRef)
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      })
    }

    if (url.pathname === '/') {
      return Response.redirect('/' + entry.split('/').map((segment) => encodeURIComponent(segment)).join('/'), 302)
    }

    let relativePath: string
    try {
      relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return new Response('路径编码无效', { status: 400 })
    }
    const target = resolve(root, relativePath)
    if (!isInside(target)) return new Response('路径越界', { status: 403 })
    if (!existsSync(target)) return new Response('文件不存在: /' + relativePath, { status: 404 })
    const info = statSync(target)
    if (!info.isFile()) return new Response('不是文件: /' + relativePath, { status: 404 })

    const contentType = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const body = readFileSync(target)
    if (contentType.startsWith('text/html')) {
      return new Response(injectReload(body.toString('utf-8')), {
        headers: {
          'content-type': contentType,
          'cache-control': 'no-store',
        },
      })
    }
    return new Response(body, {
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
      },
    })
  },
})

const url = 'http://127.0.0.1:' + server.port
console.log('')
console.log(BOLD + BLUE + 'Proma 插件预览' + RESET)
console.log(MUTED + '插件: ' + RESET + (manifest.name ?? '未命名') + ' ' + (manifest.version ?? ''))
console.log(MUTED + '目录: ' + RESET + root)
console.log(MUTED + '入口: ' + RESET + '/' + entry)
console.log(MUTED + '地址: ' + RESET + BOLD + url + RESET)
console.log(MUTED + '数据: 浏览器 localStorage（不会写入 Proma 数据库）' + RESET)
console.log(MUTED + '修改 ui/ 下的文件后页面会自动刷新。按 Ctrl+C 停止。' + RESET)
console.log('')

process.on('SIGINT', () => {
  if (watchTimer) clearInterval(watchTimer)
  server.stop(true)
  process.exit(0)
})
