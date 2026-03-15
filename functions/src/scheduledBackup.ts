/**
 * 毎日自動バックアップを実行するスケジュール関数
 *
 * - 毎日AM3:00（JST）に実行
 * - 全ユーザーのデータをCloud Storageにエクスポート
 * - 7日分のバックアップを保持
 */
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

const db = admin.firestore()
const storage = admin.storage()

interface BackupResult {
  userId: string
  tasksCount: number
  listsCount: number
  tagsCount: number
  filePath: string
}

/**
 * ユーザーのデータをエクスポート
 */
async function exportUserData(userId: string): Promise<{
  lists: FirebaseFirestore.DocumentData[]
  tasks: FirebaseFirestore.DocumentData[]
  tags: FirebaseFirestore.DocumentData[]
}> {
  const [tasksDocs, listsDocs, tagsDocs] = await Promise.all([
    db.collection(`users/${userId}/tasks`).get(),
    db.collection(`users/${userId}/lists`).get(),
    db.collection(`users/${userId}/tags`).get(),
  ])

  const tasks = tasksDocs.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  const lists = listsDocs.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  const tags = tagsDocs.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  return { lists, tasks, tags }
}

/**
 * Cloud Storageにバックアップを保存
 */
async function saveBackupToStorage(
  userId: string,
  data: { lists: unknown[]; tasks: unknown[]; tags: unknown[] },
  date: string
): Promise<string> {
  const bucket = storage.bucket()
  const filePath = `backups/${userId}/${date}.json`
  const file = bucket.file(filePath)

  const backupData = {
    exportedAt: new Date().toISOString(),
    userId,
    ...data,
  }

  await file.save(JSON.stringify(backupData, null, 2), {
    contentType: 'application/json',
    metadata: {
      cacheControl: 'no-cache',
    },
  })

  return filePath
}

/**
 * 7日より古いバックアップを削除
 */
async function cleanupOldBackups(userId: string): Promise<number> {
  const bucket = storage.bucket()
  const [files] = await bucket.getFiles({ prefix: `backups/${userId}/` })

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 7)

  let deletedCount = 0

  for (const file of files) {
    const fileName = file.name.split('/').pop() || ''
    const dateStr = fileName.replace('.json', '')
    const fileDate = new Date(dateStr)

    if (fileDate < cutoffDate) {
      await file.delete()
      deletedCount++
    }
  }

  return deletedCount
}

/**
 * 毎日AM3:00（JST）に全ユーザーのデータをバックアップ
 */
export const dailyBackup = functions
  .region('asia-northeast1')
  .pubsub.schedule('0 3 * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async () => {
    const today = new Date().toISOString().split('T')[0]
    console.log(`Starting daily backup for ${today}`)

    // 全ユーザーを取得
    const usersSnapshot = await db.collection('users').get()
    const results: BackupResult[] = []

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id

      try {
        // ユーザーデータをエクスポート
        const data = await exportUserData(userId)

        // Cloud Storageに保存
        const filePath = await saveBackupToStorage(userId, data, today)

        // 古いバックアップを削除
        await cleanupOldBackups(userId)

        results.push({
          userId,
          tasksCount: data.tasks.length,
          listsCount: data.lists.length,
          tagsCount: data.tags.length,
          filePath,
        })

        console.log(`Backup completed for user ${userId}: ${data.tasks.length} tasks`)
      } catch (error) {
        console.error(`Backup failed for user ${userId}:`, error)
      }
    }

    console.log(`Daily backup completed. ${results.length} users backed up.`)
    return { success: true, results }
  })

/**
 * 手動バックアップ（テスト・緊急時用）
 */
export const manualBackup = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const { userId } = data
    if (!userId) {
      throw new functions.https.HttpsError('invalid-argument', 'userId is required')
    }

    const today = new Date().toISOString().split('T')[0]

    try {
      const exportData = await exportUserData(userId)
      const filePath = await saveBackupToStorage(userId, exportData, today)

      return {
        success: true,
        filePath,
        tasksCount: exportData.tasks.length,
        listsCount: exportData.lists.length,
        tagsCount: exportData.tags.length,
      }
    } catch (error) {
      throw new functions.https.HttpsError(
        'internal',
        error instanceof Error ? error.message : 'Backup failed'
      )
    }
  })

/**
 * バックアップ一覧を取得
 */
export const listBackups = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const { userId } = data
    if (!userId) {
      throw new functions.https.HttpsError('invalid-argument', 'userId is required')
    }

    const bucket = storage.bucket()
    const [files] = await bucket.getFiles({ prefix: `backups/${userId}/` })

    const backups = files.map((file) => {
      const fileName = file.name.split('/').pop() || ''
      const dateStr = fileName.replace('.json', '')
      return {
        date: dateStr,
        filePath: file.name,
        size: file.metadata.size,
      }
    })

    // 日付で降順ソート
    backups.sort((a, b) => b.date.localeCompare(a.date))

    return { backups }
  })

/**
 * バックアップからリストア
 */
export const restoreFromBackup = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const { userId, date } = data
    if (!userId || !date) {
      throw new functions.https.HttpsError('invalid-argument', 'userId and date are required')
    }

    const bucket = storage.bucket()
    const filePath = `backups/${userId}/${date}.json`
    const file = bucket.file(filePath)

    const [exists] = await file.exists()
    if (!exists) {
      throw new functions.https.HttpsError('not-found', 'Backup not found')
    }

    const [content] = await file.download()
    const backupData = JSON.parse(content.toString())

    // 現在のデータを削除
    const batch = db.batch()
    const collections = ['tasks', 'lists', 'tags'] as const

    for (const collectionName of collections) {
      const snapshot = await db.collection(`users/${userId}/${collectionName}`).get()
      snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    }
    await batch.commit()

    // バックアップからリストア
    for (const list of backupData.lists || []) {
      const { id, ...listData } = list
      await db.collection(`users/${userId}/lists`).doc(id).set(listData)
    }

    for (const task of backupData.tasks || []) {
      const { id, ...taskData } = task
      await db.collection(`users/${userId}/tasks`).doc(id).set(taskData)
    }

    for (const tag of backupData.tags || []) {
      const { id, ...tagData } = tag
      await db.collection(`users/${userId}/tags`).doc(id).set(tagData)
    }

    return {
      success: true,
      restored: {
        lists: (backupData.lists || []).length,
        tasks: (backupData.tasks || []).length,
        tags: (backupData.tags || []).length,
      },
    }
  })
