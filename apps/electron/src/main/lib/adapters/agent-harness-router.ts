/**
 * Agent 内核路由。
 *
 * 新会话按设置选择 Pi 或 DeepSeek Harness，并把选择写入会话 meta；
 * 之后同一会话始终使用原内核（跨重启也成立），避免上下文丢失。
 */

import type { AgentProviderAdapter, AgentQueryInput, ProviderType, SDKMessage } from '@proma/shared'
import { getAgentSessionMeta, updateAgentSessionMeta } from '../agent-session-manager'
import { getSettings } from '../settings-service'
import { isDshProviderSupported } from './dsh-profile'

export type AgentHarnessId = 'pi' | 'dsh'

export class AgentHarnessRouter implements AgentProviderAdapter {
  private readonly owners = new Map<string, AgentHarnessId>()

  constructor(
    private readonly pi: AgentProviderAdapter,
    private readonly dsh: AgentProviderAdapter,
  ) {}

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    return this.adapterFor(input.sessionId, input).query(input)
  }

  abort(sessionId: string): void | Promise<void> {
    return this.adapterFor(sessionId).abort(sessionId)
  }

  interruptQuery(sessionId: string): Promise<void> {
    const owner = this.owners.get(sessionId)
    if (owner === 'dsh') return this.dsh.abort(sessionId) as Promise<void>
    return this.pi.interruptQuery?.(sessionId) ?? Promise.resolve()
  }

  dispose(): void {
    this.owners.clear()
    this.pi.dispose()
    this.dsh.dispose()
  }

  async sendQueuedMessage(
    sessionId: string,
    message: Parameters<NonNullable<AgentProviderAdapter['sendQueuedMessage']>>[1],
    options?: Parameters<NonNullable<AgentProviderAdapter['sendQueuedMessage']>>[2],
  ): Promise<void> {
    if (this.adapterFor(sessionId) === this.dsh) {
      throw new Error('DeepSeek Harness 内核暂不支持运行中追加消息，请等待本轮结束')
    }
    await this.pi.sendQueuedMessage?.(sessionId, message, options)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    if (this.adapterFor(sessionId) === this.dsh) return
    await this.pi.cancelQueuedMessage?.(sessionId, messageUuid)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    if (this.adapterFor(sessionId) === this.dsh) return
    await this.pi.setPermissionMode?.(sessionId, mode)
  }

  private adapterFor(sessionId: string, input?: AgentQueryInput): AgentProviderAdapter {
    let owner = this.owners.get(sessionId)
    if (!owner) {
      owner = this.resolveOwner(sessionId, input)
      this.owners.set(sessionId, owner)
    }
    return owner === 'dsh' ? this.dsh : this.pi
  }

  private resolveOwner(sessionId: string, input?: AgentQueryInput): AgentHarnessId {
    try {
      const stored = getAgentSessionMeta(sessionId)?.agentHarness
      if (stored === 'pi' || stored === 'dsh') return stored
    } catch {
      // 会话尚未写入索引时回退到全局设置
    }

    let owner: AgentHarnessId = 'pi'
    try {
      owner = getSettings().agentHarness === 'dsh' ? 'dsh' : 'pi'
    } catch {
      owner = 'pi'
    }

    const provider = (input as { provider?: ProviderType } | undefined)?.provider
    if (owner === 'dsh' && provider && !isDshProviderSupported(provider)) {
      console.warn('[Agent 内核] 当前渠道不支持 DeepSeek Harness，本次会话回退 Pi:', provider)
      owner = 'pi'
    }

    try {
      updateAgentSessionMeta(sessionId, { agentHarness: owner })
    } catch {
      // 会话可能尚未创建或已删除；不阻塞本轮执行
    }
    return owner
  }
}