const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let learning = null
let loadError = null
try {
  learning = require('../lib/news/interactionLearning')
} catch (error) {
  loadError = error
}
function mod() {
  if (!learning) throw new Error(`interactionLearning が未実装です: ${loadError && loadError.message}`)
  return learning
}

const DAY_MS = 86400000
const NOW_MS = Date.UTC(2026, 9, 31, 12, 0, 0)
const daysAgo = days => NOW_MS - days * DAY_MS
const ts = ms => ({ toMillis: () => ms })

function signal(kind, ageDays, fields = {}) {
  return { kind, atMs: daysAgo(ageDays), ...fields }
}
function repeat(count, make) {
  return Array.from({ length: count }, () => make())
}
function learn(signals) {
  return mod().learnKeywordPreferences(signals, NOW_MS)
}
function kinds(signals) {
  return signals.map(s => s.kind).sort()
}

// ---- 定数 ----

test('重みは readLater 2、click 1、dismiss -1', () => {
  assert.deepEqual({ ...mod().SIGNAL_WEIGHTS }, { click: 1, readLater: 2, dismiss: -1 })
})

test('半減期30日、学習の窓90日、閾値1.5、倍率は positive 1.5 と negative 0.7', () => {
  const m = mod()
  assert.equal(m.LEARNING_HALF_LIFE_DAYS, 30)
  assert.equal(m.LEARNING_WINDOW_DAYS, 90)
  assert.equal(m.LEARNED_KEYWORD_THRESHOLD, 1.5)
  assert.equal(m.LEARNED_POSITIVE_MULTIPLIER, 1.5)
  assert.equal(m.LEARNED_NEGATIVE_MULTIPLIER, 0.7)
})

// ---- extractKeywords ----

test('extractKeywords: 小文字化し、英字3文字以上を取り、STOP_WORDS を除く', () => {
  assert.deepEqual(mod().extractKeywords('The new Claude model is AI'), ['claude'])
})

test('extractKeywords: 日本語の中の英単語も拾う', () => {
  assert.deepEqual(mod().extractKeywords('Claudeの新機能とRAGの話'), ['claude', 'rag'])
})

// ---- learnKeywordPreferences: 重みと半減期 ----

test('今日の readLater 1件（重み2）でその語は positive に入る', () => {
  const result = learn([signal('readLater', 0, { tags: ['agents'] })])
  assert.ok(result.positive.includes('agents'))
  assert.ok(!result.negative.includes('agents'))
})

test('30日前の readLater 1件は 1.0 になり閾値未満で positive に入らない', () => {
  const result = learn([signal('readLater', 30, { tags: ['agents'] })])
  assert.ok(!result.positive.includes('agents'))
})

test('今日の click 1件（重み1）だけでは positive に入らない', () => {
  const result = learn([signal('click', 0, { tags: ['agents'] })])
  assert.ok(!result.positive.includes('agents'))
})

test('閾値の境界: 今日の click と30日前の click で合計ちょうど1.5なら positive', () => {
  const result = learn([
    signal('click', 0, { tags: ['agents'] }),
    signal('click', 30, { tags: ['agents'] }),
  ])
  assert.ok(result.positive.includes('agents'))
})

test('titleEn と summaryJa からも語を拾い、tags は小文字化する', () => {
  const result = learn([
    signal('readLater', 0, { titleEn: 'Gemini launches', summaryJa: 'Vertexの更新', tags: ['Agents'] }),
  ])
  for (const word of ['gemini', 'launches', 'vertex', 'agents']) {
    assert.ok(result.positive.includes(word), `${word} が positive に無い`)
  }
})

// ---- 窓と経過日数 ----

test('91日前の readLater は10件あっても無視する', () => {
  // 無視しなければ 10 * 2 * 0.5^(91/30) ≒ 2.44 で positive になる
  const result = learn(repeat(10, () => signal('readLater', 91, { tags: ['agents'] })))
  assert.ok(!result.positive.includes('agents'))
})

test('ちょうど90日前の readLater は数える（10件で 2.5）', () => {
  const result = learn(repeat(10, () => signal('readLater', 90, { tags: ['agents'] })))
  assert.ok(result.positive.includes('agents'))
})

test('未来の時刻（age<0）は age 0 とみなす: 30日先の dismiss 1件は -1 で negative に入らない', () => {
  // age をそのまま使うと -1 * 0.5^(-1) = -2 で negative に入ってしまう
  const result = learn([signal('dismiss', -30, { tags: ['crypto'] })])
  assert.ok(!result.negative.includes('crypto'))
})

test('未来の時刻は無視せず数える: 30日先と今日の dismiss 各1件で -2 となり negative', () => {
  const result = learn([
    signal('dismiss', -30, { tags: ['crypto'] }),
    signal('dismiss', 0, { tags: ['crypto'] }),
  ])
  assert.ok(result.negative.includes('crypto'))
})

// ---- 1信号内の重複 ----

test('1信号の中で tag "Claude" と titleEn・summaryJa の "Claude" は1回だけ数える', () => {
  // 重複を数えると 1信号で 3 になり positive に入ってしまう
  const result = learn([
    signal('click', 0, { titleEn: 'Claude update', summaryJa: 'Claudeの新機能', tags: ['Claude'] }),
  ])
  assert.ok(!result.positive.includes('claude'))
})

test('別の信号どうしでは同じ語を足し合わせる（click 2件で 2 となり positive）', () => {
  const make = () => signal('click', 0, { titleEn: 'Claude update', summaryJa: 'Claudeの新機能', tags: ['Claude'] })
  const result = learn([make(), make()])
  assert.ok(result.positive.includes('claude'))
})

// ---- negative ----

test('今日の dismiss 2件で同じ語が -2 になれば negative に入る', () => {
  const result = learn(repeat(2, () => signal('dismiss', 0, { tags: ['crypto'] })))
  assert.ok(result.negative.includes('crypto'))
  assert.ok(!result.positive.includes('crypto'))
})

test('今日の dismiss 1件（-1）では negative に入らない', () => {
  const result = learn([signal('dismiss', 0, { tags: ['crypto'] })])
  assert.ok(!result.negative.includes('crypto'))
})

test('閾値の境界: 今日の dismiss と30日前の dismiss で合計ちょうど -1.5 なら negative', () => {
  const result = learn([
    signal('dismiss', 0, { tags: ['crypto'] }),
    signal('dismiss', 30, { tags: ['crypto'] }),
  ])
  assert.ok(result.negative.includes('crypto'))
})

test('positive と negative は相殺する: 今日の readLater 1件と dismiss 2件で 0 となりどちらにも入らない', () => {
  const result = learn([
    signal('readLater', 0, { tags: ['crypto'] }),
    signal('dismiss', 0, { tags: ['crypto'] }),
    signal('dismiss', 0, { tags: ['crypto'] }),
  ])
  assert.ok(!result.positive.includes('crypto'))
  assert.ok(!result.negative.includes('crypto'))
})

test('信号が無ければ positive も negative も空', () => {
  assert.deepEqual(learn([]), { positive: [], negative: [] })
})

// ---- buildInteractionSignals ----

const META = { titleEn: 'Claude agents', summaryJa: '架空の要約', tags: ['claude'] }

test('buildInteractionSignals: toMillis を持つ readLaterAt から readLater 信号を作り、メタを載せる', () => {
  const at = daysAgo(1)
  const signals = mod().buildInteractionSignals({ readLaterAt: ts(at), ...META })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'readLater')
  assert.equal(signals[0].atMs, at)
  assert.equal(signals[0].titleEn, META.titleEn)
  assert.equal(signals[0].summaryJa, META.summaryJa)
  assert.deepEqual(signals[0].tags, META.tags)
})

test('buildInteractionSignals: Date の clickedAt から click 信号を作る', () => {
  const at = daysAgo(2)
  const signals = mod().buildInteractionSignals({ clickedAt: new Date(at), titleEn: 'Claude agents' })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'click')
  assert.equal(signals[0].atMs, at)
  assert.equal(signals[0].titleEn, 'Claude agents')
})

test('buildInteractionSignals: dismissed と dismissedAt があり readLaterAt が無ければ dismiss 信号を作る', () => {
  const at = daysAgo(3)
  const signals = mod().buildInteractionSignals({ dismissed: true, dismissedAt: ts(at), ...META })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'dismiss')
  assert.equal(signals[0].atMs, at)
  assert.deepEqual(signals[0].tags, META.tags)
})

test('buildInteractionSignals: click と dismiss の両方があれば両方の信号を作り、各信号に同じメタを載せる', () => {
  const signals = mod().buildInteractionSignals({
    clickedAt: ts(daysAgo(5)),
    dismissed: true,
    dismissedAt: new Date(daysAgo(4)),
    ...META,
  })
  assert.deepEqual(kinds(signals), ['click', 'dismiss'])
  for (const s of signals) {
    assert.equal(s.titleEn, META.titleEn)
    assert.equal(s.summaryJa, META.summaryJa)
    assert.deepEqual(s.tags, META.tags)
  }
})

test('buildInteractionSignals: readLaterAt があれば dismissed と dismissedAt があっても dismiss 信号を作らない', () => {
  const signals = mod().buildInteractionSignals({
    readLaterAt: ts(daysAgo(1)),
    dismissed: true,
    dismissedAt: ts(daysAgo(1)),
    ...META,
  })
  assert.deepEqual(kinds(signals), ['readLater'])
})

test('buildInteractionSignals: dismissed が true でなければ dismissedAt があっても dismiss 信号を作らない', () => {
  const signals = mod().buildInteractionSignals({ dismissed: false, dismissedAt: ts(daysAgo(1)), ...META })
  assert.deepEqual(signals, [])
})

test('buildInteractionSignals: titleEn・summaryJa・tags のどれも無ければ空配列', () => {
  const signals = mod().buildInteractionSignals({
    readLaterAt: ts(daysAgo(1)),
    clickedAt: ts(daysAgo(1)),
    dismissed: true,
    dismissedAt: ts(daysAgo(1)),
  })
  assert.deepEqual(signals, [])
})

test('buildInteractionSignals: 空文字と空配列は無い扱いで空配列', () => {
  const signals = mod().buildInteractionSignals({
    readLaterAt: ts(daysAgo(1)),
    titleEn: '',
    summaryJa: '',
    tags: [],
  })
  assert.deepEqual(signals, [])
})

test('buildInteractionSignals: tags だけあれば信号を作る', () => {
  const signals = mod().buildInteractionSignals({ readLaterAt: ts(daysAgo(1)), tags: ['claude'] })
  assert.deepEqual(kinds(signals), ['readLater'])
})

test('buildInteractionSignals: 時刻が欠落した信号は作らない', () => {
  assert.deepEqual(mod().buildInteractionSignals({ dismissed: true, ...META }), [])
  assert.deepEqual(mod().buildInteractionSignals({ topic: 'ai', articleId: 'a1', ...META }), [])
})

test('buildInteractionSignals: toMillis を持たないオブジェクトや数値の時刻からは信号を作らない', () => {
  assert.deepEqual(mod().buildInteractionSignals({ clickedAt: { seconds: 1 }, ...META }), [])
  assert.deepEqual(mod().buildInteractionSignals({ readLaterAt: daysAgo(1), ...META }), [])
  assert.deepEqual(mod().buildInteractionSignals({ readLaterAt: '2026-10-30', ...META }), [])
})

test('buildInteractionSignals: 時刻のある信号だけを作る（clickedAt が無効でも readLaterAt は使う）', () => {
  const signals = mod().buildInteractionSignals({ readLaterAt: ts(daysAgo(1)), clickedAt: { seconds: 1 }, ...META })
  assert.deepEqual(kinds(signals), ['readLater'])
})

// ---- 完了条件4: 記録から学習までの通し ----

function learnFromRecords(records) {
  const signals = records.flatMap(data => mod().buildInteractionSignals(data))
  return learn(signals)
}

test('通し: 91日以上前・時刻なし・メタなしの記録は学習に入らない', () => {
  const records = [
    ...repeat(10, () => ({ readLaterAt: ts(daysAgo(91)), tags: ['oldword'] })),
    ...repeat(10, () => ({ dismissed: true, tags: ['notime'] })),
    ...repeat(10, () => ({ readLaterAt: ts(daysAgo(0)) })),
    ...repeat(10, () => ({ readLaterAt: ts(daysAgo(0)), titleEn: '', summaryJa: '', tags: [] })),
  ]
  assert.deepEqual(learnFromRecords(records), { positive: [], negative: [] })
})

test('通し: 有効な記録は学習に入る（後で読む記録は dismiss として数えない）', () => {
  const records = [
    { readLaterAt: ts(daysAgo(0)), dismissed: true, dismissedAt: ts(daysAgo(0)), titleEn: 'Agents', tags: ['agents'] },
    { dismissed: true, dismissedAt: ts(daysAgo(0)), tags: ['crypto'] },
    { dismissed: true, dismissedAt: new Date(daysAgo(0)), tags: ['crypto'] },
  ]
  const result = learnFromRecords(records)
  assert.ok(result.positive.includes('agents'))
  assert.ok(result.negative.includes('crypto'))
  assert.ok(!result.negative.includes('agents'))
})

// ---- calcPreferenceMultiplier ----

const ARTICLE = {
  title: 'Claude release notes',
  titleJa: 'Claudeのリリースノート',
  summaryJa: '架空の要約',
  description: 'Fictional description about agents',
}
const NO_PREFS = { keywords: [] }
const NONE = { positive: [], negative: [] }

test('calcPreferenceMultiplier: positive の語が含まれれば 1.5', () => {
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, NO_PREFS, { positive: ['claude'], negative: [] }), 1.5)
})

test('calcPreferenceMultiplier: description にだけある positive の語でも 1.5', () => {
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, NO_PREFS, { positive: ['agents'], negative: [] }), 1.5)
})

test('calcPreferenceMultiplier: negative の語だけが含まれれば 0.7', () => {
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, NO_PREFS, { positive: [], negative: ['claude'] }), 0.7)
})

test('calcPreferenceMultiplier: positive と negative の両方が当たれば 1.5', () => {
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, NO_PREFS, { positive: ['claude'], negative: ['agents'] }), 1.5)
})

test('calcPreferenceMultiplier: 手動キーワード weight 2 が当たれば negative があっても 2', () => {
  const prefs = { keywords: [{ word: 'Claude', weight: 2 }] }
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, prefs, { positive: [], negative: ['agents'] }), 2)
})

test('calcPreferenceMultiplier: 手動キーワード weight 2 と positive が両方当たれば大きい方の 2', () => {
  const prefs = { keywords: [{ word: 'claude', weight: 2 }] }
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, prefs, { positive: ['claude'], negative: [] }), 2)
})

test('calcPreferenceMultiplier: 当たらない手動キーワードは無視し、negative だけなら 0.7', () => {
  const prefs = { keywords: [{ word: 'nothing-matches', weight: 2 }] }
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, prefs, { positive: [], negative: ['claude'] }), 0.7)
})

test('calcPreferenceMultiplier: 何も当たらなければ 1', () => {
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, NO_PREFS, NONE), 1)
  assert.equal(mod().calcPreferenceMultiplier(ARTICLE, NO_PREFS, { positive: ['gemini'], negative: ['crypto'] }), 1)
})

test('calcPreferenceMultiplier: titleJa・summaryJa・description が無くても title で判定する', () => {
  const article = { title: 'Claude release notes' }
  assert.equal(mod().calcPreferenceMultiplier(article, NO_PREFS, { positive: ['claude'], negative: [] }), 1.5)
  assert.equal(mod().calcPreferenceMultiplier(article, NO_PREFS, { positive: [], negative: ['claude'] }), 0.7)
})
