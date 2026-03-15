import { test } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotsDir = path.join(__dirname, '..', 'screenshots')

const devices = [
  { name: 'mobile', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]

// モックユーザー情報
const mockUser = {
  uid: 'test-user-123',
  email: 'test@example.com',
  displayName: 'Test User',
  photoURL: null,
}

// モックリスト
const mockLists = [
  { id: 'list-1', name: 'Inbox', position: 0 },
  { id: 'list-2', name: '仕事', position: 1 },
]

// モックタスク（ソート機能確認用に異なる優先度と名前）
// dateCreatedは数値で保存（JSON.stringifyでシリアライズ可能）
const mockTasks = [
  {
    id: 'task-1',
    name: 'りんごを買う',
    listId: 'list-1',
    parentId: null,
    priority: 3,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [],
    url: null,
    completed: false,
    dateCompleted: null,
    dateCreated: 1700000001000,
    dateModified: 1700000001000,
  },
  {
    id: 'task-2',
    name: 'Apple Storeに行く',
    listId: 'list-1',
    parentId: null,
    priority: 1,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: ['メモ1'],
    url: 'https://apple.com',
    completed: false,
    dateCompleted: null,
    dateCreated: 1700000002000,
    dateModified: 1700000002000,
  },
  {
    id: 'task-3',
    name: 'バナナを買う',
    listId: 'list-1',
    parentId: null,
    priority: 1,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [],
    url: null,
    completed: false,
    dateCompleted: null,
    dateCreated: 1700000003000,
    dateModified: 1700000003000,
  },
  {
    id: 'task-4',
    name: 'あいうえお',
    listId: 'list-1',
    parentId: null,
    priority: 2,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [],
    url: null,
    completed: false,
    dateCompleted: null,
    dateCreated: 1700000004000,
    dateModified: 1700000004000,
  },
  {
    id: 'task-5',
    name: 'Zから始まるタスク',
    listId: 'list-1',
    parentId: null,
    priority: 4,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [],
    url: null,
    completed: true,
    dateCompleted: 1700000010000,
    dateCreated: 1700000005000,
    dateModified: 1700000010000,
  },
  {
    id: 'subtask-1',
    name: 'サブタスク1',
    listId: 'list-1',
    parentId: 'task-2',
    priority: 2,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [],
    url: null,
    completed: false,
    dateCompleted: null,
    dateCreated: 1700000006000,
    dateModified: 1700000006000,
  },
  {
    id: 'subtask-2',
    name: 'サブタスク2',
    listId: 'list-1',
    parentId: 'task-2',
    priority: 1,
    tags: [],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [],
    url: null,
    completed: false,
    dateCompleted: null,
    dateCreated: 1700000007000,
    dateModified: 1700000007000,
  },
]

test.describe('レスポンシブデザイン確認 - ログイン画面', () => {
  for (const device of devices) {
    test(`${device.name} (${device.width}x${device.height}) のスクリーンショット`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height })

      // ログインページ
      await page.goto('/login')
      await page.waitForLoadState('networkidle')
      await page.screenshot({
        path: path.join(screenshotsDir, `${device.name}-${device.width}x${device.height}-login.png`),
        fullPage: true,
      })
    })
  }
})

test.describe('レスポンシブデザイン確認 - 認証後', () => {
  for (const device of devices) {
    test(`${device.name} (${device.width}x${device.height}) ホーム画面`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height })

      // モック認証状態とデータを設定
      await page.addInitScript(
        ({ user, lists, tasks }) => {
          const authState = {
            user: user,
            loading: false,
            error: null,
          }
          localStorage.setItem('mock-auth-state', JSON.stringify(authState))
          localStorage.setItem('mock-lists-data', JSON.stringify(lists))
          localStorage.setItem('mock-tasks-data', JSON.stringify(tasks))
        },
        { user: mockUser, lists: mockLists, tasks: mockTasks }
      )

      // ホームページ
      await page.goto('/')
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(1000) // UI安定待機
      await page.screenshot({
        path: path.join(screenshotsDir, `${device.name}-${device.width}x${device.height}-home.png`),
        fullPage: true,
      })
    })

    test(`${device.name} (${device.width}x${device.height}) インポート画面`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height })

      // モック認証状態とデータを設定
      await page.addInitScript(
        ({ user, lists, tasks }) => {
          const authState = {
            user: user,
            loading: false,
            error: null,
          }
          localStorage.setItem('mock-auth-state', JSON.stringify(authState))
          localStorage.setItem('mock-lists-data', JSON.stringify(lists))
          localStorage.setItem('mock-tasks-data', JSON.stringify(tasks))
        },
        { user: mockUser, lists: mockLists, tasks: mockTasks }
      )

      // インポートページ
      await page.goto('/import')
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(500)
      await page.screenshot({
        path: path.join(screenshotsDir, `${device.name}-${device.width}x${device.height}-import.png`),
        fullPage: true,
      })
    })
  }
})

test.describe('ソート機能確認', () => {
  test('デスクトップでソート切り替え', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    // モック認証状態とデータを設定
    await page.addInitScript(
      ({ user, lists, tasks }) => {
        const authState = {
          user: user,
          loading: false,
          error: null,
        }
        localStorage.setItem('mock-auth-state', JSON.stringify(authState))
        localStorage.setItem('mock-lists-data', JSON.stringify(lists))
        localStorage.setItem('mock-tasks-data', JSON.stringify(tasks))
      },
      { user: mockUser, lists: mockLists, tasks: mockTasks }
    )

    // ホームページ
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1000)

    // 名前順（デフォルト）でスクリーンショット
    await page.screenshot({
      path: path.join(screenshotsDir, 'sort-by-name.png'),
      fullPage: true,
    })

    // 作成日順に切り替え
    await page.click('button:has-text("作成日")')
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(screenshotsDir, 'sort-by-created.png'),
      fullPage: true,
    })
  })
})

test.describe('タスク選択・サブタスク表示確認', () => {
  for (const device of devices) {
    test(`${device.name} (${device.width}x${device.height}) タスク選択とサブタスク`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height })

      // モック認証状態とデータを設定
      await page.addInitScript(
        ({ user, lists, tasks }) => {
          const authState = {
            user: user,
            loading: false,
            error: null,
          }
          localStorage.setItem('mock-auth-state', JSON.stringify(authState))
          localStorage.setItem('mock-lists-data', JSON.stringify(lists))
          localStorage.setItem('mock-tasks-data', JSON.stringify(tasks))
        },
        { user: mockUser, lists: mockLists, tasks: mockTasks }
      )

      // ホームページ
      await page.goto('/')
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(1000)

      // タスクを選択
      await page.click('text=Apple Storeに行く')
      await page.waitForTimeout(300)

      // 展開ボタンをクリック（存在する場合）
      const expandButton = page.locator('[data-testid="expand-button"]').first()
      if (await expandButton.isVisible()) {
        await expandButton.click()
        await page.waitForTimeout(300)
      }

      await page.screenshot({
        path: path.join(screenshotsDir, `${device.name}-${device.width}x${device.height}-task-selected.png`),
        fullPage: true,
      })
    })
  }
})
