import { expect } from 'e2e'
import { test, seedDocument } from './fixture'

const functionsOrigin = 'http://127.0.0.1:15001'

test('背景復帰後も集計値とリストの更新を表示する', async ({ app, screen, browser, demoUser }) => {
  const uid = demoUser.uid
  const now = new Date()
  const counts = { today: 1, tomorrow: 0, overdue: 0, thisWeek: 1, noDate: 0 }
  const list = { name: '検証リスト', position: 0, incompleteTaskCount: 1, dateCreated: now, dateModified: now }
  const task = {
    name: '検証タスク', listId: 'verification-list', completed: false, deleted: false,
    parentId: null, priority: 4, tags: [], notes: [], dueDate: now, startDate: null,
    repeat: null, url: null, dateCompleted: null, dateCreated: now, dateModified: now,
    allDay: true, addToCalendar: false, calendarEventId: null,
  }
  await seedDocument(`users/${uid}`, { smartListCounts: counts })
  // 通常起動はInboxを優先選択するため、既存Inboxも架空データで用意する。
  await seedDocument(`users/${uid}/lists/verification-inbox`, { ...list, name: 'Inbox', position: 1, incompleteTaskCount: 0 })
  await seedDocument(`users/${uid}/lists/verification-list`, list)
  await seedDocument(`users/${uid}/tasks/verification-task`, task)
  await browser.addInitScript(({ uid }) => {
    // このテストでは内部ストアへのモック注入を外し、専用Emulatorを購読する。
    localStorage.removeItem('mock-lists-data')
    localStorage.removeItem('mock-tasks-data')
    localStorage.setItem(`rertm-personal-space-migrated-${uid}`, 'true')
  }, { uid })
  // HomeViewが初期化時に取得する設定も、専用Functions無しでローカル応答する。
  await browser.route(`${functionsOrigin}/**/getGoogleCalendarServiceConfig`, async (route) => {
    await route.fulfill({
      json: { data: { serviceAccountEmail: '' } },
      headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    })
  })
  const refreshRequests: unknown[] = []
  let refreshFinished: (() => void) | undefined
  let refreshResponse = new Promise<void>((resolve) => { refreshFinished = resolve })
  await browser.route(`${functionsOrigin}/**/refreshSmartListCounts`, async (route) => {
    // Functionsを起動せず、当該callableだけをローカルで応答する。
    if (route.request.method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      } })
      return
    }
    refreshRequests.push(JSON.parse(route.request.postData ?? '{}'))
    await route.fulfill({ json: { data: counts }, headers: { 'Access-Control-Allow-Origin': '*' } })
    refreshFinished?.()
  })
  await app.open('/')
  await refreshResponse
  await screen.getByRole('button', 'メニュー').tap()
  await screen.getByRole('listitem').filter({ hasText: '検証リスト' }).tap()
  await expect(screen.getByText('検証タスク', { exact: true })).toBeVisible()
  await screen.getByRole('button', 'メニュー').tap()
  await expect(screen.getByRole('button', '📅 今日 1')).toBeVisible()
  await app.screenshot('task-counts-initial')
  await screen.getByRole('listitem').filter({ hasText: '検証リスト' }).tap()

  refreshResponse = new Promise<void>((resolve) => { refreshFinished = resolve })
  await browser.evaluate(() => {
    // 復帰判定の時刻だけを進め、固定待機なしで31秒の背景滞在を再現する。
    const originalNow = Date.now
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    const startedAt = originalNow()
    try {
      Date.now = () => startedAt
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      Date.now = () => startedAt + 31_000
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      Date.now = originalNow
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      else Reflect.deleteProperty(document, 'visibilityState')
    }
    return null
  })
  await refreshResponse
  expect(refreshRequests).toEqual([
    { data: { spaceId: `personal_${uid}`, useLegacyPath: true, preferCached: true } },
    { data: { spaceId: `personal_${uid}`, useLegacyPath: true, preferCached: true } },
  ])
  await expect(screen.getByText('検証タスク', { exact: true })).toBeVisible()

  // 復帰で再構築した購読が、その後のサーバー更新も受け取ることを確認する。
  await seedDocument(`users/${uid}/tasks/verification-task`, { ...task, name: '更新後の検証タスク' })
  await seedDocument(`users/${uid}/lists/verification-list`, { ...list, name: '更新後の検証リスト' })
  await seedDocument(`users/${uid}`, { smartListCounts: { ...counts, today: 2, thisWeek: 2 } })
  await expect(screen.getByText('更新後の検証タスク', { exact: true })).toBeVisible()
  await screen.getByRole('button', 'メニュー').tap()
  await expect(screen.getByRole('button', '📅 今日 2')).toBeVisible()
  await expect(screen.getByRole('listitem').filter({ hasText: '更新後の検証リスト' })).toBeVisible()
  await app.screenshot('task-counts-resumed')
})
