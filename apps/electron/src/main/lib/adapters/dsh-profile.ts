/**
 * DeepSeek Harness 独立 profile 生成。
 *
 * Proma 不修改用户全局的 DSH 配置，而是在自己的配置目录下维护一个
 * 'proma' profile：写入 llm-pi-ai 路由、ACP 默认模型和 Windows 下的
 * 非沙箱 pwsh 执行器。每次启动前重建，配置变化时由适配器重启侧车进程。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ProviderType } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { normalizePiBaseUrl, resolvePiApi } from './pi-model-registry'

/** ACP 中选择模型时使用的 provider 路由名 */
export const DSH_ROUTE_NAME = 'proma'
/** 子进程注入 API Key 的环境变量名 */
export const DSH_API_KEY_ENV = 'PROMA_DSH_API_KEY'
/** Proma 私有的 DSH profile 名 */
export const DSH_PROFILE_NAME = 'proma'

/** OAuth 渠道无法用环境变量注入凭据，暂不支持 */
const UNSUPPORTED_PROVIDERS = new Set<ProviderType>([
  'openai-codex',
  'github-copilot',
  'xai',
  'opencode-go-openai',
])

/** Anthropic Messages 只接受 Bearer 认证的渠道 */
const BEARER_ONLY_PROVIDERS = new Set<ProviderType>([
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'minimax',
  'qwen-anthropic',
  'xiaomi-token-plan',
])

export interface DshModelSpec {
  id: string
  name?: string
  contextWindow?: number
}

export interface DshProfileInput {
  provider: ProviderType
  baseUrl?: string
  models: DshModelSpec[]
  defaultModel: string
}

export interface DshProfileResult {
  dshHome: string
  dshBinPath: string
  nodePath?: string
  profileHash: string
}

export function isDshProviderSupported(provider: ProviderType): boolean {
  return !UNSUPPORTED_PROVIDERS.has(provider)
}

/**
 * 解析随 DSH 运行时一起安装的 Node。
 * Electron 43.2 不在 dsh 原生模块的受支持列表内，因此 DSH 必须用独立 Node 启动。
 */
export function resolveDshNodePath(): string | undefined {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'dsh-runtime', 'node_modules', 'node', 'bin', executable)]
    : [join(app.getAppPath(), 'dsh-runtime', 'node_modules', 'node', 'bin', executable)]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const fromEnv = process.env.PROMA_DSH_NODE?.trim()
  return fromEnv && existsSync(fromEnv) ? fromEnv : undefined
}
/** 获取 Proma 私有 DSH_HOME（开发模式与正式版分别落在 .proma-dev / .proma 下） */
export function getDshHome(): string {
  return join(getConfigDir(), 'deepseek-harness')
}

/**
 * 解析随应用安装的 dsh CLI 入口。
 * 打包后 dsh 位于 app.asar.unpacked，需要把 asar 路径改写成 unpacked 路径，
 * 否则子进程无法执行 asar 内的脚本。
 */
export function resolveDshBinPath(): string {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        join(app.getAppPath(), 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      ]
    : [
        join(app.getAppPath(), 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const requireFromApp = createRequire(join(app.getAppPath(), 'package.json'))
    const manifestPath = requireFromApp.resolve('@deepseek-ai/dsh/package.json')
    const binPath = join(dirname(manifestPath).replace('app.asar', 'app.asar.unpacked'), 'lib', 'bin.js')
    if (existsSync(binPath)) return binPath
  } catch {
    // 继续走统一错误
  }
  throw new Error('未找到 DeepSeek Harness 运行时，请先运行 bun run setup:dsh')
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function buildModelsYaml(models: DshModelSpec[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const model of models) {
    const id = model.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    lines.push('          - id: ' + yamlString(id))
    lines.push('            name: ' + yamlString(model.name?.trim() || id))
    if (model.contextWindow && model.contextWindow > 0) {
      lines.push('            contextWindow: ' + Math.round(model.contextWindow))
    }
  }
  return lines.join('\n')
}

/** 生成 cordis.patch.yml；Windows 上去掉 ACL 沙箱，避免 shell 工具无法启动 */
function buildProfileYaml(input: DshProfileInput): string {
  const api = resolvePiApi(input.provider)
  const baseUrl = normalizePiBaseUrl(input.baseUrl, input.provider, api)
  if (!baseUrl) throw new Error('当前渠道缺少 Base URL，DeepSeek Harness 无法启动')

  const models = input.models.some((model) => model.id === input.defaultModel)
    ? input.models
    : [...input.models, { id: input.defaultModel }]

  const lines: string[] = []
  lines.push('# 由 Proma 自动生成，请勿手动编辑。')
  lines.push('- id: acp')
  lines.push('  config:')
  lines.push('    provider: ' + yamlString(DSH_ROUTE_NAME))
  lines.push('    model: ' + yamlString(input.defaultModel))
  lines.push('')
  lines.push('- id: system-prompt')
  lines.push('  config:')
  lines.push('    personaPrefix: >-')
  lines.push('      You are a coding agent powered by the {{model}} model. You are running inside the Proma desktop app.')
  lines.push('      Work inside the user workspace and prefer the available filesystem and shell tools.')
  lines.push('')

  if (process.platform === 'win32') {
    lines.push('- id: pwsh-sandbox')
    lines.push('  disabled: true')
    lines.push('')
    lines.push('- id: permission')
    lines.push('  disabled: true')
    lines.push('')
    lines.push('- insert:')
    lines.push('    - id: pwsh-local')
    lines.push('      name: ' + yamlString('@deepseek-ai/dsh-pwsh-local'))
    lines.push('')
  }

  lines.push('- id: llm-pi-ai')
  lines.push('  config:')
  lines.push('    providers:')
  lines.push('      ' + DSH_ROUTE_NAME + ':')
  lines.push('        displayName: ' + yamlString('Proma'))
  lines.push('        apiKeyEnv: ' + yamlString(DSH_API_KEY_ENV))
  lines.push('        api: ' + yamlString(api))
  lines.push('        baseURL: ' + yamlString(baseUrl))
  if (BEARER_ONLY_PROVIDERS.has(input.provider)) {
    lines.push("        headers: !!js \"({ Authorization: 'Bearer ' + process.env." + DSH_API_KEY_ENV + " })\"" )
  }
  lines.push('        models:')
  lines.push(buildModelsYaml(models))
  lines.push('')
  return lines.join('\n')
}

/**
 * 确保 Proma profile 存在并与当前渠道配置一致。
 * 返回 profileHash，调用方据此判断是否需要重启 dsh 侧车。
 */
export function ensureDshProfile(input: DshProfileInput): DshProfileResult {
  if (!isDshProviderSupported(input.provider)) {
    throw new Error('DeepSeek Harness 暂不支持该渠道类型：' + input.provider)
  }
  const dshHome = getDshHome()
  const profileDir = join(dshHome, 'profiles', DSH_PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })

  const yaml = buildProfileYaml(input)
  const files: Array<{ path: string; content: string }> = [
    {
      path: join(profileDir, 'package.json'),
      content: JSON.stringify({
        name: 'dsh-profile-' + DSH_PROFILE_NAME,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
      }, null, 2) + '\n',
    },
    { path: join(profileDir, 'cordis.yml'), content: '[]\n' },
    { path: join(profileDir, 'pnpm-workspace.yaml'), content: 'packages:\n  - .\n' },
    { path: join(profileDir, 'cordis.patch.yml'), content: yaml },
  ]

  for (const file of files) {
    const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : undefined
    if (current !== file.content) writeFileSync(file.path, file.content, 'utf8')
  }

  return {
    dshHome,
    dshBinPath: resolveDshBinPath(),
    nodePath: resolveDshNodePath(),
    profileHash: createHash('sha256').update(yaml).digest('hex'),
  }
}
