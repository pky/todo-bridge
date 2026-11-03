// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initializeTestEnvironment, type RulesTestContext, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteObject, getStream, listAll, ref, uploadBytes } from 'firebase/storage'

const projectId = 'demo-rertm'
const rules = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../storage.rules'), 'utf8')
const describeWithEmulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST ? describe : describe.skip
const latestPath = 'news/v2/ai/latest.json'
const body = '{"articles":[]}'
const bytes = new TextEncoder().encode(body)
const deniedPaths = [
  'news-private/v2/ai/daily/2026-01-01.json',
  'backups/test-user/x',
  'news/v2/ai/other.json',
  'news/v1/x',
  'other/x',
]
const actors = [
  { name: '未認証', claims: null },
  { name: 'claimなし', claims: {} },
  { name: '別のnewsRole', claims: { newsRole: 'admin' } },
  { name: 'curator', claims: { newsRole: 'curator' } },
  { name: 'viewer', claims: { newsRole: 'viewer' } },
]
let testEnv: RulesTestEnvironment

function contextFor(actor: (typeof actors)[number]): RulesTestContext {
  return actor.claims === null ? testEnv.unauthenticatedContext() : testEnv.authenticatedContext('test-user', actor.claims)
}

async function readObject(context: RulesTestContext, path: string): Promise<string> {
  // ストリームを最後まで読み、取得中の権限エラーも検査する。
  const reader = getStream(ref(context.storage(), path)).getReader()
  const decoder = new TextDecoder()
  let result = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function expectDenied(operation: Promise<unknown>): Promise<void> {
  // objectの欠損や通信障害をルールによる拒否と取り違えない。
  await expect(operation).rejects.toMatchObject({ code: 'storage/unauthorized' })
}

describeWithEmulator('Storage Rules', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({ projectId, storage: { rules } })
  })
  beforeEach(async () => {
    await testEnv.clearStorage()
    await testEnv.withSecurityRulesDisabled(async (context) => {
      for (const path of [latestPath, ...deniedPaths]) {
        await uploadBytes(ref(context.storage(), path), bytes)
      }
    })
  })
  afterAll(async () => {
    await testEnv?.cleanup()
  })

  for (const role of ['curator', 'viewer']) {
    it(`${role}はlatest.jsonの本文を取得できる`, async () => {
      const context = testEnv.authenticatedContext('test-user', { newsRole: role })
      await expect(readObject(context, latestPath)).resolves.toBe(body)
    })
  }
  for (const actor of actors) {
    describe(actor.name, () => {
      if (actor.claims?.newsRole !== 'curator' && actor.claims?.newsRole !== 'viewer') {
        it('latest.jsonのgetを拒否する', async () => {
          await expectDenied(readObject(contextFor(actor), latestPath))
        })
      }
      it('latest.jsonのcreateを拒否する', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          await deleteObject(ref(context.storage(), latestPath))
        })
        await expectDenied(uploadBytes(ref(contextFor(actor).storage(), latestPath), bytes))
      })
      it('latest.jsonのupdateとdeleteを拒否する', async () => {
        const object = ref(contextFor(actor).storage(), latestPath)
        await expectDenied(uploadBytes(object, new TextEncoder().encode('{"articles":[{}]}')))
        await expectDenied(deleteObject(object))
      })
      it('news/v2/ai/のlistを拒否する', async () => {
        await expectDenied(listAll(ref(contextFor(actor).storage(), 'news/v2/ai')))
      })
      for (const path of deniedPaths) {
        it(`${path}のget・create・update・delete・listを拒否する`, async () => {
          const storage = contextFor(actor).storage()
          const object = ref(storage, path)
          await expectDenied(readObject(contextFor(actor), path))
          await expectDenied(uploadBytes(ref(storage, `${path}.new`), bytes))
          await expectDenied(uploadBytes(object, new TextEncoder().encode('変更後')))
          await expectDenied(deleteObject(object))
          await expectDenied(listAll(ref(storage, path.slice(0, path.lastIndexOf('/')))))
        })
      }
    })
  }
})
