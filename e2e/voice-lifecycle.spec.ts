import { expect, test } from '@playwright/test'

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
})

test('Voice fake-media join, socket replacement, and unmount release resources', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const storageKey = '__voice_resource_stats'
    let stored: { streams: number; stoppedTracks: number } = {
      streams: 0,
      stoppedTracks: 0,
    }
    try {
      stored = JSON.parse(
        localStorage.getItem(storageKey) ?? JSON.stringify(stored)
      )
    } catch {
      // use a fresh in-memory counter
    }
    const stats = {
      streams: stored.streams ?? 0,
      stoppedTracks: stored.stoppedTracks ?? 0,
    }
    const persist = () =>
      localStorage.setItem(storageKey, JSON.stringify(stats))
    Object.defineProperty(window, '__voiceResourceStats', {
      value: stats,
      configurable: true,
    })
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.getUserMedia) return
    const original = mediaDevices.getUserMedia.bind(mediaDevices)
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints)
        stats.streams += 1
        persist()
        stream.getTracks().forEach((track) => {
          const stop = track.stop.bind(track)
          Object.defineProperty(track, 'stop', {
            configurable: true,
            value: () => {
              stats.stoppedTracks += 1
              persist()
              stop()
            },
          })
        })
        return stream
      },
    })
  })

  await page.goto('/login')
  await page.getByPlaceholder('Your username').fill('root')
  await page.getByPlaceholder('Your password').fill('root')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { __debugSocket?: { connected?: boolean } })
            .__debugSocket?.connected
        )
      )
    )
    .toBe(true)
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Room name' })
    .fill('Browser regression room')
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page).toHaveURL(/\/room\//)

  await page.getByTitle('Voice chat').click()
  await page.getByRole('button', { name: 'Join voice', exact: true }).click()
  await expect(page.getByText('1 online', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { streams: number }
            }
          ).__voiceResourceStats.streams
      )
    )
    .toBe(1)

  // Ordinary in-app navigation keeps the voice stream and room membership alive.
  await page.getByRole('button', { name: 'Hall', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(
    page.getByRole('complementary', { name: 'Active room' })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __voiceResourceStats: { streams: number; stoppedTracks: number }
          }
        ).__voiceResourceStats
    )
  ).toEqual({ streams: 1, stoppedTracks: 0 })
  await page
    .getByRole('button', { name: 'Return to room', exact: true })
    .click()
  await expect(page.getByText('1 online', { exact: true })).toBeVisible()

  const oldSocketId = await page.evaluate(() => {
    const socket = (
      window as unknown as {
        __debugSocket?: {
          id?: string
          disconnect: () => void
          connect: () => void
        }
      }
    ).__debugSocket
    if (!socket?.id) throw new Error('debug socket unavailable')
    const id = socket.id
    socket.disconnect()
    setTimeout(() => socket.connect(), 100)
    return id
  })
  await expect
    .poll(
      () =>
        page.evaluate((previousSocketId) => {
          const socket = (
            window as unknown as {
              __debugSocket?: { id?: string; connected?: boolean }
            }
          ).__debugSocket
          return socket?.connected && socket.id !== previousSocketId
            ? (socket.id ?? '')
            : ''
        }, oldSocketId),
      { timeout: 20_000 }
    )
    .toMatch(/.+/)
  await expect(page.getByText('1 online', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { streams: number; stoppedTracks: number }
            }
          ).__voiceResourceStats
      )
    )
    .toEqual({ streams: 2, stoppedTracks: 1 })

  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { stoppedTracks: number }
            }
          ).__voiceResourceStats.stoppedTracks
      )
    )
    .toBe(2)

  // Explicit room exit releases an active microphone even from the hall.
  await page.getByRole('button', { name: 'Join voice', exact: true }).click()
  await expect(page.getByText('1 online', { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { streams: number }
            }
          ).__voiceResourceStats.streams
      )
    )
    .toBe(3)
  await page.getByRole('button', { name: 'Hall', exact: true }).click()
  await page.getByRole('button', { name: 'Exit room', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { stoppedTracks: number }
            }
          ).__voiceResourceStats.stoppedTracks
      )
    )
    .toBe(3)
  await expect(
    page.getByRole('complementary', { name: 'Active room' })
  ).toHaveCount(0)

  await page.goto('/')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { stoppedTracks: number }
            }
          ).__voiceResourceStats.stoppedTracks
      )
    )
    .toBe(3)
})
