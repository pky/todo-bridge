import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'

const projectId = 'demo-rertm'
const currentDir = dirname(fileURLToPath(import.meta.url))
const rules = readFileSync(resolve(currentDir, '../../firestore.rules'), 'utf8')
const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip

let testEnv: RulesTestEnvironment

async function seedSpaceMember(spaceId: string, uid: string, email: string): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, `spaces/${spaceId}/members/${uid}`), {
      uid,
      email,
      displayName: uid,
      role: 'member',
      status: 'active',
    })
  })
}

async function seedDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, path), data)
  })
}

describeWithEmulator('firestore rules', () => {
  beforeAll(async () => {
    const host = process.env.FIRESTORE_EMULATOR_HOST
    if (!host) {
      throw new Error('FIRESTORE_EMULATOR_HOST is not set')
    }

    const [emulatorHost, emulatorPort] = host.split(':')
    testEnv = await initializeTestEnvironment({
      projectId,
      firestore: {
        host: emulatorHost,
        port: Number(emulatorPort),
        rules,
      },
    })
  })

  afterAll(async () => {
    await testEnv.cleanup()
  })

  it('可視メンバーは共有リストを読める', async () => {
    await seedSpaceMember('space-1', 'alice', 'alice@example.com')
    await seedDoc('spaces/space-1/lists/list-1', {
      name: '家族の買い物',
      visibleToMemberIds: ['alice'],
      editableByMemberIds: ['alice'],
    })

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    await assertSucceeds(getDoc(doc(db, 'spaces/space-1/lists/list-1')))
  })

  it('非可視メンバーは共有リストを読めない', async () => {
    await seedSpaceMember('space-1', 'bob', 'bob@example.com')
    await seedDoc('spaces/space-1/lists/list-2', {
      name: 'Aだけ見えるリスト',
      visibleToMemberIds: ['alice'],
      editableByMemberIds: ['alice'],
    })

    const db = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore()
    await assertFails(getDoc(doc(db, 'spaces/space-1/lists/list-2')))
  })

  it('編集可能メンバーは共有タスクを作成できる', async () => {
    await seedSpaceMember('space-2', 'alice', 'alice@example.com')

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    await assertSucceeds(setDoc(doc(db, 'spaces/space-2/tasks/task-1'), {
      name: '牛乳を買う',
      listId: 'list-1',
      visibleToMemberIds: ['alice'],
      editableByMemberIds: ['alice'],
    }))
  })

  it('非メンバーは共有タスクを作成できない', async () => {
    const db = testEnv.authenticatedContext('mallory', { email: 'mallory@example.com' }).firestore()
    await assertFails(setDoc(doc(db, 'spaces/space-3/tasks/task-1'), {
      name: '侵入テスト',
      listId: 'list-1',
      visibleToMemberIds: ['mallory'],
      editableByMemberIds: ['mallory'],
    }))
  })
})
