import { expect, test, type BrowserContext, type Page } from '@playwright/test'

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByPlaceholder('请输入用户名').fill(username)
  await page.getByPlaceholder('请输入密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('已连接', { exact: true })).toBeVisible()
}

async function createRoom(host: Page): Promise<string> {
  const result = await host.evaluate(() => new Promise<{ success?: boolean; data?: { roomId?: string } }>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket
    socket.emit('create-room', { mode: 'watch-together', requireApproval: false }, resolve)
  }))
  if (!result.success || !result.data?.roomId) throw new Error('create-room failed')
  await host.evaluate((roomId) => sessionStorage.setItem('zcontrol-host-room', roomId), result.data.roomId)
  await host.goto(`/room/${result.data.roomId}`)
  return result.data.roomId
}

async function musicState(page: Page): Promise<{
  queueItemId: number | null
  sourceRef: string | null
  musicGeneration: number
  version: number
}> {
  return page.evaluate(async () => {
    const { useMusicStore } = await import('/src/modules/music/store.ts')
    const state = useMusicStore.getState()
    return {
      queueItemId: state.currentQueueItemId,
      sourceRef: state.currentSourceRef,
      musicGeneration: state.musicGeneration,
      version: state.version,
    }
  })
}

test('Phase 5B-2A NCM login, explicit quality resolve, and room gateway work in Chromium', async ({ browser }) => {
  const host = await browser.newPage()
  let viewerContext: BrowserContext | null = null
  let viewer: Page | null = null
  const username = `phase5b2a_${Date.now()}`
  try {
    await login(host, 'root', 'root')
    const settings = await host.evaluate(async () => {
      const { apiFetch } = await import('/src/lib/api.ts')
      const response = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoDeleteInactiveRooms: true,
          autoDeleteAfterHours: 24,
          registrationMode: 'open',
          roomCreationMode: 'admin-only',
        }),
      })
      return response.ok
    })
    expect(settings).toBe(true)
    const registration = await host.request.post('/api/auth/register', {
      data: { username, password: 'phase5b2a-pass' },
    })
    expect(registration.ok()).toBe(true)

    const roomId = await createRoom(host)
    const hostPanel = host.locator('.glass-card').filter({ has: host.getByRole('heading', { name: '一起听' }) })
    await expect(hostPanel.getByTestId('ncm-status')).toContainText('网易云：未登录')
    await hostPanel.getByRole('button', { name: '扫码登录', exact: true }).click()
    await expect(hostPanel.getByAltText('网易云登录二维码')).toBeVisible()
    await expect(hostPanel.getByTestId('ncm-status')).toContainText('网易云：已登录', { timeout: 15_000 })

    await hostPanel.getByRole('textbox', { name: '音乐 sourceRef' }).fill('music://ncm/track/9001')
    await hostPanel.getByRole('textbox', { name: '歌曲名称' }).fill('NCM Gateway Fixture')
    await hostPanel.getByRole('button', { name: '添加歌曲', exact: true }).click()
    await expect.poll(async () => (await musicState(host)).sourceRef).toBe('music://ncm/track/9001')
    await expect.poll(async () => hostPanel.locator('audio').getAttribute('src')).toContain('/api/music/playback/')
    await expect.poll(async () => hostPanel.locator('audio').evaluate((audio) => audio.readyState)).toBeGreaterThan(0)

    const resolved = await host.evaluate(async ({ roomId }) => {
      const { useMusicStore } = await import('/src/modules/music/store.ts')
      const { apiPost } = await import('/src/lib/api.ts')
      const state = useMusicStore.getState()
      const raw = sessionStorage.getItem('zviewer-room-media-grant')
      const grant = raw ? (JSON.parse(raw) as { roomId?: string; grant?: string }).grant : ''
      const response = await apiPost('/api/music/resolve', {
        roomId,
        roomGrant: grant,
        queueItemId: state.currentQueueItemId,
        sourceRef: state.currentSourceRef,
        musicGeneration: state.musicGeneration,
        requestedQuality: 'exhigh',
      })
      return response.data
    }, { roomId }) as {
      descriptor?: { requestedQuality?: string; actualQuality?: string; availableQualities?: string[] }
      playbackUrl?: string
    }
    expect(resolved.descriptor?.requestedQuality).toBe('exhigh')
    expect(resolved.descriptor?.actualQuality).toBe('exhigh')
    expect(resolved.descriptor?.availableQualities).toContain('exhigh')
    expect(resolved.playbackUrl).toMatch(/^\/api\/music\/playback\/[A-Za-z0-9._-]+$/)
    expect(JSON.stringify(resolved)).not.toContain('MUSIC_U')
    expect(JSON.stringify(resolved)).not.toContain('127.0.0.1:3456')

    viewerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' })
    viewer = await viewerContext.newPage()
    await login(viewer, username, 'phase5b2a-pass')
    await viewer.goto(`/room/${roomId}`)
    const viewerPanel = viewer.locator('.glass-card').filter({ has: viewer.getByRole('heading', { name: '一起听' }) })
    await expect(viewerPanel).toBeVisible()
    await expect.poll(async () => viewerPanel.locator('audio').getAttribute('src')).toContain('/api/music/playback/')
    await expect.poll(async () => viewerPanel.locator('audio').evaluate((audio) => audio.readyState)).toBeGreaterThan(0)

    const viewerPlaybackUrl = await viewerPanel.locator('audio').getAttribute('src')
    expect(viewerPlaybackUrl).toContain('/api/music/playback/')
    const gatewayUrl = new URL(viewerPlaybackUrl!, 'http://127.0.0.1:5173')
    const gateway = await viewer.request.get(gatewayUrl.toString(), { headers: { Range: 'bytes=2-6' } })
    expect(gateway.status()).toBe(206)
    expect(gateway.headers()['content-range']).toMatch(/^bytes 2-6\//)
  } finally {
    if (viewer) await viewer.close()
    if (viewerContext) await viewerContext.close()
    await host.close()
  }
})
