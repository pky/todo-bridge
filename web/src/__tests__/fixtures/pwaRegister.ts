import { ref } from 'vue'

// 単体テストではService Workerを登録せず、Appの実際の描画と認証だけを検証する。
export function useRegisterSW() {
  return { needRefresh: ref(false), offlineReady: ref(false), updateServiceWorker: async () => {} }
}
