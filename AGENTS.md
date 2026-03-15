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
- Test: pnpm test ...
- Lint: pnpm lint ...
- Typecheck: pnpm typecheck ...
- Build: pnpm build ...
