# JavaScript Project Codex Rules

## Goal
- Optimize for reliable bug fixing in a JavaScript / TypeScript codebase.
- Prefer minimal, localized fixes.
- Do not refactor unrelated code unless explicitly requested.

## Debugging priorities
When debugging, inspect in this order when relevant:
1. async timing
2. stale closures
3. state synchronization
4. effect dependencies
5. event ordering
6. API contract mismatches
7. type boundary or runtime validation issues

## Frontend rules
- Check state ownership before changing component structure.
- Check effect dependencies before rewriting logic.
- Check memoization boundaries only when there is evidence they matter.
- Prefer fixing source-of-truth problems over patching symptoms in leaf components.
- Avoid broad component rewrites for bug-fix tasks.

## Async / API rules
- Check request timing, race conditions, and stale responses first.
- Check server/client payload assumptions before changing UI logic.
- If the issue may be backend or contract-related, state that clearly before editing multiple layers.
- Prefer root-cause fixes over adding retries or defensive conditionals everywhere.

## Node / backend JS rules
- Check async sequencing and error propagation first.
- Check input/output contract boundaries before changing business logic.
- Prefer localized fixes over broad restructuring.
- Avoid swallowing errors unless there is a clear handling strategy.

## TypeScript rules
- Use types to confirm assumptions, not to hide runtime issues.
- Avoid papering over bugs with casts like `as any`.
- Prefer fixing incorrect data flow or type boundaries over weakening types.

## Editing rules
- Keep changes small and consistent with the existing style.
- Avoid broad formatting-only edits.
- Avoid unrelated lint cleanup in bug-fix tasks.
- Do not add dependencies unless clearly necessary.
- Do not modify generated files unless required.

## Verification strategy
Use the narrowest relevant verification first:
1. narrow test file or test pattern
2. targeted typecheck or lint for the affected package
3. affected package build
4. monorepo-wide verification only if necessary

## Preferred commands
- Prefer the smallest relevant npm / pnpm / yarn command.
- If package-scoped scripts exist, use those first.
- Do not run the largest available workspace-wide verification first unless explicitly requested.

## Response requirements
For every bug-fix task, end with:
- confirmed or suspected root cause
- exact files changed
- exact commands run
- what was verified
- what remains unverified
- any remaining regression risk

## If the issue is unclear
When the issue is ambiguous:
1. identify the user-visible symptom or failing endpoint,
2. find the owning package/module,
3. inspect async/state boundaries,
4. then inspect API contracts and type boundaries if needed.

## Avoid
- broad component rewrites
- weakening types to make errors disappear
- adding retries, timeouts, or guards without root-cause reasoning
- editing multiple packages without evidence of a shared cause

## Project commands
Package manager is npm (lockfiles are package-lock.json). Do not use pnpm or yarn.

web/ (Vue / Vite / Pinia / Firebase):
- Test: `cd web && npm run test:run`
- Lint: `cd web && npm run lint`
- Typecheck: `cd web && npm run type-check`
- Build: `cd web && npm run build` (runs test:auth, vue-tsc -b, vite build)
- Firestore rules (needs Java for the emulator): `cd web && npm run test:rules`
- Responsive UI: `cd web && npm run test:responsive`

functions/ (Firebase Cloud Functions):
- Lint: `cd functions && npm run lint`
- Test: `cd functions && npm test` (builds, then runs node --test)

Before reporting a task as done, run lint, typecheck, test and build for every package you touched. All must pass without editing tests to make them pass. `npm run verify` at the repository root runs every gate above except test:rules and test:responsive.

## Code Review Rules
レビューの優先順。上から順に見る。指摘には必ず失敗シナリオ（どの入力でどう壊れるか）を付ける。
1. データ破壊: 上書き、削除、移動、マイグレーション、永続化の変更（Firestore のドキュメント構造、firestore.rules、storage.rules の変更を含む）
2. 認証と権限: 認可の抜け、権限チェックの緩和、セキュリティルールの緩和
3. 秘密情報の混入: 鍵、トークン、個人情報、実環境 ID、内部 URL のハードコード
4. テストの改変: 既存テストの削除、期待値の書き換え、スキップの追加
5. 頼んでいない変更: 依頼範囲外のリファクタ、整形、依存の追加
スタイルだけの指摘は出さない。失敗シナリオが書けない指摘は出さない。

このリポジトリ固有の観点:
- 未完了タスクの取得に limit() を付ける変更は、全件表示の要件を壊すので blocker
- firestore.rules と storage.rules の allow 条件を広げる変更は、理由と対応するルールテストが無ければ blocker
- 実環境のプロジェクト ID、実ユーザーのデータ、ローカル絶対パスがテストやドキュメントに入ったら blocker

## Current State
- Branch: main. Small single-line Japanese commit messages. No force push, no history rewrite.
- Gates: GitHub Actions (.github/workflows/ci.yml) runs web lint / type-check / test:run / build, functions lint / test, and the Firestore rules test on every push to main and every pull request. Codex automatic code review runs when a pull request is opened.
- Local-only files (web/.env.local, .firebaserc, doc/, progress.txt) are listed in .worktreeinclude so that git worktrees get a copy.
- Agents must not run git push, deploy, rm, git reset or branch deletion. These are done by a human.
