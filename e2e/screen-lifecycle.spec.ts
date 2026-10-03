import { expect, test } from '@playwright/test'

test('Screen synthetic-media survives navigation and requires a manual restart after stopping or switching', async ({
  page,
}) => {
  test.setTimeout(60000)
  // A real CanvasCaptureMediaStreamTrack replaces the native picker. This covers
  // room, stream and UI lifecycles, while native OS capture remains a manual check.
  await page.addInitScript(() => {
    const tracks: MediaStreamTrack[] = []
    Object.defineProperty(window, '__screenFixtureTracks', { value: tracks })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 640
        canvas.height = 360
        const context = canvas.getContext('2d')!
        context.fillStyle = '#327fa8'
        context.fillRect(0, 0, 640, 360)
        const stream = canvas.captureStream(5)
        tracks.push(...stream.getVideoTracks())
        return stream
      },
    })
  })
  const captured = () =>
    page.evaluate(() => {
      const tracks = (
        window as unknown as { __screenFixtureTracks: MediaStreamTrack[] }
      ).__screenFixtureTracks
      return {
        total: tracks.length,
        live: tracks.filter((track) => track.readyState === 'live').length,
      }
    })
  const presenter = () =>
    page.evaluate(async () => {
      // @ts-ignore App module under test.
      const { useRoomExperienceStore } =
        await import('/src/store/roomExperienceStore.ts')
      return useRoomExperienceStore.getState().snapshot?.screenPresenter
    })
  await page.goto('/login')
  await page.getByPlaceholder('Your username').fill('root')
  await page.getByPlaceholder('Your password').fill('root')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Room name', exact: true })
    .fill('Screen lifecycle room')
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page).toHaveURL(/\/room\/[^/]+$/)
  await page.getByRole('button', { name: 'Screen', exact: true }).click()
  await page.getByRole('button', { name: 'Share screen', exact: true }).click()
  await expect.poll(captured).toEqual({ total: 1, live: 1 })
  const socketId = await page.evaluate(() => (window as any).__debugSocket.id)
  await expect.poll(presenter).toBe(socketId)
  await page.getByRole('button', { name: 'Hall', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(
    page.getByRole('complementary', { name: 'Active room' })
  ).toBeVisible()
  expect(await captured()).toEqual({ total: 1, live: 1 })
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).click()
  await expect.poll(captured).toEqual({ total: 1, live: 0 })
  await expect.poll(presenter).toBeNull()
  await page
    .getByRole('button', { name: 'Return to room', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Share screen', exact: true })
  ).toBeVisible()
  expect(await captured()).toEqual({ total: 1, live: 0 })
  await page.getByRole('button', { name: 'Share screen', exact: true }).click()
  await expect.poll(captured).toEqual({ total: 2, live: 1 })
  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  const warning = page.getByRole('dialog', {
    name: 'Stop sharing and switch?',
    exact: true,
  })
  await expect(warning).toContainText('You will need to start sharing again')
  await warning
    .getByRole('button', { name: 'Stop and switch', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Watch', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(captured).toEqual({ total: 2, live: 0 })
  await expect.poll(presenter).toBeNull()
  await page.getByRole('button', { name: 'Screen', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Share screen', exact: true })
  ).toBeVisible()
  expect(await captured()).toEqual({ total: 2, live: 0 })
  await page.getByRole('button', { name: 'Leave room', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  expect(await captured()).toEqual({ total: 2, live: 0 })
})
