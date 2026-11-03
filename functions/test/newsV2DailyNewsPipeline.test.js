const test = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')

const instant = new Date('2026-11-03T21:00:00.000Z')
const articles = [{ id: 'fiction-article', title: '架空記事', summaryJa: '架空の概要' }]

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function withinDeadline(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('工程が期限内に進みませんでした')), 500) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function setup() {
  const calls = []
  const logs = []
  const deps = {
    feedDate: '2026-11-04', now: () => new Date(instant), curatorUid: 'fiction-curator',
    readDailyTimeoutMs: 30,
    readDailyExists: async () => { calls.push(['read']); return false },
    collectAi: async () => { calls.push(['collectAi']); return { sourcesSucceeded: 3, sourcesFailed: 0 } },
    generateAi: async ctx => { calls.push(['generateAi', ctx]); return { ok: true, curatorArticles: articles } },
    publish: async (...args) => { calls.push(['publish', ...args]) },
    recoverPublish: async () => { calls.push(['recoverPublish']) },
    collectMobile: async () => { calls.push(['collectMobile']) },
    generateMobile: async () => { calls.push(['generateMobile']) },
    sendMobileUrgent: async () => { calls.push(['sendMobileUrgent']) },
    sendMobileDigest: async () => { calls.push(['sendMobileDigest']) },
    log: Object.fromEntries(['info', 'warn', 'error', 'log'].map(level => [level, (...args) => logs.push([level, ...args])])),
  }
  return { deps, calls, logs }
}

function run(deps) {
  const { runDailyNewsPipeline } = require('../lib/news/v2/dailyNewsPipeline')
  return runDailyNewsPipeline(deps)
}
function named(calls, name) { return calls.filter(call => call[0] === name) }
function assertMobile(calls) {
  for (const name of ['collectMobile', 'generateMobile', 'sendMobileUrgent', 'sendMobileDigest']) {
    assert.equal(named(calls, name).length, 1, name)
  }
  const position = name => calls.findIndex(call => call[0] === name)
  assert.ok(position('collectMobile') < position('generateMobile'))
  assert.ok(position('generateMobile') < position('sendMobileUrgent'))
  assert.ok(position('generateMobile') < position('sendMobileDigest'))
}

test('収集と生成が成功すれば選別記事を公開し、mobileも完了する', async () => {
  const { deps, calls } = setup()
  await run(deps)
  assert.equal(named(calls, 'collectAi').length, 1)
  assert.equal(named(calls, 'generateAi').length, 1)
  assert.equal(named(calls, 'publish').length, 1)
  assert.deepEqual(named(calls, 'publish')[0][1], articles)
  assert.equal(named(calls, 'recoverPublish').length, 0)
  assertMobile(calls)
})

test('生成前のcutoffを生成と公開へ同じ値で渡す', async () => {
  const { deps, calls } = setup()
  let current = new Date(instant)
  deps.now = () => new Date(current)
  deps.generateAi = async ctx => {
    calls.push(['generateAi', ctx])
    assert.ok(ctx.learningCutoffAt instanceof Date)
    assert.equal(ctx.learningCutoffAt.toISOString(), instant.toISOString())
    assert.equal(ctx.curatorUid, 'fiction-curator')
    current = new Date(instant.getTime() + 60000)
    return { ok: true, curatorArticles: articles }
  }
  await run(deps)
  assert.equal(named(calls, 'publish').length, 1)
  assert.equal(named(calls, 'publish')[0][2].getTime(), instant.getTime())
  assert.equal(named(calls, 'publish')[0][2].getTime(), named(calls, 'generateAi')[0][1].learningCutoffAt.getTime())
})

test('完成済みdailyがある場合はAI収集・生成せず公開だけ復旧する', async () => {
  const { deps, calls } = setup()
  deps.readDailyExists = async () => true
  await run(deps)
  assert.equal(named(calls, 'collectAi').length, 0)
  assert.equal(named(calls, 'generateAi').length, 0)
  assert.equal(named(calls, 'publish').length, 0)
  assert.equal(named(calls, 'recoverPublish').length, 1)
  assertMobile(calls)
})

for (const curatorUid of [undefined, '']) {
  test(`curator未設定(${String(curatorUid)})でもv1収集・生成を続けて公開しない`, async () => {
    const { deps, calls } = setup()
    deps.curatorUid = curatorUid
    await run(deps)
    assert.equal(named(calls, 'collectAi').length, 1)
    assert.equal(named(calls, 'generateAi').length, 1)
    assert.equal(named(calls, 'generateAi')[0][1].curatorUid, undefined)
    assert.equal(named(calls, 'publish').length, 0)
    assert.equal(named(calls, 'recoverPublish').length, 0)
    assertMobile(calls)
  })
}

test('Storage読み込み例外でもv1収集・生成を続け、公開せず状態を記録する', async () => {
  const { deps, calls, logs } = setup()
  deps.readDailyExists = async () => { throw new Error('架空の読み込み障害') }
  await run(deps)
  assert.equal(named(calls, 'collectAi').length, 1)
  assert.equal(named(calls, 'generateAi').length, 1)
  assert.equal(named(calls, 'publish').length, 0)
  assert.equal(named(calls, 'recoverPublish').length, 0)
  assert.ok(logs.length > 0)
  assertMobile(calls)
})

test('Storageが応答しなくてもmobileを待たせず、期限後にv1を続けて公開しない', { timeout: 2000 }, async () => {
  const { deps, calls, logs } = setup()
  const mobileDone = deferred()
  let readStartedAt, collectStartedAt
  deps.readDailyExists = () => { readStartedAt = performance.now(); return new Promise(() => {}) }
  const originalCollect = deps.collectAi
  deps.collectAi = async () => { collectStartedAt = performance.now(); return originalCollect() }
  deps.readDailyTimeoutMs = 40
  deps.sendMobileDigest = async () => { calls.push(['sendMobileDigest']); mobileDone.resolve() }
  const pending = run(deps)
  await withinDeadline(mobileDone.promise)
  assertMobile(calls)
  assert.equal(named(calls, 'collectAi').length, 0)
  assert.equal(named(calls, 'generateAi').length, 0)
  await withinDeadline(pending)
  // タイマー精度の1msを許容し、期限を待たずv1を開始する実装を検出する。
  assert.ok(collectStartedAt - readStartedAt >= deps.readDailyTimeoutMs - 1)
  assert.equal(named(calls, 'collectAi').length, 1)
  assert.equal(named(calls, 'generateAi').length, 1)
  assert.equal(named(calls, 'publish').length, 0)
  assert.equal(named(calls, 'recoverPublish').length, 0)
  assert.ok(logs.length > 0)
})

for (const blockedStep of ['collectAi', 'generateAi', 'publish']) {
  test(`${blockedStep}が遅くてもmobileの全工程は先に完了する`, { timeout: 2000 }, async () => {
    const { deps, calls } = setup()
    const entered = deferred(), release = deferred(), mobileDone = deferred()
    const original = deps[blockedStep]
    deps[blockedStep] = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
    deps.sendMobileDigest = async () => { calls.push(['sendMobileDigest']); mobileDone.resolve() }
    const pending = run(deps)
    try {
      await withinDeadline(Promise.all([entered.promise, mobileDone.promise]))
      assertMobile(calls)
      assert.equal(named(calls, blockedStep).length, 0)
    } finally {
      release.resolve()
      await withinDeadline(pending)
    }
  })
}

for (const collectResult of [{ sourcesSucceeded: 0, sourcesFailed: 3 }, { sourcesSucceeded: 0, sourcesFailed: 0 }]) {
  test(`収集成功ソース0件(${collectResult.sourcesFailed}失敗)では生成しても公開しない`, async () => {
    const { deps, calls } = setup()
    deps.collectAi = async () => { calls.push(['collectAi']); return collectResult }
    await run(deps)
    assert.equal(named(calls, 'generateAi').length, 1)
    assert.equal(named(calls, 'publish').length, 0)
    assertMobile(calls)
  })
}

test('収集が例外でもv1生成を続けて公開しない', async () => {
  const { deps, calls } = setup()
  deps.collectAi = async () => { calls.push(['collectAi']); throw new Error('架空の収集障害') }
  await run(deps)
  assert.equal(named(calls, 'generateAi').length, 1)
  assert.equal(named(calls, 'publish').length, 0)
  assertMobile(calls)
})

test('成功した収集ソースが1つあれば公開する', async () => {
  const { deps, calls } = setup()
  deps.collectAi = async () => ({ sourcesSucceeded: 1, sourcesFailed: 2 })
  await run(deps)
  assert.equal(named(calls, 'publish').length, 1)
})

for (const mode of ['failed', 'throw']) {
  test(`生成が${mode}なら公開しない`, async () => {
    const { deps, calls } = setup()
    deps.generateAi = async () => {
      calls.push(['generateAi'])
      if (mode === 'throw') throw new Error('架空の生成障害')
      return { ok: false }
    }
    await run(deps)
    assert.equal(named(calls, 'generateAi').length, 1)
    assert.equal(named(calls, 'publish').length, 0)
    assertMobile(calls)
  })
}

test('正常0件は空配列を公開する', async () => {
  const { deps, calls } = setup()
  deps.generateAi = async () => ({ ok: true, curatorArticles: [] })
  await run(deps)
  assert.equal(named(calls, 'publish').length, 1)
  assert.deepEqual(named(calls, 'publish')[0][1], [])
})

for (const step of ['publish', 'recoverPublish']) {
  test(`${step}の例外をログに記録して握りつぶす`, async () => {
    const { deps, calls, logs } = setup()
    deps.readDailyExists = async () => step === 'recoverPublish'
    deps[step] = async () => { calls.push([step]); throw new Error('架空の公開障害') }
    await assert.doesNotReject(() => run(deps))
    assert.equal(named(calls, step).length, 1)
    assert.ok(logs.length > 0)
    assertMobile(calls)
  })
}

for (const step of ['collectMobile', 'generateMobile', 'sendMobileUrgent', 'sendMobileDigest']) {
  test(`${step}の例外でも他のmobile工程とAI公開を続ける`, async () => {
    const { deps, calls } = setup()
    deps[step] = async () => { calls.push([step]); throw new Error('架空のmobile障害') }
    await assert.doesNotReject(() => run(deps))
    assertMobile(calls)
    assert.equal(named(calls, 'publish').length, 1)
  })
}

test('mobile通知は一方の完了を待たず並列に開始する', { timeout: 2000 }, async () => {
  const { deps } = setup()
  const urgentStarted = deferred(), digestStarted = deferred(), release = deferred()
  deps.sendMobileUrgent = async () => { urgentStarted.resolve(); await release.promise }
  deps.sendMobileDigest = async () => { digestStarted.resolve(); await release.promise }
  const pending = run(deps)
  try {
    await withinDeadline(Promise.all([urgentStarted.promise, digestStarted.promise]))
  } finally {
    release.resolve()
    await withinDeadline(pending)
  }
})
