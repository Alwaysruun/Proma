/**
 * DeepSeek Harness Agent 适配器。
 *
 * 通过 ACP（Agent Client Protocol）stdio 侧车运行 dsh，并把 session/update
 * 映射成 Proma 现有的 SDKMessage 流：assistant_delta 负责流式文本，
 * 最终 assistant / tool_result / result 负责持久化与工具卡片。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  PromaPermissionMode,
  ProviderType,
  SDKMessage,
  AgentAssistantDelta,
} from '@proma/shared'
import { inferContextWindow } from '@proma/shared'
import { mergeRuntimeEnv, type AgentRuntimeEnv } from '../agent-runtime-env'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'
import { DshAcpClient } from './dsh-acp-client'
import {
  DSH_API_KEY_ENV,
  DSH_PROFILE_NAME,
  DSH_ROUTE_NAME,
  ensureDshProfile,
  type DshModelSpec,
} from './dsh-profile'

export interface DshAgentQueryOptions extends AgentQueryInput {
  apiKey: string
  baseUrl?: string
  provider: ProviderType
  channelId?: string
  channelName?: string
  permissionMode: PromaPermissionMode
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  systemPrompt: string
  additionalDirectories?: string[]
  availableModels?: DshModelSpec[]
  mcpServers?: Record<string, Record<string, unknown>>
  resumeSessionId?: string
  onSessionId?: (sdkSessionId: string) => void
  onModelResolved?: (model: string) => void
  onContextWindow?: (contextWindow: number) => void
  runtimeEnv?: AgentRuntimeEnv
}

interface DshSessionState {
  dshSessionId: string
  model?: string
  firstPromptSent: boolean
}

interface BlockState {
  kind: 'text' | 'thinking'
  index: number
  text: string
}

interface TurnState {
  promaSessionId: string
  dshSessionId: string
  queue: MessageQueue
  blocks: BlockState[]
  uuid: string
  messageId?: string
  toolNames: Map<string, string>
  usageFirst?: number
  usageLast?: number
  usageSize?: number
  model: string
  channelModelId?: string
  aborted: boolean
  permissionController: AbortController
  onContextWindow?: (contextWindow: number) => void
}

interface AcpOption {
  optionId?: string
  name?: string
  kind?: string
}

interface AcpUpdate {
  sessionUpdate?: string
  messageId?: string
  content?: unknown
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  used?: number
  size?: number
}

class MessageQueue implements AsyncIterable<SDKMessage> {
  private readonly buffer: SDKMessage[] = []
  private waiter: ((result: IteratorResult<SDKMessage>) => void) | null = null
  private closed = false

  push(message: SDKMessage): void {
    if (this.closed) return
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter({ value: message, done: false })
      return
    }
    this.buffer.push(message)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const buffered = this.buffer.shift()
    if (buffered) return Promise.resolve({ value: buffered, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return { next: () => this.next() }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 把 ACP 工具标题/类型映射到 Proma 已有的工具渲染器 */
function mapToolName(title: string | undefined, kind: string | undefined): string {
  const raw = (title ?? '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'pwsh' || lower.includes('powershell') || lower === 'shell') return 'powershell'
  if (lower === 'bash') return 'bash'
  if (lower === 'read') return 'read'
  if (lower === 'write' || lower === 'create') return 'write'
  if (lower === 'edit' || lower.includes('replace')) return 'edit'
  if (lower === 'grep' || lower === 'search') return 'grep'
  if (lower === 'find' || lower === 'glob') return 'find'
  if (lower === 'ls' || lower === 'list') return 'ls'
  if (kind === 'read') return 'read'
  if (kind === 'edit') return 'edit'
  if (kind === 'search') return 'grep'
  if (kind === 'execute') return 'bash'
  if (kind === 'fetch') return 'webfetch'
  return raw || 'tool'
}

function extractToolResultText(update: AcpUpdate): string {
  const parts: string[] = []
  const content = Array.isArray(update.content) ? update.content : []
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === 'content' && isRecord(item.content)) {
      const inner = item.content
      if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
      continue
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
      continue
    }
    if (item.type === 'diff') {
      const path = typeof item.path === 'string' ? item.path : '文件'
      const oldText = typeof item.oldText === 'string' ? item.oldText : ''
      const newText = typeof item.newText === 'string' ? item.newText : ''
      parts.push('--- ' + path + '\n' + oldText + '\n+++\n' + newText)
    }
  }
  if (parts.length === 0 && update.rawOutput !== undefined) {
    if (typeof update.rawOutput === 'string') return update.rawOutput
    try {
      return JSON.stringify(update.rawOutput, null, 2)
    } catch {
      return String(update.rawOutput)
    }
  }
  return parts.join('\n')
}

/** 把裸命令解析为绝对路径；ACP 要求 stdio command 必须是绝对路径 */
function resolveExecutable(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, command + extension)
      if (existsSync(candidate)) return candidate
    }
    const direct = join(dir, command)
    if (existsSync(direct)) return direct
  }
  return undefined
}

/** 把 Proma 工作区 MCP 配置转换为 ACP session/new 的 mcpServers 声明 */
function toAcpMcpServers(
  input: Record<string, Record<string, unknown>> | undefined,
  fallbackNodePath?: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  for (const [name, entry] of Object.entries(input ?? {})) {
    const rawType = typeof entry.type === 'string' ? entry.type : undefined
    const type = rawType ?? (typeof entry.command === 'string' ? 'stdio' : 'http')
    if (type === 'stdio' && typeof entry.command === 'string') {
      const args = Array.isArray(entry.args)
        ? entry.args.filter((item): item is string => typeof item === 'string')
        : []
      const env = isRecord(entry.env)
        ? Object.entries(entry.env)
            .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
            .map(([key, value]) => ({ name: key, value }))
        : []
      const resolved = resolveExecutable(entry.command)
        ?? (entry.command === 'node' ? fallbackNodePath : undefined)
      if (!resolved) {
        console.warn('[DSH] 跳过无法解析为绝对路径的 MCP 服务器: ' + name + ' (' + entry.command + ')')
        continue
      }
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)
      const command = needsShell ? (process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:', 'Windows', 'System32', 'cmd.exe')) : resolved
      const finalArgs = needsShell ? ['/d', '/s', '/c', resolved, ...args] : args
      result.push({ name, command, args: finalArgs, env })
      continue
    }
    if (typeof entry.url === 'string') {
      const headers = isRecord(entry.headers)
        ? Object.entries(entry.headers)
            .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
            .map(([key, value]) => ({ name: key, value }))
        : []
      result.push({ type: type === 'sse' ? 'sse' : 'http', name, url: entry.url, headers })
    }
  }
  return result
}

function pickPermissionOption(options: AcpOption[], allow: boolean): unknown {
  const wanted = allow ? 'allow' : 'reject'
  const exact = options.find((option) => option.kind === wanted + '_once')
    ?? options.find((option) => typeof option.kind === 'string' && option.kind.startsWith(wanted))
  const fallback = allow ? options[0] : options[options.length - 1]
  const chosen = exact ?? fallback
  if (!chosen?.optionId) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } }
}

export class DshAgentAdapter implements AgentProviderAdapter {
  private client: DshAcpClient | undefined
  private clientKey: string | undefined
  private currentNodePath: string | undefined
  private ensuring: Promise<DshAcpClient> | null = null
  private disposed = false
  private readonly sessions = new Map<string, DshSessionState>()
  private readonly turns = new Map<string, TurnState>()
  /** 启动阶段（session/new 前）收到的取消请求，按 Proma session 记录时间戳 */
  private readonly cancelledSessions = new Map<string, number>()

  async *query(input: AgentQueryInput): AsyncGenerator<SDKMessage> {
    const opts = input as DshAgentQueryOptions
    const turn = await this.beginTurn(opts)
    try {
      for await (const message of turn.queue) {
        yield message
      }
    } finally {
      this.cancelledSessions.delete(turn.promaSessionId)
      this.turns.delete(turn.dshSessionId)
      turn.permissionController.abort()
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.cancelledSessions.set(sessionId, Date.now())
    const state = this.sessions.get(sessionId)
    if (!state) return
    const turn = this.turns.get(state.dshSessionId)
    if (turn) {
      turn.aborted = true
      turn.permissionController.abort()
    }
    this.client?.notify('session/cancel', { sessionId: state.dshSessionId })
  }

  dispose(): void {
    this.disposed = true
    const client = this.client
    this.client = undefined
    this.clientKey = undefined
    this.sessions.clear()
    this.cancelledSessions.clear()
    void client?.stop()
  }

  private async beginTurn(opts: DshAgentQueryOptions): Promise<TurnState> {
    const client = await this.ensureClient(opts)
    const dshSessionId = await this.resolveSession(client, opts)
    await this.applyModel(client, opts, dshSessionId)

    const turn: TurnState = {
      promaSessionId: opts.sessionId,
      dshSessionId,
      queue: new MessageQueue(),
      blocks: [],
      uuid: randomUUID(),
      toolNames: new Map(),
      model: opts.model?.trim() || 'deepseek-v4-flash',
      channelModelId: opts.model,
      aborted: false,
      permissionController: new AbortController(),
      onContextWindow: opts.onContextWindow,
    }
    this.turns.set(dshSessionId, turn)

    const cancelledAt = this.cancelledSessions.get(opts.sessionId)
    this.cancelledSessions.delete(opts.sessionId)
    if (cancelledAt !== undefined && Date.now() - cancelledAt < 120_000) {
      turn.aborted = true
      turn.queue.close()
      return turn
    }

    const state = this.sessions.get(opts.sessionId)
    const firstPrompt = !state?.firstPromptSent
    if (state) state.firstPromptSent = true

    const systemPrompt = opts.systemPrompt.trim()
    const promptText = firstPrompt && systemPrompt
      ? '<proma_system_context>\n' + systemPrompt + '\n</proma_system_context>\n\n' + opts.prompt
      : opts.prompt

    void client.request('session/prompt', {
      sessionId: dshSessionId,
      prompt: [{ type: 'text', text: promptText }],
    }, 0).then((result) => {
      const stopReason = isRecord(result) && typeof result.stopReason === 'string'
        ? result.stopReason
        : 'end_turn'
      if (turn.aborted || stopReason === 'cancelled') {
        turn.queue.close()
        return
      }
      this.flushBlocks(turn)
      turn.queue.push(this.buildResult(turn, stopReason))
      turn.queue.close()
    }).catch((error: unknown) => {
      if (turn.aborted) {
        turn.queue.close()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.flushBlocks(turn)
      turn.queue.push(this.buildErrorAssistant(turn, message))
      turn.queue.push(this.buildResult(turn, 'error_during_execution', [message]))
      turn.queue.close()
    })

    return turn
  }

  private async ensureClient(opts: DshAgentQueryOptions): Promise<DshAcpClient> {
    if (this.disposed) throw new Error('DeepSeek Harness 适配器已释放')
    if (!opts.apiKey) throw new Error('当前渠道缺少 API Key')
    const model = opts.model?.trim()
    if (!model) throw new Error('请先选择模型再启用 DeepSeek Harness')

    const knownModels: DshModelSpec[] = [
      ...(opts.availableModels ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        contextWindow: item.contextWindow ?? inferContextWindow(item.id),
      })),
      { id: model, contextWindow: inferContextWindow(model) },
    ]
    const sortedModels = knownModels
      .filter((item, index) => knownModels.findIndex((other) => other.id === item.id) === index)
      .sort((left, right) => left.id.localeCompare(right.id))
    const profile = ensureDshProfile({
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      models: sortedModels,
      defaultModel: sortedModels[0]?.id ?? model,
    })
    this.currentNodePath = profile.nodePath
    if (!profile.nodePath) {
      throw new Error('DeepSeek Harness 需要独立 Node 运行时，请先运行 bun run setup:dsh')
    }
    const key = profile.profileHash + '|' + opts.apiKey

    if (this.client && this.clientKey === key && this.client.isRunning) return this.client
    if (!this.ensuring) {
      this.ensuring = this.startClient(opts, profile, key).finally(() => {
        this.ensuring = null
      })
    }
    return this.ensuring
  }

  private async startClient(
    opts: DshAgentQueryOptions,
    profile: { dshHome: string; dshBinPath: string; nodePath?: string },
    key: string,
  ): Promise<DshAcpClient> {
    const previous = this.client
    this.client = undefined
    this.clientKey = undefined
    this.sessions.clear()
    await previous?.stop()

    const env: Record<string, string> = {
      ...mergeRuntimeEnv(process.env, opts.runtimeEnv?.env),
      [DSH_API_KEY_ENV]: opts.apiKey,
    }
    const client = new DshAcpClient({
      binPath: profile.dshBinPath,
      nodePath: profile.nodePath,
      dshHome: profile.dshHome,
      profileName: DSH_PROFILE_NAME,
      cwd: opts.cwd ?? homedir(),
      env,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(opts, method, params),
      onStderr: (line) => {
        console.log('[DSH] ' + line)
      },
    })
    await client.start()
    await client.request('initialize', DshAcpClient.initializeParams(), 60_000)
    this.client = client
    this.clientKey = key
    return client
  }

  private async resolveSession(client: DshAcpClient, opts: DshAgentQueryOptions): Promise<string> {
    const existing = this.sessions.get(opts.sessionId)
    if (existing) return existing.dshSessionId

    const cwd = opts.cwd ?? homedir()
    let dshSessionId: string | undefined
    if (opts.resumeSessionId) {
      try {
        await client.request('session/resume', {
          sessionId: opts.resumeSessionId,
          cwd,
          mcpServers: toAcpMcpServers(opts.mcpServers, this.currentNodePath),
        }, 120_000)
        dshSessionId = opts.resumeSessionId
      } catch {
        dshSessionId = undefined
      }
    }
    if (!dshSessionId) {
      const created = await client.request<{ sessionId?: string }>('session/new', {
        cwd,
        mcpServers: toAcpMcpServers(opts.mcpServers, this.currentNodePath),
      }, 120_000)
      if (!created?.sessionId) throw new Error('DeepSeek Harness 创建会话失败')
      dshSessionId = created.sessionId
    }
    this.sessions.set(opts.sessionId, { dshSessionId, firstPromptSent: false })
    opts.onSessionId?.(dshSessionId)
    return dshSessionId
  }

  private async applyModel(
    client: DshAcpClient,
    opts: DshAgentQueryOptions,
    dshSessionId: string,
  ): Promise<void> {
    const model = opts.model?.trim()
    if (!model) return
    const state = this.sessions.get(opts.sessionId)
    if (state?.model === model) return
    try {
      await client.request('session/set_config_option', {
        sessionId: dshSessionId,
        configId: 'model',
        value: JSON.stringify([DSH_ROUTE_NAME, model]),
      }, 30_000)
      if (state) state.model = model
      opts.onModelResolved?.(model)
    } catch (error) {
      console.warn('[DSH] 设置模型失败，沿用 profile 默认模型：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !isRecord(params)) return
    const dshSessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const update = isRecord(params.update) ? params.update as AcpUpdate : undefined
    if (!dshSessionId || !update) return
    const turn = this.turns.get(dshSessionId)
    if (turn) this.handleUpdate(turn, update)
  }

  private async handleRequest(
    opts: DshAgentQueryOptions,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method !== 'session/request_permission' || !isRecord(params)) {
      throw new Error('不支持的 ACP 请求：' + method)
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
    const options = Array.isArray(params.options)
      ? params.options.filter((item): item is AcpOption => isRecord(item))
      : []
    const toolName = mapToolName(
      typeof toolCall.title === 'string' ? toolCall.title : undefined,
      typeof toolCall.kind === 'string' ? toolCall.kind : undefined,
    )
    const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : {}
    const dshSessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const turn = this.turns.get(dshSessionId)
    if (!opts.canUseTool) return pickPermissionOption(options, true)

    try {
      const decision = await opts.canUseTool(toolName, input, {
        signal: turn?.permissionController.signal ?? new AbortController().signal,
        toolUseID: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '',
        title: typeof toolCall.title === 'string' ? toolCall.title : undefined,
        displayName: toolName,
        description: typeof toolCall.title === 'string' ? toolCall.title : undefined,
      })
      return pickPermissionOption(options, decision.behavior === 'allow')
    } catch {
      return pickPermissionOption(options, false)
    }
  }


  private handleUpdate(turn: TurnState, update: AcpUpdate): void {
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = isRecord(update.content) ? update.content : {}
      const text = typeof content.text === 'string' ? content.text : ''
      if (!text) return
      if (update.messageId && update.messageId !== turn.messageId) {
        if (turn.messageId !== undefined) this.flushBlocks(turn)
        turn.messageId = update.messageId
      }
      const blockKind: BlockState['kind'] = kind === 'agent_thought_chunk' ? 'thinking' : 'text'
      let block = turn.blocks.find((item) => item.kind === blockKind)
      if (!block) {
        block = { kind: blockKind, index: turn.blocks.length, text: '' }
        turn.blocks.push(block)
      }
      block.text += text
      const delta: AgentAssistantDelta = blockKind === 'thinking'
        ? { type: 'thinking_delta', contentIndex: block.index, delta: text }
        : { type: 'text_delta', contentIndex: block.index, delta: text }
      turn.queue.push({
        type: 'assistant_delta',
        uuid: turn.uuid,
        delta,
        session_id: turn.dshSessionId,
        ...(turn.channelModelId ? { _channelModelId: turn.channelModelId } : {}),
      } as unknown as SDKMessage)
      return
    }

    if (kind === 'tool_call') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      if (!id) return
      const name = mapToolName(update.title, update.kind)
      const alreadyShown = turn.toolNames.has(id)
      turn.toolNames.set(id, name)
      if (alreadyShown) return
      this.flushBlocks(turn)
      turn.queue.push({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id,
            name,
            input: isRecord(update.rawInput) ? update.rawInput : {},
          }],
          model: turn.model,
        },
        parent_tool_use_id: null,
        session_id: turn.dshSessionId,
        uuid: 'tool:' + id,
        ...(turn.channelModelId ? { _channelModelId: turn.channelModelId } : {}),
      } as unknown as SDKMessage)
      return
    }

    if (kind === 'tool_call_update') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      if (!id) return
      if (update.status !== 'completed' && update.status !== 'failed') return
      const name = turn.toolNames.get(id) ?? mapToolName(update.title, update.kind)
      turn.queue.push({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: extractToolResultText(update),
            is_error: update.status === 'failed',
          }],
        },
        tool_use_result: { toolName: name },
        parent_tool_use_id: null,
        session_id: turn.dshSessionId,
        uuid: 'tool-result:' + id,
      } as unknown as SDKMessage)
      return
    }

    if (kind === 'usage_update') {
      if (typeof update.used === 'number') {
        if (turn.usageFirst === undefined) turn.usageFirst = update.used
        turn.usageLast = update.used
      }
      if (typeof update.size === 'number' && update.size > 0) {
        turn.usageSize = update.size
        turn.onContextWindow?.(update.size)
      }
    }
  }

  /** 把当前累积的文本/思考块收束为一条最终 assistant 消息，共用 delta 的 uuid */
  private flushBlocks(turn: TurnState): void {
    const blocks = turn.blocks.filter((block) => block.text.length > 0)
    turn.blocks = []
    if (blocks.length === 0) {
      turn.uuid = randomUUID()
      turn.messageId = undefined
      return
    }
    const content = blocks
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((block) => block.kind === 'thinking'
        ? { type: 'thinking', thinking: block.text }
        : { type: 'text', text: block.text })
    turn.queue.push({
      type: 'assistant',
      message: { content, model: turn.model },
      parent_tool_use_id: null,
      session_id: turn.dshSessionId,
      uuid: turn.uuid,
      ...(turn.channelModelId ? { _channelModelId: turn.channelModelId } : {}),
    } as unknown as SDKMessage)
    turn.uuid = randomUUID()
    turn.messageId = undefined
  }

  private buildResult(turn: TurnState, stopReason: string, errors?: string[]): SDKMessage {
    const inputTokens = turn.usageFirst ?? 0
    const outputTokens = turn.usageFirst !== undefined && turn.usageLast !== undefined
      ? Math.max(0, turn.usageLast - turn.usageFirst)
      : 0
    const subtype = stopReason === 'end_turn'
      ? 'success'
      : stopReason === 'max_tokens'
        ? 'error_max_turns'
        : 'error'
    return {
      type: 'result',
      subtype,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      terminal_reason: stopReason,
      session_id: turn.dshSessionId,
      ...(turn.usageSize ? { modelUsage: { [turn.model]: { contextWindow: turn.usageSize } } } : {}),
      ...(errors && errors.length > 0 ? { errors } : {}),
      ...(turn.channelModelId ? { _channelModelId: turn.channelModelId } : {}),
    } as unknown as SDKMessage
  }

  private buildErrorAssistant(turn: TurnState, message: string): SDKMessage {
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'DeepSeek Harness 运行失败：' + message }],
        model: turn.model,
      },
      parent_tool_use_id: null,
      session_id: turn.dshSessionId,
      uuid: randomUUID(),
      error: { message, errorType: 'provider_error' },
      ...(turn.channelModelId ? { _channelModelId: turn.channelModelId } : {}),
    } as unknown as SDKMessage
  }
}

