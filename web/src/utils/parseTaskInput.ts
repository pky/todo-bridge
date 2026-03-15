/**
 * タスク入力からURLを抽出し、タスク名とURLに分離する
 * 例: "面会と感染症 http://example.com" → { name: "面会と感染症", url: "http://example.com" }
 * 例: "http://example.com タスク名" → { name: "タスク名", url: "http://example.com" }
 */
export function parseTaskInput(input: string): { name: string; url: string | null } {
  // URLを検出する正規表現（http/https/ftp）
  const urlPattern = /(?:https?|ftp):\/\/[^\s]+/gi

  const urls = input.match(urlPattern)

  if (!urls || urls.length === 0) {
    return { name: input.trim(), url: null }
  }

  // 最初のURLを抽出
  const url = urls[0]

  // URLを除去してタスク名を取得
  let name = input.replace(url, '').trim()

  // 余分な空白を削除
  name = name.replace(/\s+/g, ' ').trim()

  return {
    name: name || url, // 名前が空の場合はURLをタスク名にする
    url,
  }
}
