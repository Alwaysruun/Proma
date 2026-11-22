/**
 * DeepSeek Harness ACP 侧车客户端。
 *
 * 直接实现 ACP 使用的 NDJSON JSON-RPC 子集，避免再引入一套 ACP SDK，
 * 并保持对 dsh developer preview 协议差异的可控性。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'

export interface DshAcpClientOptions {
  binPath: string
  /** 独立 Node 可执行文件；缺省时使用 Electron 的 Node 模式 */
  nodePath?: string
  dshHome: string
  profileName: string
  cwd: string
  env: Record<string, string>
  onNotification: (method: string, params: unknown) => void
  onRequest: (method: string, params: unknown) => Promise<unknown>
  onStderr?: (line: string) => void
  onExit?: (code: number | null) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const CLIENT_NAME = 'proma'

export class DshAcpClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private rl: ReadlineInterface | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly stderrTail: string[] = []
  private stopping = false
  private exited = false

  constructor(private readonly options: DshAcpClientOptions) {}

  get isRunning(): boolean {
    return !!this.child && !this.exited
  }

  get stderrSummary(): string {
    return this.stderrTail.slice(-12).join('\n')
  }

  async start(): Promise<void> {
    if (this.child) return
    const env: Record<string, string> = {
      ...this.options.env,
      DSH_HOME: this.options.dshHome,
    }
    const executable = this.options.nodePath ?? process.execPath
    if (!this.options.nodePath) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(
      executable,
      [this.options.binPath, '--profile', this.options.profileName],
      {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams
    this.child = child
    this.exited = false

    child.on('error', (error) => {
      this.failAll(new Error('DeepSeek Harness 进程启动失败：' + error.message))
    })
    child.on('exit', (code) => {
      this.exited = true
      this.rl?.close()
      this.rl = undefined
      this.child = undefined
      if (!this.stopping) {
        this.failAll(new Error('DeepSeek Harness 进程已退出（code=' + String(code) + '）' + this.formatStderr()))
      }
      this.options.onExit?.(code)
    })

    child.stderr.setEncoding('utf8')
    let stderrBuffer = ''
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const lines = stderrBuffer.split(/\r?\n/)
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        this.stderrTail.push(trimmed)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
        this.options.onStderr?.(trimmed)
      }
    })

    this.rl = createInterface({ input: child.stdout })
    this.rl.on('line', (line) => this.handleLine(line))
  }

  async request<T>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    const child = this.child
    if (!child || this.exited) throw new Error('DeepSeek Harness 进程未运行')
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    const result = new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error('DeepSeek Harness 请求超时：' + method))
        }, timeoutMs)
        pending.timer.unref?.()
      }
      this.pending.set(id, pending)
    })
    child.stdin.write(JSON.stringify(payload) + '\n')
    return result
  }

  notify(method: string, params: unknown): void {
    const child = this.child
    if (!child || this.exited) return
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    this.rl?.close()
    this.rl = undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3_000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
    this.child = undefined
    this.exited = true
    this.failAll(new Error('DeepSeek Harness 已停止'))
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      this.options.onStderr?.('[acp] 非 JSON 输出：' + trimmed.slice(0, 200))
      return
    }

    if (message.id !== undefined && message.method === undefined) {
      this.settle(message)
      return
    }
    if (message.id !== undefined && message.method) {
      void this.answerRequest(message)
      return
    }
    if (message.method) {
      this.options.onNotification(message.method, message.params)
    }
  }

  private settle(message: JsonRpcMessage): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (message.error) {
      const error = new Error(message.error.message || 'DeepSeek Harness 返回错误')
      ;(error as Error & { code?: number; data?: unknown }).code = message.error.code
      ;(error as Error & { code?: number; data?: unknown }).data = message.error.data
      pending.reject(error)
      return
    }
    pending.resolve(message.result)
  }

  private async answerRequest(message: JsonRpcMessage): Promise<void> {
    const child = this.child
    if (!child || message.id === undefined) return
    let result: unknown
    try {
      result = await this.options.onRequest(message.method ?? '', message.params)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: text },
      }) + '\n')
      return
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private formatStderr(): string {
    const tail = this.stderrSummary
    return tail ? '\n' + tail : ''
  }

  /** ACP initialize 参数；保留扩展位以便后续按需开启 fs / terminal 能力 */
  static initializeParams(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
      clientCapabilities: {},
    }
  }
}
