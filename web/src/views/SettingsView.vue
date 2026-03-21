<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onMounted, watch } from 'vue'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import type { SpaceMember, SpaceMeta } from '@/types'
// import { useCalendarStore } from '@/stores/calendar' // TODO: カレンダー機能を一時無効化
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'
import { useListsStore } from '@/stores/lists'
import { useTasksStore } from '@/stores/tasks'
import { useRouter } from 'vue-router'
import { getFunctions, httpsCallable } from 'firebase/functions'
import {
  createFamilySpaceApi,
  updateFamilySpaceNameApi,
} from '@/services/cloudFunctionsService'
import { db } from '@/services/firebase'
import {
  clearAllUserData,
  exportUserData,
  importRTMData,
  parseRTMExportFile,
  type ClearResult,
  type ImportProgress,
  type ImportResult,
} from '@/services/importService'

// const calendarStore = useCalendarStore() // TODO: カレンダー機能を一時無効化
const authStore = useAuthStore()
const spaceStore = useSpaceStore()
const listsStore = useListsStore()
const tasksStore = useTasksStore()
const router = useRouter()
const NewsPreferencesSection = defineAsyncComponent(() => import('@/components/settings/NewsPreferencesSection.vue'))
const MobileNotificationSection = defineAsyncComponent(() => import('@/components/settings/MobileNotificationSection.vue'))
const familySpaceName = ref('家族スペース')
const currentSpaceNameInput = ref('')
const familySpaceLoading = ref(false)
const currentSpaceMembers = ref<SpaceMember[]>([])
const currentSpaceMeta = ref<SpaceMeta | null>(null)
const membersLoading = ref(false)
const spaceNameSaving = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const importing = ref(false)
const clearing = ref(false)
const exporting = ref(false)
const migrating = ref(false)
const progress = ref<ImportProgress | null>(null)
const importResult = ref<ImportResult | null>(null)
const clearResult = ref<ClearResult | null>(null)
const maintenanceError = ref<string | null>(null)
const migrationMessage = ref('')

const currentSpaceName = computed(() => {
  if (!spaceStore.currentSpaceId) return '未設定'
  const membership = spaceStore.memberships.find((item) => item.spaceId === spaceStore.currentSpaceId)
  if (membership?.displayName) return membership.displayName
  if (spaceStore.currentSpaceId.startsWith('personal_')) return '個人スペース'
  return spaceStore.currentSpaceId
})

const currentSpaceTypeLabel = computed(() => {
  if (!spaceStore.currentSpaceId) return '未選択'
  return spaceStore.currentSpaceId.startsWith('personal_') ? '個人' : '共有'
})

const isSharedSpaceSelected = computed(() =>
  !!spaceStore.currentSpaceId && !spaceStore.currentSpaceId.startsWith('personal_') && !spaceStore.useLegacyPath
)

const currentMembership = computed(() =>
  spaceStore.memberships.find((item) => item.spaceId === spaceStore.currentSpaceId) ?? null
)

const canManageCurrentSpace = computed(() =>
  isSharedSpaceSelected.value && currentMembership.value?.role === 'owner'
)

const progressPercent = computed(() => {
  if (!progress.value || progress.value.total === 0) return 0
  return Math.round((progress.value.current / progress.value.total) * 100)
})

const goBack = () => {
  if (window.history.state && window.history.state.back) {
    router.back()
  } else {
    router.push({ name: 'home' })
  }
}

/* TODO: カレンダー機能を一時無効化
// APIキー入力フォーム
const inputClientId = ref(calendarStore.clientId)
const inputClientSecret = ref('')

async function handleSaveApiConfig() {
  await calendarStore.saveApiConfig(inputClientId.value, inputClientSecret.value)
  inputClientSecret.value = '' // 保存後はシークレット欄をクリア
}

async function handleConnect() {
  await calendarStore.connect()
}

async function handleDisconnect() {
  if (!confirm('Googleカレンダーとの連携を解除しますか？')) return
  await calendarStore.disconnect()
}
*/

onMounted(async () => {
  await spaceStore.initSpace()
  await loadCurrentSpaceDetails()
})

watch(
  () => spaceStore.currentSpaceId,
  () => {
    loadCurrentSpaceDetails()
  }
)

async function handleCreateFamilySpace(): Promise<void> {
  const name = familySpaceName.value.trim()
  if (!name) return

  familySpaceLoading.value = true
  try {
    const result = await createFamilySpaceApi(name, authStore.user?.displayName ?? null)
    await spaceStore.initSpace(true)
    spaceStore.selectSpace(result.spaceId)
    currentSpaceNameInput.value = result.name
    alert(`共有スペース「${result.name}」を作成しました`)
  } catch (error) {
    alert(error instanceof Error ? error.message : '共有スペースの作成に失敗しました')
  } finally {
    familySpaceLoading.value = false
  }
}

async function loadCurrentSpaceDetails(): Promise<void> {
  if (!spaceStore.currentSpaceId || spaceStore.useLegacyPath) {
    currentSpaceMembers.value = []
    currentSpaceMeta.value = null
    return
  }

  membersLoading.value = true
  try {
    const [spaceSnapshot, membersSnapshot] = await Promise.all([
      getDoc(doc(db, 'spaces', spaceStore.currentSpaceId)),
      getDocs(collection(db, 'spaces', spaceStore.currentSpaceId, 'members')),
    ])

    currentSpaceMeta.value = spaceSnapshot.exists()
      ? {
          id: spaceSnapshot.id,
          ...(spaceSnapshot.data() as Omit<SpaceMeta, 'id'>),
        }
      : null
    currentSpaceNameInput.value = currentSpaceMeta.value?.name ?? ''

    currentSpaceMembers.value = membersSnapshot.docs
      .map((documentSnapshot) => ({
        uid: documentSnapshot.id,
        ...(documentSnapshot.data() as Omit<SpaceMember, 'uid'>),
      }))
      .sort((a, b) => {
        if (a.role === 'owner' && b.role !== 'owner') return -1
        if (a.role !== 'owner' && b.role === 'owner') return 1
        return (a.displayName || a.email || a.uid).localeCompare(b.displayName || b.email || b.uid, 'ja')
      })
  } finally {
    membersLoading.value = false
  }
}

async function handleUpdateSpaceName(): Promise<void> {
  if (!spaceStore.currentSpaceId || !canManageCurrentSpace.value) return
  const name = currentSpaceNameInput.value.trim()
  if (!name) return

  spaceNameSaving.value = true
  try {
    await updateFamilySpaceNameApi(spaceStore.currentSpaceId, name)
    await Promise.all([
      spaceStore.initSpace(true),
      loadCurrentSpaceDetails(),
    ])
    alert('スペース名を更新しました')
  } catch (error) {
    alert(error instanceof Error ? error.message : 'スペース名の更新に失敗しました')
  } finally {
    spaceNameSaving.value = false
  }
}

function handleFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement
  if (!input.files?.[0]) return
  selectedFile.value = input.files[0]
  maintenanceError.value = null
  importResult.value = null
}

async function reloadScopedData(): Promise<void> {
  listsStore.unsubscribe()
  tasksStore.unsubscribe()
  await listsStore.subscribe()
  tasksStore.subscribe()
}

async function handleImport(): Promise<void> {
  if (!selectedFile.value || !authStore.user) return

  importing.value = true
  maintenanceError.value = null
  importResult.value = null
  clearResult.value = null
  progress.value = null

  try {
    const content = await selectedFile.value.text()
    const data = parseRTMExportFile(content)
    const result = await importRTMData(
      authStore.user.uid,
      data,
      (nextProgress) => {
        progress.value = nextProgress
      },
      {
        spaceId: spaceStore.currentSpaceId,
        useLegacyPath: spaceStore.useLegacyPath,
      }
    )

    importResult.value = result
    if (!result.success) {
      maintenanceError.value = result.error ?? 'インポートに失敗しました'
      return
    }

    await reloadScopedData()
  } catch (error) {
    maintenanceError.value = error instanceof Error ? error.message : 'ファイルの読み込みに失敗しました'
  } finally {
    importing.value = false
  }
}

async function handleExport(): Promise<void> {
  if (!authStore.user) return

  exporting.value = true
  maintenanceError.value = null

  try {
    const data = await exportUserData(authStore.user.uid, {
      spaceId: spaceStore.currentSpaceId,
      useLegacyPath: spaceStore.useLegacyPath,
    })
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `rertm-backup-${new Date().toISOString().split('T')[0]}.json`
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    maintenanceError.value = error instanceof Error ? error.message : 'エクスポートに失敗しました'
  } finally {
    exporting.value = false
  }
}

async function handleClear(): Promise<void> {
  if (!authStore.user) return
  if (!confirm('現在のスペース内のデータをすべて削除しますか？この操作は取り消せません。')) return

  clearing.value = true
  maintenanceError.value = null
  clearResult.value = null
  importResult.value = null

  try {
    const result = await clearAllUserData(authStore.user.uid, {
      spaceId: spaceStore.currentSpaceId,
      useLegacyPath: spaceStore.useLegacyPath,
    })
    clearResult.value = result
    if (!result.success) {
      maintenanceError.value = result.error ?? '削除に失敗しました'
      return
    }

    await reloadScopedData()
  } catch (error) {
    maintenanceError.value = error instanceof Error ? error.message : '削除に失敗しました'
  } finally {
    clearing.value = false
  }
}

async function handleRunDataMigration(): Promise<void> {
  if (!authStore.user || migrating.value) return
  if (!confirm('現在のスペースの全タスクに deleted: false と parentId: null を補完します。続行しますか？')) return

  migrating.value = true
  maintenanceError.value = null
  migrationMessage.value = '更新を開始しています...'

  try {
    await spaceStore.initSpace()
    const tasksRef = spaceStore.getCollectionRef('tasks')
    const snapshot = await getDocs(tasksRef)

    migrationMessage.value = `総タスク数: ${snapshot.size}`

    const functions = getFunctions(undefined, 'asia-northeast1')
    const migrateTaskCounts = httpsCallable<
      { userId: string; spaceId: string | null; useLegacyPath: boolean },
      { success: boolean; listsUpdated: number }
    >(
      functions,
      'migrateTaskCounts'
    )

    const { writeBatch } = await import('firebase/firestore')

    let updatedCount = 0
    let skippedCount = 0
    let batch = writeBatch(db)
    let batchCount = 0

    for (const taskDoc of snapshot.docs) {
      const taskData = taskDoc.data()
      if (taskData.deleted === undefined || taskData.parentId === undefined) {
        batch.update(taskDoc.ref, {
          ...(taskData.deleted === undefined ? { deleted: false } : {}),
          ...(taskData.parentId === undefined ? { parentId: null } : {}),
        })
        batchCount++
        updatedCount++

        if (batchCount === 500) {
          await batch.commit()
          migrationMessage.value = `${updatedCount}件更新完了...`
          batch = writeBatch(db)
          batchCount = 0
        }
      } else {
        skippedCount++
      }
    }

    if (batchCount > 0) {
      await batch.commit()
    }

    const migrateResponse = await migrateTaskCounts({
      userId: authStore.user.uid,
      spaceId: spaceStore.currentSpaceId,
      useLegacyPath: spaceStore.useLegacyPath,
    })

    migrationMessage.value = `完了: 補完 ${updatedCount}件 / 既存 ${skippedCount}件 / タスク数更新 ${migrateResponse.data.listsUpdated}件`
    await reloadScopedData()
  } catch (error) {
    maintenanceError.value = error instanceof Error ? error.message : 'データ更新に失敗しました'
    migrationMessage.value = ''
  } finally {
    migrating.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 pt-[49px]">
    <!-- ヘッダー -->
    <header class="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shadow-sm">
      <button
        @click="goBack"
        class="text-gray-500 hover:text-gray-700 text-sm"
      >
        ← 戻る
      </button>
      <h1 class="text-base font-semibold text-gray-800">設定</h1>
    </header>

    <div class="max-w-lg mx-auto px-4 py-6 space-y-6">

      <!-- TODO: カレンダー機能を一時無効化
      <!- - Google Calendar APIキー設定 - ->
      <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <h2 class="text-sm font-semibold text-gray-700">Google Calendar APIキー設定</h2>
          <p class="text-xs text-gray-500 mt-0.5">
            Google Cloud Console で取得したOAuth 2.0クライアントIDとシークレットを入力してください
          </p>
        </div>
        <div class="px-4 py-4 space-y-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">クライアントID</label>
            <input
              v-model="inputClientId"
              type="text"
              placeholder="xxxxx.apps.googleusercontent.com"
              class="w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">クライアントシークレット</label>
            <input
              v-model="inputClientSecret"
              type="password"
              placeholder="設定済みの場合は変更する場合のみ入力"
              class="w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            @click="handleSaveApiConfig"
            :disabled="calendarStore.apiConfigSaving || !inputClientId"
            class="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span v-if="calendarStore.apiConfigSaving">保存中...</span>
            <span v-else-if="calendarStore.apiConfigSaved">保存しました</span>
            <span v-else>保存</span>
          </button>
        </div>
      </section>

      <!- - Google Calendar 連携 - ->
      <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <h2 class="text-sm font-semibold text-gray-700">Google Calendar 連携</h2>
          <p class="text-xs text-gray-500 mt-0.5">期日を設定したタスクをカレンダーに登録できます</p>
        </div>

        <div class="px-4 py-4">
          <!- - APIキー未設定 - ->
          <div v-if="!calendarStore.apiConfigured" class="text-sm text-gray-500">
            上のAPIキー設定を先に完了してください
          </div>

          <!- - 未連携 - ->
          <div v-else-if="!calendarStore.connected">
            <p class="text-sm text-gray-600 mb-3">
              連携すると、タスクの期日をGoogleカレンダーのイベントとして登録できます。
              連携は一度だけ許可するだけで、以降は自動で動作します。
            </p>
            <button
              @click="handleConnect"
              :disabled="calendarStore.loading"
              class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <span v-if="calendarStore.loading">連携中...</span>
              <span v-else>Googleカレンダーと連携する</span>
            </button>
            <p v-if="calendarStore.error" class="text-xs text-red-500 mt-2">
              {{ calendarStore.error }}
            </p>
          </div>

          <!- - 連携済み - ->
          <div v-else class="space-y-3">
            <div class="flex items-center gap-2">
              <span class="text-green-500 text-sm">✓</span>
              <span class="text-sm text-gray-700">{{ calendarStore.connectedEmail }} と連携中</span>
            </div>

            <div>
              <label class="block text-xs text-gray-500 mb-1">保存先カレンダー</label>
              <select
                v-model="calendarStore.calendarId"
                class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="primary">マイカレンダー（デフォルト）</option>
              </select>
              <p class="text-xs text-gray-400 mt-1">カレンダーの追加は今後対応予定です</p>
            </div>

            <button
              @click="handleDisconnect"
              :disabled="calendarStore.loading"
              class="text-sm text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
            >
              連携を解除
            </button>
            <p v-if="calendarStore.error" class="text-xs text-red-500">
              {{ calendarStore.error }}
            </p>
          </div>
        </div>
      </section>
      -->

      <!-- アカウント -->
      <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <h2 class="text-sm font-semibold text-gray-700">アカウント</h2>
        </div>
        <div class="px-4 py-4 space-y-3">
          <div class="flex items-center gap-3">
            <img
              v-if="authStore.user?.photoURL"
              :src="authStore.user.photoURL"
              class="w-8 h-8 rounded-full"
              alt=""
            />
            <div>
              <p class="text-sm text-gray-800">{{ authStore.user?.displayName }}</p>
              <p class="text-xs text-gray-500">{{ authStore.user?.email }}</p>
            </div>
          </div>
          <button
            @click="authStore.logout()"
            class="text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            ログアウト
          </button>
        </div>
      </section>

      <!-- 共有スペース -->
      <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <h2 class="text-sm font-semibold text-gray-700">共有スペース</h2>
          <p class="text-xs text-gray-500 mt-0.5">
            現在の space と、今後追加する家族共有の管理導線
          </p>
        </div>
        <div class="px-4 py-4 space-y-4">
          <div class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-xs text-gray-500">現在のスペース</p>
                <p class="text-sm font-medium text-gray-800">{{ currentSpaceName }}</p>
                <p
                  v-if="currentSpaceMeta && isSharedSpaceSelected"
                  class="text-xs text-gray-500 mt-1"
                >
                  メンバー {{ currentSpaceMeta.memberCount }} 人
                </p>
              </div>
              <span class="px-2 py-1 rounded-full bg-blue-100 text-blue-700 text-xs">
                {{ currentSpaceTypeLabel }}
              </span>
            </div>
          </div>

          <div v-if="canManageCurrentSpace" class="space-y-2 border-t border-gray-100 pt-3">
            <p class="text-xs text-gray-500">スペース名を変更</p>
            <input
              v-model="currentSpaceNameInput"
              type="text"
              placeholder="共有スペース名"
              class="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
            <button
              @click="handleUpdateSpaceName"
              :disabled="spaceNameSaving || !currentSpaceNameInput.trim()"
              class="w-full bg-gray-800 text-white text-sm rounded-lg py-2 hover:bg-gray-900 disabled:opacity-50"
            >
              {{ spaceNameSaving ? '更新中...' : 'スペース名を保存' }}
            </button>
          </div>

          <div class="space-y-2 border-t border-gray-100 pt-3">
            <div class="flex items-center justify-between gap-3">
              <p class="text-xs text-gray-500">現在のメンバー</p>
              <button
                v-if="isSharedSpaceSelected"
                @click="loadCurrentSpaceDetails"
                class="text-[11px] text-blue-600 hover:text-blue-800"
              >
                再読込
              </button>
            </div>
            <div
              v-if="!isSharedSpaceSelected"
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-500"
            >
              個人スペースではメンバー一覧はありません
            </div>
            <div
              v-else-if="membersLoading"
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-500"
            >
              メンバーを確認中...
            </div>
            <div
              v-else-if="currentSpaceMembers.length === 0"
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-500"
            >
              メンバー情報がありません
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="member in currentSpaceMembers"
                :key="member.uid"
                class="rounded-lg border border-gray-200 px-3 py-3"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-gray-800 truncate">
                      {{ member.displayName || member.email || member.uid }}
                    </p>
                    <p class="text-xs text-gray-500 truncate">{{ member.email || member.uid }}</p>
                  </div>
                  <div class="flex items-center gap-2 flex-shrink-0">
                    <span
                      class="px-2 py-1 rounded-full text-[10px]"
                      :class="member.role === 'owner'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-600'"
                    >
                      {{ member.role === 'owner' ? 'owner' : 'member' }}
                    </span>
                    <span
                      class="px-2 py-1 rounded-full text-[10px]"
                      :class="member.status === 'active'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'"
                    >
                      {{ member.status }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-2 border-t border-gray-100 pt-3">
            <p class="text-xs text-gray-500">家族スペースを作成</p>
            <input
              v-model="familySpaceName"
              type="text"
              placeholder="家族スペース名"
              class="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
            <button
              @click="handleCreateFamilySpace"
              :disabled="familySpaceLoading"
              class="w-full bg-gray-800 text-white text-sm rounded-lg py-2 hover:bg-gray-900 disabled:opacity-50"
            >
              {{ familySpaceLoading ? '作成中...' : '家族スペースを作成' }}
            </button>
          </div>

        </div>
      </section>


      <Suspense>
        <NewsPreferencesSection />
      </Suspense>

      <Suspense>
        <MobileNotificationSection />
      </Suspense>

      <!-- インポートとデータ更新 -->
      <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100">
          <h2 class="text-sm font-semibold text-gray-700">インポートとデータ更新</h2>
          <p class="text-xs text-gray-500 mt-0.5">
            現在のスペースに対するインポート、バックアップ、削除、データ補完を実行します
          </p>
        </div>

        <div class="px-4 py-4 space-y-4">
          <div class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 space-y-3">
            <div>
              <p class="text-xs text-gray-500">対象スペース</p>
              <p class="text-sm font-medium text-gray-800">{{ currentSpaceName }}</p>
            </div>

            <input
              ref="fileInput"
              type="file"
              accept=".json"
              class="hidden"
              @change="handleFileSelect"
            />
            <button
              @click="fileInput?.click()"
              :disabled="importing"
              class="w-full px-3 py-2 border-2 border-dashed border-gray-300 rounded text-sm text-gray-600 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50"
            >
              {{ selectedFile ? selectedFile.name : 'RTMエクスポートJSONを選択' }}
            </button>

            <div v-if="importing && progress" class="space-y-2">
              <div class="flex items-center justify-between text-xs text-gray-500">
                <span>{{ progress.message }}</span>
                <span>{{ progressPercent }}%</span>
              </div>
              <div class="w-full bg-gray-200 rounded-full h-2">
                <div
                  class="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  :style="{ width: `${progressPercent}%` }"
                />
              </div>
            </div>

            <div v-if="importResult?.success" class="rounded-lg border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-700">
              リスト {{ importResult.listsImported }} 件、タスク {{ importResult.tasksImported }} 件、タグ {{ importResult.tagsImported }} 件を取り込みました
            </div>

            <div v-if="clearResult?.success" class="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-3 text-sm text-yellow-700">
              タスク {{ clearResult.tasksDeleted }} 件、リスト {{ clearResult.listsDeleted }} 件、タグ {{ clearResult.tagsDeleted }} 件を削除しました
            </div>

            <div v-if="maintenanceError" class="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
              {{ maintenanceError }}
            </div>

            <button
              @click="handleImport"
              :disabled="!selectedFile || importing || clearing || exporting || migrating"
              class="w-full bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50"
            >
              {{ importing ? 'インポート中...' : 'インポート開始' }}
            </button>

            <button
              @click="handleExport"
              :disabled="importing || clearing || exporting || migrating"
              class="w-full bg-green-600 text-white text-sm rounded-lg py-2 hover:bg-green-700 disabled:opacity-50"
            >
              {{ exporting ? 'エクスポート中...' : 'バックアップをダウンロード' }}
            </button>

            <button
              @click="handleClear"
              :disabled="importing || clearing || exporting || migrating"
              class="w-full bg-red-100 text-red-700 text-sm rounded-lg py-2 hover:bg-red-200 disabled:opacity-50"
            >
              {{ clearing ? '削除中...' : 'このスペースのデータを削除' }}
            </button>
          </div>

          <div class="rounded-lg border border-gray-200 px-3 py-3 space-y-2">
            <p class="text-sm font-medium text-gray-800">データ更新</p>
            <p class="text-xs text-gray-500">
              現在のスペース内のタスクに `deleted: false` を補完し、リストの未完了件数も再計算します。
            </p>
            <p v-if="migrationMessage" class="text-xs text-gray-600 font-mono">
              {{ migrationMessage }}
            </p>
            <button
              @click="handleRunDataMigration"
              :disabled="importing || clearing || exporting || migrating"
              class="w-full bg-gray-800 text-white text-sm rounded-lg py-2 hover:bg-gray-900 disabled:opacity-50"
            >
              {{ migrating ? '更新中...' : 'データ更新を実行' }}
            </button>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>
