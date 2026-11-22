import AdmZip from 'adm-zip'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, readMarketplaceFolder, readMarketplaceZip, resolveBuiltinPluginSource } from './plugin-manager'

function createManifestDir(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-plugin-manifest-'))
  writeFileSync(join(dir, 'proma-plugin.json'), JSON.stringify(manifest))
  return dir
}

describe('Proma 插件清单', () => {
  test('解析合法清单', () => {
    const dir = createManifestDir({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      description: 'test',
      skills: ['skills/demo'],
      mcpServers: {
        demo: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
    })
    try {
      const manifest = readManifest(dir)
      expect(manifest.id).toBe('my-plugin')
      expect(manifest.name).toBe('My Plugin')
      expect(manifest.version).toBe('1.0.0')
      expect(manifest.skills).toEqual(['skills/demo'])
      expect(manifest.mcpServers?.demo).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝缺少 version 的清单', () => {
    const dir = createManifestDir({ id: 'my-plugin', name: 'My Plugin' })
    try {
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝非法 id', () => {
    const dir = createManifestDir({ id: '../escape', name: 'Bad', version: '1.0.0' })
    try {
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝非数组 skills', () => {
    const dir = createManifestDir({ id: 'my-plugin', name: 'Bad', version: '1.0.0', skills: 'skills/demo' })
    try {
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('解析插件配置 schema', () => {
    const dir = createManifestDir({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      settings: {
        fields: [
          {
            key: 'provider',
            label: 'Provider',
            type: 'select',
            default: 'auto',
            options: [
              { label: 'Auto', value: 'auto' },
              { label: 'Bing', value: 'bing' },
            ],
            env: 'MY_PROVIDER',
          },
          {
            key: 'apiKey',
            label: 'API Key',
            type: 'password',
            env: 'MY_API_KEY',
          },
        ],
      },
    })
    try {
      const manifest = readManifest(dir)
      expect(manifest.settings?.fields).toHaveLength(2)
      expect(manifest.settings?.fields[0]?.env).toBe('MY_PROVIDER')
      expect(manifest.settings?.fields[1]?.type).toBe('password')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝 password 配置项设置 default', () => {
    const dir = createManifestDir({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      settings: {
        fields: [{ key: 'apiKey', label: 'API Key', type: 'password', default: 'secret' }],
      },
    })
    try {
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('解析插件 UI 与侧边栏入口', () => {
    const dir = createManifestDir({
      id: 'proma-todos',
      name: 'Todo',
      version: '1.0.0',
      ui: {
        entry: 'ui/index.html',
        sidebar: { title: 'Todo', icon: 'list-todo', order: 10, replaces: 'todos' },
      },
    })
    try {
      mkdirSync(join(dir, 'ui'), { recursive: true })
      writeFileSync(join(dir, 'ui', 'index.html'), '<!doctype html>')
      const manifest = readManifest(dir)
      expect(manifest.ui?.entry).toBe('ui/index.html')
      expect(manifest.ui?.sidebar?.replaces).toBe('todos')
      expect(manifest.ui?.sidebar?.icon).toBe('list-todo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝不存在的 UI 入口', () => {
    const dir = createManifestDir({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      ui: { entry: 'ui/missing.html' },
    })
    try {
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝越界或非法的 UI 入口', () => {
    const dir = createManifestDir({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      ui: { entry: '../index.html' },
    })
    try {
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝非法的 replaces 值', () => {
    const dir = createManifestDir({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      ui: { entry: 'ui/index.html', sidebar: { title: 'Bad', replaces: 'settings' } },
    })
    try {
      mkdirSync(join(dir, 'ui'), { recursive: true })
      writeFileSync(join(dir, 'ui', 'index.html'), '<!doctype html>')
      expect(() => readManifest(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('解析内置 Todo / 日程插件源目录', () => {
    const todoSource = resolveBuiltinPluginSource('proma-todos')
    expect(todoSource).toBeTruthy()
    expect(existsSync(join(todoSource!, 'proma-plugin.json'))).toBe(true)

    const calendarSource = resolveBuiltinPluginSource('proma-calendar')
    expect(calendarSource).toBeTruthy()
    expect(existsSync(join(calendarSource!, 'proma-plugin.json'))).toBe(true)

    expect(resolveBuiltinPluginSource('proma-web-search')).toBeNull()
  })

  test('解析插件市场文件夹信息', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-marketplace-plugin-'))
    try {
      writeFileSync(join(dir, 'proma-plugin.json'), JSON.stringify({
        id: 'market-plugin',
        name: 'Market Plugin',
        version: '1.2.3',
        description: 'market test',
        author: 'tester',
      }))
      mkdirSync(join(dir, 'skills', 'demo'), { recursive: true })
      writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '# demo')
      writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
        servers: { demo: { command: 'node', args: ['server.js'] } },
      }))

      const item = readMarketplaceFolder(dir, 'marketplace')
      expect(item?.id).toBe('market-plugin')
      expect(item?.version).toBe('1.2.3')
      expect(item?.sourceType).toBe('folder')
      expect(item?.origin).toBe('marketplace')
      expect(item?.skillCount).toBe(1)
      expect(item?.mcpServerCount).toBe(1)
      expect(item?.installedVersion).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('解析插件市场 zip 信息', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-marketplace-zip-'))
    try {
      const zipPath = join(dir, 'market-plugin.zip')
      const zip = new AdmZip()
      zip.addFile('proma-plugin.json', Buffer.from(JSON.stringify({
        id: 'zip-plugin',
        name: 'Zip Plugin',
        version: '2.0.0',
      })))
      zip.addFile('skills/demo/SKILL.md', Buffer.from('# demo'))
      zip.addFile('mcp.json', Buffer.from(JSON.stringify({
        servers: { demo: { command: 'node', args: ['server.js'] } },
      })))
      zip.writeZip(zipPath)

      const item = readMarketplaceZip(zipPath, 'marketplace')
      expect(item?.id).toBe('zip-plugin')
      expect(item?.version).toBe('2.0.0')
      expect(item?.sourceType).toBe('zip')
      expect(item?.skillCount).toBe(1)
      expect(item?.mcpServerCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
