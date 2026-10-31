#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Claude Code と同じ登録内容を使い、モデル無しでロケータを実画面と照合する。
const root = resolve(import.meta.dirname, '../..')
const registration = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8')).mcpServers.e2e
const client = new Client({ name: 'todobridge-verification', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: registration.command, args: registration.args, cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, JAVA_HOME: process.env.JAVA_HOME,
    TMPDIR: process.env.TMPDIR, ...registration.env }, stderr: 'pipe',
})
const evidence = []
let opened = false
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
  evidence.push({ name, args, result })
  if (result.isError) throw new Error(`MCP ${name} が失敗しました`)
  return result
}
async function locate(args) {
  const result = await call('call', { tool: 'locate', args })
  const message = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  if (!/1 (match|node)|matches 1|Matched 1/i.test(message)) throw new Error('ロケータの一意性を確認できませんでした')
}
try {
  await client.connect(transport)
  await call('open_session', { test: 'verification/tests/smoke.e2e.ts' })
  opened = true
  await call('call', { tool: 'observe', args: {} })
  await locate({ role: 'heading', name: 'モバイルニュース', exact: true })
  await locate({ role: 'heading', name: '今日の重要事項', exact: true })
  await locate({ testId: 'important-title' })
  await locate({ text: '要対応', exact: true })
  await locate({ role: 'button', name: '対応済み', exact: true })
  await call('call', { tool: 'run_code', args: {
    code: "await expect(screen.getByText('要対応')).toBeVisible(); await screen.getByRole('button', '対応済み', { exact: true }).tap(); await expect(screen.getByRole('button', '対応済み 1件')).toBeVisible();",
  } })
  await locate({ role: 'button', name: '対応済み 1件', exact: true })
  await call('call', { tool: 'run_code', args: { code: "await screen.getByRole('button', '対応済み 1件').tap();" } })
  await locate({ role: 'link', name: '検証用セキュリティ更新の確認', exact: true })
  await locate({ role: 'button', name: '戻す', exact: true })
  await call('call', { tool: 'run_code', args: {
    code: "await screen.getByRole('button', '戻す', { exact: true }).tap(); await expect(screen.getByTestId('important-title')).toHaveText('検証用セキュリティ更新の確認');",
  } })
  console.log('MCPのロケータ確認と対応済み・復元の操作が成功しました')
} finally {
  try { if (opened) await call('close_session', {}) } finally {
    await client.close()
    await mkdir(resolve(root, 'web/.e2e/proof/mcp'), { recursive: true })
    await writeFile(resolve(root, 'web/.e2e/proof/mcp/locators.json'), JSON.stringify(evidence, null, 2))
  }
}
