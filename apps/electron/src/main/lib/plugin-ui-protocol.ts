/**
 * proma-plugin:// 插件界面协议。
 *
 * URL 结构：proma-plugin://<pluginId>/<version>/<relativePath>
 * 只允许读取已安装插件缓存目录内的文件，拒绝目录穿越，不解析渲染进程给出的绝对路径。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { PLUGIN_UI_BRIDGE_SCRIPT } from '@proma/shared'
import { resolvePluginUiRoot } from './plugin-manager'

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
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const UI_CSP = [
  "default-src 'self' data: blob: https: http:",
  "script-src 'self' 'unsafe-inline' https: http:",
  "style-src 'self' 'unsafe-inline' https: http:",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https: http:",
  "connect-src 'self' https: http:",
  "frame-src 'self' https: http:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function handlePluginUiRequest(request: Request): Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return textResponse('插件地址无效', 400)
  }

  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
  } catch {
    return textResponse('插件路径编码无效', 400)
  }
  if (segments.some((segment) => segment === '..' || segment.includes('\\'))) {
    return textResponse('插件路径越界', 403)
  }

  // 宿主统一的桥接脚本：不占用插件自己的文件命名空间。
  if (segments[0] === '__proma__' && segments[1] === 'bridge.js') {
    return new Response(PLUGIN_UI_BRIDGE_SCRIPT, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  const pluginId = url.hostname
  const version = segments.shift()
  if (!pluginId || !version) return textResponse('插件地址缺少 id 或版本', 400)

  const root = resolvePluginUiRoot(pluginId, version)
  if (!root) return textResponse('插件未安装或已卸载', 404)

  const relativePath = segments.join('/') || 'index.html'
  let target: string
  let realRoot: string
  try {
    realRoot = realpathSync(root)
    target = realpathSync(resolve(root, relativePath))
  } catch {
    return textResponse('插件界面文件不存在', 404)
  }
  if (!isInside(realRoot, target)) return textResponse('插件路径越界', 403)

  let info
  try {
    info = statSync(target)
  } catch {
    return textResponse('插件界面文件不存在', 404)
  }
  if (!info.isFile()) return textResponse('插件界面路径不是文件', 404)

  const contentType = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  try {
    const body = readFileSync(target)
    return new Response(body, {
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(contentType.startsWith('text/html') ? { 'content-security-policy': UI_CSP } : {}),
      },
    })
  } catch {
    return textResponse('读取插件界面失败', 500)
  }
}
