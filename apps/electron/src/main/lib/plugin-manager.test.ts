import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest } from './plugin-manager'

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
})
