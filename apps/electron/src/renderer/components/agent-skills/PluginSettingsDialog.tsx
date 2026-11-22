import * as React from 'react'
import { KeyRound, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type {
  InstalledPromaPlugin,
  PromaPluginSettingField,
  PromaPluginSettingsSnapshot,
  SavePromaPluginSettingsInput,
} from '@proma/shared'

interface PluginSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  plugin: InstalledPromaPlugin | null
  getSettings: (pluginId: string) => Promise<PromaPluginSettingsSnapshot>
  saveSettings: (pluginId: string, input: SavePromaPluginSettingsInput) => Promise<PromaPluginSettingsSnapshot>
  onSaved?: () => void
}

function defaultValue(field: PromaPluginSettingField): string | number | boolean {
  if (field.default !== undefined) return field.default
  if (field.type === 'boolean') return false
  if (field.type === 'number') return field.min ?? 0
  if (field.type === 'select') return field.options?.[0]?.value ?? ''
  return ''
}

function FieldLabel({ field }: { field: PromaPluginSettingField }): React.ReactElement {
  return (
    <div className="space-y-1">
      <Label htmlFor={'plugin-setting-' + field.key}>
        {field.label}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {field.description && (
        <p className="text-xs leading-5 text-muted-foreground">{field.description}</p>
      )}
    </div>
  )
}

export function PluginSettingsDialog({
  open,
  onOpenChange,
  plugin,
  getSettings,
  saveSettings,
  onSaved,
}: PluginSettingsDialogProps): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<PromaPluginSettingsSnapshot | null>(null)
  const [values, setValues] = React.useState<Record<string, string | number | boolean>>({})
  const [secretInputs, setSecretInputs] = React.useState<Record<string, string>>({})
  const [clearedSecrets, setClearedSecrets] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open || !plugin) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSaveError(null)
    setSnapshot(null)
    setSecretInputs({})
    setClearedSecrets([])

    void getSettings(plugin.id)
      .then((next) => {
        if (cancelled) return
        setSnapshot(next)
        const initial: Record<string, string | number | boolean> = {}
        for (const field of next.schema.fields) {
          if (field.type === 'password') continue
          initial[field.key] = next.values[field.key] ?? defaultValue(field)
        }
        setValues(initial)
      })
      .catch((reason) => {
        if (cancelled) return
        const message = reason instanceof Error ? reason.message : '读取插件配置失败'
        setLoadError(message)
        toast.error('读取插件配置失败', { description: message })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, plugin, getSettings])

  const handleSave = React.useCallback(async (): Promise<void> => {
    if (!plugin || !snapshot || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const payload: Record<string, string | number | boolean> = { ...values }
      for (const field of snapshot.schema.fields) {
        if (field.type === 'password') {
          const secret = secretInputs[field.key]?.trim()
          if (secret) payload[field.key] = secret
          continue
        }
        if (field.type === 'number') {
          if (payload[field.key] === '' || payload[field.key] === undefined) {
            throw new Error('请填写有效的 ' + field.label)
          }
          const number = Number(payload[field.key])
          if (!Number.isFinite(number)) throw new Error('请填写有效的 ' + field.label)
          payload[field.key] = number
        }
      }
      await saveSettings(plugin.id, {
        values: payload,
        clearSecrets: clearedSecrets,
      })
      toast.success('插件配置已保存', { description: plugin.name })
      onSaved?.()
      onOpenChange(false)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存插件配置失败'
      setSaveError(message)
      toast.error('保存插件配置失败', { description: message })
    } finally {
      setSaving(false)
    }
  }, [plugin, snapshot, saving, values, secretInputs, clearedSecrets, saveSettings, onSaved, onOpenChange])

  const fields = snapshot?.schema.fields ?? []

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plugin?.name ?? '插件'} 配置</DialogTitle>
          <DialogDescription>
            配置保存后会在下一次 Agent 运行时注入插件。密钥使用系统安全存储加密，不会写入 mcp.json。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            正在读取配置...
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {loadError}
          </div>
        ) : (
          <div className="space-y-5">
            {saveError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {saveError}
              </div>
            )}
            {fields.map((field) => {
              const configured = snapshot?.configuredSecrets.includes(field.key) ?? false
              const cleared = clearedSecrets.includes(field.key)
              return (
                <div key={field.key} className="space-y-2">
                  <FieldLabel field={field} />
                  {field.type === 'password' ? (
                    <div className="space-y-2">
                      <div className="relative">
                        <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id={'plugin-setting-' + field.key}
                          type="password"
                          autoComplete="new-password"
                          value={secretInputs[field.key] ?? ''}
                          disabled={cleared}
                          placeholder={
                            cleared
                              ? '保存后清除该密钥'
                              : configured
                                ? '已保存，留空保持不变'
                                : field.placeholder || '输入密钥'
                          }
                          onChange={(event) => setSecretInputs((current) => ({
                            ...current,
                            [field.key]: event.target.value,
                          }))}
                          className="pl-9"
                        />
                      </div>
                      {configured && (
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{cleared ? '保存后清除' : '已配置'}</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className={cleared ? 'text-muted-foreground' : 'text-muted-foreground hover:text-destructive'}
                            onClick={() => setClearedSecrets((current) => (
                              cleared
                                ? current.filter((key) => key !== field.key)
                                : [...current, field.key]
                            ))}
                          >
                            <Trash2 size={13} />
                            {cleared ? '撤销清除' : '清除'}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : field.type === 'boolean' ? (
                    <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
                      <span className="text-sm text-muted-foreground">
                        {field.placeholder || (values[field.key] ? '已开启' : '已关闭')}
                      </span>
                      <Switch
                        id={'plugin-setting-' + field.key}
                        checked={Boolean(values[field.key])}
                        onCheckedChange={(checked) => setValues((current) => ({
                          ...current,
                          [field.key]: checked,
                        }))}
                      />
                    </div>
                  ) : field.type === 'select' ? (
                    <Select
                      value={String(values[field.key] ?? '')}
                      onValueChange={(value) => setValues((current) => ({
                        ...current,
                        [field.key]: value,
                      }))}
                    >
                      <SelectTrigger id={'plugin-setting-' + field.key}>
                        <SelectValue placeholder="请选择" />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options?.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : field.type === 'number' ? (
                    <Input
                      id={'plugin-setting-' + field.key}
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={String(values[field.key] ?? '')}
                      placeholder={field.placeholder}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))}
                    />
                  ) : (
                    <Input
                      id={'plugin-setting-' + field.key}
                      value={String(values[field.key] ?? '')}
                      placeholder={field.placeholder}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={loading || saving || !snapshot}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
