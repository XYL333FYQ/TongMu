import { expect, test, type Page } from '@playwright/test'

async function waitForSocket(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Boolean(
            (window as unknown as { __debugSocket?: { connected?: boolean } })
              .__debugSocket?.connected
          )
      )
    )
    .toBe(true)
}

async function loginAndCreateWatchRoom(page: Page): Promise<string> {
  await page.goto('/login')
  await page.getByPlaceholder('请输入用户名').fill('root')
  await page.getByPlaceholder('请输入密码').fill('root')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await waitForSocket(page)
  const result = await page.evaluate(
    () =>
      new Promise<{ success?: boolean; data?: { roomId?: string } }>(
        (resolve) => {
          const socket = (
            window as unknown as { __debugSocket: { emit: Function } }
          ).__debugSocket
          socket.emit(
            'create-room',
            { mode: 'watch-together', requireApproval: false },
            resolve
          )
        }
      )
  )
  if (!result.success || !result.data?.roomId)
    throw new Error('create-room failed')
  return result.data.roomId
}

test('stale persisted autoLoginStatus cannot redirect a first room visit', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'zcontrol-auth-storage',
      JSON.stringify({
        state: {
          user: null,
          isAuthenticated: false,
          autoLoginStatus: 'done',
          hasLoggedOut: false,
        },
        version: 0,
      })
    )
  })
  await page.route('**/api/auth/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750))
    await route.continue()
  })

  await page.goto('/room/bootstrap-race')
  await page.waitForTimeout(150)
  await expect(page).toHaveURL(/\/room\/bootstrap-race$/)
  await expect(page).not.toHaveURL(/\/login$/)
  await waitForSocket(page)
})

test('explicitly reselecting a failed movie retries once while state refreshes stay fenced', async ({
  page,
}) => {
  const roomId = await loginAndCreateWatchRoom(page)
  await page.evaluate((targetRoomId) => {
    sessionStorage.setItem('zcontrol-host-room', targetRoomId)
  }, roomId)
  await page.goto(`/room/${roomId}`)
  await waitForSocket(page)

  const fixtureOrigin = 'http://127.0.0.1:3456'
  await page.evaluate(async ({ targetRoomId, fixtureOrigin }) => {
    const { useRoomStore } = await import('/src/store/roomStore.ts')
    const store = useRoomStore.getState()
    await store.addMovie(targetRoomId, {
      title: 'Failed fixture A',
      source: 'bilibili',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    })
    await store.addMovie(targetRoomId, {
      title: 'Playable fixture B',
      source: 'mp4',
      url: `${fixtureOrigin}/normal.mp4`,
      format: 'mp4',
    })
  }, { targetRoomId: roomId, fixtureOrigin })

  let attempts = 0
  await page.route('**/api/stream/media/resolve', async (route) => {
    const body = route.request().postDataJSON() as { input?: string }
    if (body.input?.includes('BV1xx411c7mD')) {
      attempts += 1
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'fixture resolve failure' }),
    })
  })

  await expect(page.getByText('Failed fixture A', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Playable fixture B', { exact: true }).last()).toBeVisible()
  const movieRow = (title: string) =>
    page
      .locator('.movie-list-scroll:visible .zen-item-enter:visible')
      .filter({ hasText: title })

  await movieRow('Failed fixture A').getByTitle('播放').click()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await expect.poll(() => attempts).toBe(1)

  // Ordinary list and playback-state refreshes must not clear the failed-ID fence.
  await page.evaluate(async () => {
    const { useRoomStore } = await import('/src/store/roomStore.ts')
    const store = useRoomStore.getState()
    store.setMovies([...store.movies])
    store.setWatchTogether({ playbackRate: 1.25 })
  })
  await expect.poll(() => attempts).toBe(1)

  await movieRow('Playable fixture B').getByTitle('播放').click()
  await expect
    .poll(() => page.evaluate(async () => {
      const { useRoomStore } = await import('/src/store/roomStore.ts')
      return useRoomStore.getState().watchTogether.sourceUrl
    }))
    .toBe(`${fixtureOrigin}/normal.mp4`)
  await expect.poll(() => attempts).toBe(1)

  await movieRow('Failed fixture A').getByTitle('播放').click()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await expect.poll(() => attempts).toBe(2)

  // The second failure re-enters the same fence, and the existing retry button
  // still explicitly grants one more attempt for the current movie.
  await page.evaluate(async () => {
    const { useRoomStore } = await import('/src/store/roomStore.ts')
    const store = useRoomStore.getState()
    store.setMovies([...store.movies])
    store.setWatchTogether({ playbackRate: 1 })
  })
  await expect.poll(() => attempts).toBe(2)

  await page.getByRole('button', { name: '重试' }).click({ force: true })
  await expect.poll(() => attempts).toBe(3)
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await page.evaluate(async () => {
    const { useRoomStore } = await import('/src/store/roomStore.ts')
    const store = useRoomStore.getState()
    store.setMovies([...store.movies])
    store.setWatchTogether({ playbackRate: 1.1 })
  })
  await expect.poll(() => attempts).toBe(3)
})

test('viewer ALREADY_IN_ROOM retries are bounded and can recover', async ({
  browser,
}) => {
  const host = await browser.newPage()
  const roomId = await loginAndCreateWatchRoom(host)

  const viewer = await browser.newPage()
  await viewer.goto('/')
  await waitForSocket(viewer)
  await viewer.evaluate(() => {
    const socket = (
      window as unknown as {
        __debugSocket: {
          emit: (event: string, ...args: unknown[]) => unknown
          __releaseRetryAttempts?: number
          __releaseJoinSucceeded?: boolean
        }
      }
    ).__debugSocket
    const originalEmit = socket.emit.bind(socket)
    socket.emit = (event: string, ...args: unknown[]) => {
      if (event === 'request-join') {
        socket.__releaseRetryAttempts =
          (socket.__releaseRetryAttempts ?? 0) + 1
        if (socket.__releaseRetryAttempts <= 2) {
          const callback = args.at(-1)
          if (typeof callback === 'function') {
            queueMicrotask(() =>
              callback({
                success: false,
                code: 'ALREADY_IN_ROOM',
                message: 'fixture stale session',
              })
            )
          }
          return socket
        }
        const callback = args.at(-1)
        if (typeof callback === 'function') {
          args[args.length - 1] = (response: { success?: boolean }) => {
            socket.__releaseJoinSucceeded = response.success === true
            callback(response)
          }
        }
      }
      return originalEmit(event, ...args)
    }
  })
  await viewer.evaluate((targetRoomId) => {
    history.pushState({}, '', `/room/${targetRoomId}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, roomId)

  await expect
    .poll(() =>
      viewer.evaluate(
        () =>
          (
            window as unknown as {
              __debugSocket: { __releaseRetryAttempts?: number }
            }
          ).__debugSocket.__releaseRetryAttempts ?? 0
      ),
      { timeout: 10_000 }
    )
    .toBe(3)
  await expect(viewer).toHaveURL(new RegExp(`/room/${roomId}$`))
  await expect
    .poll(() =>
      viewer.evaluate(
        () =>
          (
            window as unknown as {
              __debugSocket: { __releaseJoinSucceeded?: boolean }
            }
          ).__debugSocket.__releaseJoinSucceeded ?? false
      )
    )
    .toBe(true)

  await viewer.close()
  await host.close()
})

test('host register ALREADY_IN_ROOM retries are bounded and can recover', async ({
  page,
}) => {
  const roomId = await loginAndCreateWatchRoom(page)
  await page.evaluate((targetRoomId) => {
    sessionStorage.setItem('zcontrol-host-room', targetRoomId)
    const socket = (
      window as unknown as {
        __debugSocket: {
          emit: (event: string, ...args: unknown[]) => unknown
          __releaseHostRetryAttempts?: number
          __releaseHostRegisterSucceeded?: boolean
        }
      }
    ).__debugSocket
    const originalEmit = socket.emit.bind(socket)
    socket.emit = (event: string, ...args: unknown[]) => {
      if (event === 'register-host') {
        socket.__releaseHostRetryAttempts =
          (socket.__releaseHostRetryAttempts ?? 0) + 1
        const callback = args.at(-1)
        if (socket.__releaseHostRetryAttempts <= 2) {
          if (typeof callback === 'function') {
            queueMicrotask(() =>
              callback({
                success: false,
                code: 'ALREADY_IN_ROOM',
                message: 'fixture stale host session',
              })
            )
          }
          return socket
        }
        if (typeof callback === 'function') {
          args[args.length - 1] = (response: { success?: boolean }) => {
            socket.__releaseHostRegisterSucceeded = response.success === true
            callback(response)
          }
        }
      }
      return originalEmit(event, ...args)
    }
    history.pushState({}, '', `/room/${targetRoomId}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, roomId)

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __debugSocket: { __releaseHostRetryAttempts?: number }
            }
          ).__debugSocket.__releaseHostRetryAttempts ?? 0
      ),
      { timeout: 10_000 }
    )
    .toBe(3)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __debugSocket: { __releaseHostRegisterSucceeded?: boolean }
            }
          ).__debugSocket.__releaseHostRegisterSucceeded ?? false
      )
    )
    .toBe(true)
  await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`))
})
