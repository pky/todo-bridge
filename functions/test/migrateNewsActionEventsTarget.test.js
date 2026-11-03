const test = require('node:test')
const assert = require('node:assert/strict')
const script = require('../scripts/migrate-news-action-events')

const UID = 'fictional-uid-9999'
const PROJECT = 'fictional-project-9999'

function withEmulatorHost(value, fn) {
  const saved = process.env.FIRESTORE_EMULATOR_HOST
  if (value === undefined) delete process.env.FIRESTORE_EMULATOR_HOST
  else process.env.FIRESTORE_EMULATOR_HOST = value
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.FIRESTORE_EMULATOR_HOST
    else process.env.FIRESTORE_EMULATOR_HOST = saved
  }
}

test('describeTargetはFIRESTORE_EMULATOR_HOSTが設定されていればemulatorを返す', () => {
  assert.equal(typeof script.describeTarget, 'function')
  const options = script.parseArgs(['--uid', UID], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })
  assert.equal(withEmulatorHost('127.0.0.1:8080', () => script.describeTarget(options)), 'emulator')
})

test('describeTargetはFIRESTORE_EMULATOR_HOSTが未設定または空ならprojectを返す', () => {
  assert.equal(typeof script.describeTarget, 'function')
  const options = script.parseArgs(['--uid', UID, '--project', PROJECT], {})
  assert.equal(withEmulatorHost(undefined, () => script.describeTarget(options)), 'project')
  assert.equal(withEmulatorHost('', () => script.describeTarget(options)), 'project')
})

test('formatSummaryはtarget・件数・dryRunを含み、uidとプロジェクトIDを含まない', () => {
  assert.equal(typeof script.formatSummary, 'function')
  for (const target of ['emulator', 'project']) {
    const line = script.formatSummary({ target, planned: 3, created: 2, skippedExisting: 1, dryRun: true, uid: UID, project: PROJECT })
    assert.equal(typeof line, 'string')
    assert.ok(line.includes(`target=${target}`))
    assert.ok(!line.includes(UID))
    assert.ok(!line.includes(PROJECT))
    for (const n of ['3', '2', '1']) assert.ok(line.includes(n))
    assert.ok(/dryRun/i.test(line))
  }
})
