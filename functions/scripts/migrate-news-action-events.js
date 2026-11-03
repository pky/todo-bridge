// 旧AI履歴を安定IDの操作イベントへ移し、既存イベントは変更しない。
function parseArgs(argv, env = {}) {
  let uid
  let project
  let dryRun = true
  let invalid = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') {
      dryRun = false
    } else if (arg === '--uid' || arg === '--project') {
      const value = argv[++i]
      if (!value || value.startsWith('--') || value.trim() !== value || value.includes('/')) {
        invalid = true
      } else if (arg === '--uid') {
        if (uid !== undefined) invalid = true
        uid = value
      } else {
        if (project !== undefined) invalid = true
        project = value
      }
    } else {
      invalid = true
    }
  }
  const emulator = typeof env.FIRESTORE_EMULATOR_HOST === 'string' && env.FIRESTORE_EMULATOR_HOST.trim() !== ''
  return { uid, project, dryRun, refuse: invalid || !uid || (!emulator && !project) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env)
  if (args.refuse) {
    console.error('実行を拒否しました。--uid と、Emulator または明示的な --project が必要です。')
    process.exitCode = 1
    return
  }
  const admin = require('firebase-admin')
  const { planNewsActionEventMigration, applyNewsActionEventMigration } = require('../lib/news/v2/newsEventMigration')
  admin.initializeApp({ projectId: args.project || 'demo-rertm' })
  const db = admin.firestore()
  try {
    const snapshot = await db.collection(`users/${args.uid}/newsInteractions`).get()
    const plan = planNewsActionEventMigration({
      uid: args.uid, interactions: snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() })), nowMs: Date.now(),
    })
    const result = await applyNewsActionEventMigration({ db, uid: args.uid, plan, dryRun: args.dryRun })
    console.log(JSON.stringify(result))
  } finally {
    await db.terminate()
  }
}

module.exports = { parseArgs }
if (require.main === module) {
  main().catch(() => {
    // 例外に記事情報や接続先が含まれる可能性があるため詳細を出さない。
    console.error('移行に失敗しました。')
    process.exitCode = 1
  })
}
