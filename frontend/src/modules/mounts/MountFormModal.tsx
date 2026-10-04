import { t, useTranslation } from '@/i18n' // 统一挂载表单：按挂载类型渲染对应模块的表单字段
// 调用各模块独立的 create/update/test API
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { InputNumber } from '@/components/ui/InputNumber'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { message } from '@/components/ui/message'
import { englishErrorMessage } from '@/lib/errorMessage'
import {
  createWebDAVMount,
  updateWebDAVMount,
  testWebDAVMount,
} from '@/modules/webdav/webdavApi'
import {
  createOpenListMount,
  updateOpenListMount,
  testOpenListMount,
} from '@/modules/openlist/openlistApi'
import {
  createFTPMount,
  updateFTPMount,
  testFTPMount,
} from '@/modules/ftp/ftpApi'
import {
  createEmbyMount,
  updateEmbyMount,
  testEmbyMount,
} from '@/modules/emby/embyApi'
import {
  createJellyfinMount,
  updateJellyfinMount,
  testJellyfinMount,
} from '@/modules/jellyfin/jellyfinApi'
import { isInternalOpenListServer } from '@/modules/openlist/isInternal'
import type { UnionMount, MountType } from './types'

interface MountFormModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  // 编辑模式时传入的挂载对象；新增模式为 null
  editingMount: UnionMount | null
  // 新增模式时的初始类型
  initialType?: MountType
}

interface FormValues {
  type: MountType
  name: string
  serverUrl: string
  port: string
  path: string
  username: string
  password: string
  apiKey: string
  directLink: boolean
}

const EMPTY_FORM: FormValues = {
  type: 'webdav',
  name: '',
  serverUrl: '',
  port: '',
  path: '',
  username: '',
  password: '',
  apiKey: '',
  directLink: false,
}

function mountToFormValues(mount: UnionMount): FormValues {
  return {
    type: mount.type,
    name: mount.name,
    serverUrl: mount.serverUrl || '',
    port: 'port' in mount && mount.port ? String(mount.port) : '',
    path: 'path' in mount && mount.path ? mount.path || '' : '',
    username: mount.username || '',
    password: '',
    apiKey: 'apiKey' in mount ? mount.apiKey || '' : '',
    directLink: 'directLink' in mount ? mount.directLink : false,
  }
}

function validateForm(values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!values.name.trim()) {
    errors.name = 'Enter a source name.'
  }
  if (!values.serverUrl.trim()) {
    errors.serverUrl = 'Enter a server address.'
  }
  if (values.type === 'ftp') {
    if (!values.port.trim()) {
      errors.port = 'Enter a port.'
    } else {
      const portNum = Number(values.port.trim())
      if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
        errors.port = 'Enter a port between 1 and 65535.'
      }
    }
  }
  if (values.type === 'emby') {
    if (
      !values.apiKey.trim() &&
      (!values.username.trim() || !values.password)
    ) {
      errors.apiKey = 'Enter an API key or your username and password.'
    }
  }
  return errors
}

const TYPE_OPTIONS = [
  { label: 'WebDAV', value: 'webdav' as MountType },
  { label: 'FTP', value: 'ftp' as MountType },
  { label: 'OpenList', value: 'openlist' as MountType },
  { label: 'Emby', value: 'emby' as MountType },
  { label: 'Jellyfin', value: 'jellyfin' as MountType },
]

export default function MountFormModal({
  open,
  onClose,
  onSuccess,
  editingMount,
  initialType = 'webdav',
}: MountFormModalProps) {
  useTranslation()

  const [formValues, setFormValues] = useState<FormValues>({
    ...EMPTY_FORM,
    type: initialType,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)

  // 打开时重置表单
  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect -- Open时根据 editingMount 重置表单 */
      if (editingMount) {
        setFormValues(mountToFormValues(editingMount))
      } else {
        setFormValues({ ...EMPTY_FORM, type: initialType })
      }
      setErrors({})
      setSubmitError('')
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, editingMount, initialType])

  const updateField = <K extends keyof FormValues>(
    key: K,
    value: FormValues[K]
  ) => {
    setFormValues((prev) => {
      const next = { ...prev, [key]: value }
      // 切换类型时清空校验错误
      if (key === 'type') {
        setErrors({})
      }
      return next
    })
  }

  const handleTest = async () => {
    const validationErrors = validateForm(formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setTesting(true)
    try {
      const { type, serverUrl, path, username, password, port } = formValues
      const trimmedUrl = serverUrl.trim()
      const trimmedPath = path.trim() || '/'
      const trimmedUser = username.trim() || undefined
      const trimmedPwd = password || undefined

      if (type === 'webdav' || type === 'openlist') {
        // WebDAV 与 OpenList 共用同一套协议与表单，仅 API 前缀不同
        const params = {
          serverUrl: trimmedUrl,
          path: trimmedPath,
          username: trimmedUser,
          password: trimmedPwd,
        }
        const result =
          type === 'webdav'
            ? await testWebDAVMount(params)
            : await testOpenListMount(params)
        message.success(
          t('Connected. Items:  {value1}  items', { value1: result.itemCount })
        )
      } else if (type === 'emby') {
        const result = await testEmbyMount({
          name: formValues.name.trim(),
          serverUrl: trimmedUrl,
          apiKey: formValues.apiKey.trim() || null,
          username: trimmedUser,
          password: trimmedPwd,
          directLink: formValues.directLink,
        })
        message.success(
          t('Connected.{value1}', {
            value1: result.userName
              ? t(' · User: {value1}', { value1: result.userName })
              : '',
          })
        )
      } else if (type === 'jellyfin') {
        const result = await testJellyfinMount({
          name: formValues.name.trim(),
          serverUrl: trimmedUrl,
          apiKey: formValues.apiKey.trim() || null,
          username: trimmedUser,
          password: trimmedPwd,
          directLink: formValues.directLink,
        })
        message.success(
          t('Connected.{value1}', {
            value1: result.userName
              ? t(' · User: {value1}', { value1: result.userName })
              : '',
          })
        )
      } else {
        const portNum = port.trim() ? Number(port.trim()) : undefined
        const result = await testFTPMount({
          serverUrl: trimmedUrl,
          path: trimmedPath,
          port: portNum,
          username: trimmedUser,
          password: trimmedPwd,
        })
        message.success(
          t('Connected. Items:  {value1}  items', { value1: result.itemCount })
        )
      }
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Connection test failed.')
      )
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async () => {
    const validationErrors = validateForm(formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setSubmitError('')
    setSubmitting(true)
    try {
      const {
        type,
        name,
        serverUrl,
        port,
        path,
        username,
        password,
        apiKey,
        directLink,
      } = formValues
      const portNum = port.trim() ? Number(port.trim()) : null

      if (type === 'webdav' || type === 'openlist') {
        // WebDAV 与 OpenList 共用同一套协议与表单，仅 API 前缀与 type 不同
        const payload = {
          type: type as 'webdav' | 'openlist',
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          path: path.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        const label = type === 'webdav' ? 'WebDAV' : 'OpenList'
        if (editingMount) {
          const saved =
            type === 'webdav'
              ? await updateWebDAVMount(editingMount.id, {
                  ...payload,
                  type: 'webdav',
                  port:
                    portNum !== null && Number.isFinite(portNum)
                      ? portNum
                      : null,
                })
              : await updateOpenListMount(editingMount.id, payload)
          message.success(t('{value1} Source updated.', { value1: label }))
          if (saved.warning)
            message.warning(
              englishErrorMessage(
                saved.warning,
                t(
                  'Source saved with a connection warning. Test the connection before selecting content.'
                )
              )
            )
        } else {
          const saved =
            type === 'webdav'
              ? await createWebDAVMount({
                  ...payload,
                  type: 'webdav',
                  port:
                    portNum !== null && Number.isFinite(portNum)
                      ? portNum
                      : null,
                })
              : await createOpenListMount(payload)
          message.success(t('{value1} Source added.', { value1: label }))
          if (saved.warning)
            message.warning(
              englishErrorMessage(
                saved.warning,
                t(
                  'Source saved with a connection warning. Test the connection before selecting content.'
                )
              )
            )
        }
      } else if (type === 'emby') {
        const payload = {
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          apiKey: apiKey.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        if (editingMount) {
          const saved = await updateEmbyMount(editingMount.id, payload)
          message.success(t('Emby Source updated.'))
          if (saved.warning)
            message.warning(
              englishErrorMessage(
                saved.warning,
                t(
                  'Source saved with a connection warning. Test the connection before selecting content.'
                )
              )
            )
        } else {
          const saved = await createEmbyMount(payload)
          message.success(t('Emby Source added.'))
          if (saved.warning)
            message.warning(
              englishErrorMessage(
                saved.warning,
                t(
                  'Source saved with a connection warning. Test the connection before selecting content.'
                )
              )
            )
        }
      } else if (type === 'jellyfin') {
        const payload = {
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          apiKey: apiKey.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink,
        }
        if (editingMount) {
          const saved = await updateJellyfinMount(editingMount.id, payload)
          message.success(t('Jellyfin Source updated.'))
          if (saved.warning)
            message.warning(
              englishErrorMessage(
                saved.warning,
                t(
                  'Source saved with a connection warning. Test the connection before selecting content.'
                )
              )
            )
        } else {
          const saved = await createJellyfinMount(payload)
          message.success(t('Jellyfin Source added.'))
          if (saved.warning)
            message.warning(
              englishErrorMessage(
                saved.warning,
                t(
                  'Source saved with a connection warning. Test the connection before selecting content.'
                )
              )
            )
        }
      } else {
        const payload = {
          type: 'ftp' as const,
          name: name.trim(),
          serverUrl: serverUrl.trim() || null,
          port: portNum !== null && Number.isFinite(portNum) ? portNum : null,
          path: path.trim() || null,
          username: username.trim() || null,
          password: password || null,
          directLink: false,
        }
        if (editingMount) {
          await updateFTPMount(editingMount.id, payload)
          message.success(t('FTP Source updated.'))
        } else {
          await createFTPMount(payload)
          message.success(t('FTP Source added.'))
        }
      }

      onSuccess()
      onClose()
    } catch (err) {
      const msg = englishErrorMessage(
        err,
        t('Could not save the source. Check its settings and try again.')
      )
      setSubmitError(msg)
      message.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const modalTitle = editingMount ? 'Edit source' : 'Add source'
  const isFtp = formValues.type === 'ftp'
  const isWebdav = formValues.type === 'webdav'
  const isOpenlist = formValues.type === 'openlist'
  const isEmby = formValues.type === 'emby'
  const showDirectLink = isWebdav || isOpenlist || isEmby
  const isWebdavOrOpenlistInternal =
    (isWebdav || isOpenlist) && isInternalOpenListServer(formValues.serverUrl)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(modalTitle)}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={testing}
            onClick={handleTest}
          >
            {t('Test connection')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={submitting}
            onClick={handleSubmit}
          >
            {t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label={t('Source type')}
          options={TYPE_OPTIONS}
          value={formValues.type}
          disabled={!!editingMount}
          onChange={(value) => updateField('type', value as MountType)}
        />
        <Input
          label={t('Source name')}
          placeholder={t('Home NAS')}
          value={formValues.name}
          onChange={(e) => updateField('name', e.target.value)}
          error={errors.name}
        />
        <Input
          label={t('Server address')}
          placeholder={
            isEmby
              ? t('For example: http://192.168.1.100:8096')
              : isOpenlist
                ? t('openlist.example.com (/dav is added automatically)')
                : isWebdav
                  ? t('For example: https://dav.example.com')
                  : t('For example: ftp.example.com')
          }
          value={formValues.serverUrl}
          onChange={(e) => updateField('serverUrl', e.target.value)}
          error={errors.serverUrl}
        />
        {isEmby && (
          <Input
            label={t('API key (recommended)')}
            placeholder={t('Emby dashboard → Advanced → API keys')}
            value={formValues.apiKey}
            onChange={(e) => updateField('apiKey', e.target.value)}
            error={errors.apiKey}
          />
        )}
        {isFtp && (
          <InputNumber
            label={t('Port')}
            placeholder={t('For example: 21')}
            min={1}
            max={65535}
            value={formValues.port ? Number(formValues.port) : undefined}
            onChange={(value) =>
              updateField('port', value !== undefined ? String(value) : '')
            }
            error={errors.port}
          />
        )}
        {!isEmby && (
          <Input
            label={t('Path')}
            placeholder={t('For example: /videos')}
            value={formValues.path}
            onChange={(e) => updateField('path', e.target.value)}
          />
        )}
        <Input
          label={
            isEmby ? t('Username (alternative to API key)') : t('Username')
          }
          placeholder={t('Optional')}
          value={formValues.username}
          onChange={(e) => updateField('username', e.target.value)}
        />
        <InputPassword
          label={t('Password')}
          placeholder={
            editingMount
              ? t('Leave blank to clear the current password.')
              : t('Optional')
          }
          value={formValues.password}
          onChange={(e) => updateField('password', e.target.value)}
        />
        {showDirectLink && (
          <>
            <Switch
              label={t('Prefer a direct connection')}
              checked={
                isWebdavOrOpenlistInternal ? false : formValues.directLink
              }
              disabled={isWebdavOrOpenlistInternal}
              onChange={(e) => updateField('directLink', e.target.checked)}
            />
            {isWebdavOrOpenlistInternal && (
              <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                {t('This source uses a private address. Using server relay.')}
              </div>
            )}
          </>
        )}
        {submitError && (
          <div className="rounded border border-[var(--md-sys-color-error)] bg-[var(--md-sys-color-error-container)] px-3 py-2 text-xs text-[var(--md-sys-color-on-error-container)]">
            {t(submitError)}
          </div>
        )}
      </div>
    </Modal>
  )
}
