#!/usr/bin/env node
/**
 * RTMエクスポートファイルから特定のタスクを検索するスクリプト
 *
 * 使い方: node scripts/check-task.js <エクスポートファイル> <検索キーワード>
 * 例: node scripts/check-task.js ~/Downloads/rememberthemilk_export.json info
 */

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
if (args.length < 2) {
  console.log('使い方: node scripts/check-task.js <エクスポートファイル> <検索キーワード>')
  process.exit(1)
}

const filePath = args[0]
const keyword = args[1].toLowerCase()

try {
  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content)

  // リストのIDと名前のマップを作成
  const listMap = new Map()
  for (const list of data.lists) {
    listMap.set(list.id, list.name)
  }

  // キーワードに一致するタスクを検索
  const matches = data.tasks.filter(task =>
    task.name.toLowerCase().includes(keyword)
  )

  if (matches.length === 0) {
    console.log(`「${keyword}」を含むタスクは見つかりませんでした`)
  } else {
    console.log(`「${keyword}」を含むタスク: ${matches.length}件\n`)

    for (const task of matches) {
      const listName = listMap.get(task.list_id) || '不明'
      console.log('---')
      console.log(`名前: ${task.name}`)
      console.log(`リスト: ${listName} (ID: ${task.list_id})`)
      console.log(`ID: ${task.id}`)
      console.log(`完了: ${task.completed ? 'はい' : 'いいえ'}`)
      console.log(`親タスクID: ${task.parent_task_id || 'なし'}`)
      if (task.subtasks && task.subtasks.length > 0) {
        console.log(`サブタスク数: ${task.subtasks.length}`)
      }
    }
  }

} catch (error) {
  console.error('エラー:', error.message)
  process.exit(1)
}
