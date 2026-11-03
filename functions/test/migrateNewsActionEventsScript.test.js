const test = require('node:test')
const assert = require('node:assert/strict')

function parseArgs(argv, env = {}) {
  const script = require('../scripts/migrate-news-action-events.js')
  assert.equal(typeof script.parseArgs, 'function', '移行スクリプトは副作用なしにparseArgsを公開する')
  return script.parseArgs(argv, env)
}

const UID = 'fiction-curator'
const emulatorEnv = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }

// 戻り値の追加項目は許容し、安全判定と実行に必要な項目だけを契約とする。
test('emulator指定時も--apply無しならdry-runを既定にする', () => {
  const result = parseArgs(['--uid', UID], emulatorEnv)
  assert.equal(result.uid, UID)
  assert.equal(result.dryRun, true)
  assert.equal(result.refuse, false)
})

test('--applyを明示し、emulatorがあれば書き込みを許可する', () => {
  const result = parseArgs(['--uid', UID, '--apply'], emulatorEnv)
  assert.equal(result.dryRun, false)
  assert.equal(result.refuse, false)
})

for (const extra of [[], ['--apply']]) {
  test(`emulatorも--projectも無ければ${extra.length ? '--apply付きでも' : 'dry-runでも'}実行を拒否する`, () => {
    assert.equal(parseArgs(['--uid', UID, ...extra], {}).refuse, true)
  })
}

test('emulatorの空文字や環境変数のprojectだけでは実行を許可しない', () => {
  const result = parseArgs(['--uid', UID, '--apply'], {
    FIRESTORE_EMULATOR_HOST: '', GCLOUD_PROJECT: 'demo-migration-tests', GOOGLE_CLOUD_PROJECT: 'demo-migration-tests',
  })
  assert.equal(result.refuse, true)
})

test('--projectを明示すればemulator無しでもdry-runで確認できる', () => {
  const result = parseArgs(['--uid', UID, '--project', 'demo-migration-tests'])
  assert.equal(result.project, 'demo-migration-tests')
  assert.equal(result.dryRun, true)
  assert.equal(result.refuse, false)
})

test('--projectと--applyの両方を明示した場合だけemulator無しの書き込みを許可する', () => {
  const result = parseArgs(['--uid', UID, '--project', 'demo-migration-tests', '--apply'])
  assert.equal(result.uid, UID)
  assert.equal(result.project, 'demo-migration-tests')
  assert.equal(result.dryRun, false)
  assert.equal(result.refuse, false)
})
