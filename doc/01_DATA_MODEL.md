# TodoBridge データモデル設計

## 1. 概要

RTMエクスポートデータを基にしたデータモデル設計。
Firebase Firestoreのドキュメント構造として設計する。

### 1.1 RTMエクスポートデータ統計
| データ種別 | 件数 |
|-----------|------|
| タスク | 3,782件 |
| 未完了タスク | 969件 |
| リスト | 14件 |
| タグ | 35件 |
| ノート | 1,312件 |

---

## 2. Firestore コレクション構造

```
firestore/
└── users/{userId}/
    ├── profile                    # ユーザープロファイル（ドキュメント）
    ├── lists/{listId}             # リストコレクション
    ├── tasks/{taskId}             # タスクコレクション
    ├── tags/{tagId}               # タグコレクション
    └── smartLists/{smartListId}   # スマートリストコレクション
```

---

## 3. エンティティ定義

### 3.1 User (ユーザー)

**パス**: `users/{userId}`

```typescript
interface User {
  id: string;                    // Firebase Auth UID
  email: string;
  displayName: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  settings: UserSettings;
}

interface UserSettings {
  defaultListId: string;         // デフォルトリスト（Inbox）
  timezone: string;              // "Asia/Tokyo"
  dateFormat: "ymd" | "mdy" | "dmy";
  timeFormat: "24h" | "12h";
  startOfWeek: 0 | 1;           // 0: 日曜, 1: 月曜
}
```

### 3.2 List (リスト)

**パス**: `users/{userId}/lists/{listId}`

```typescript
interface List {
  id: string;
  name: string;
  isDefault: boolean;            // Inboxフラグ
  isArchived: boolean;           // アーカイブ済み
  sortOrder: number;             // 表示順
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

**RTMマッピング**:
| RTM | TodoBridge |
|-----|-------|
| id | id |
| name | name |
| date_created | createdAt |
| date_modified | updatedAt |
| (Inbox判定) | isDefault |

**デフォルトリスト**:
- Inbox（isDefault: true）

### 3.3 Task (タスク)

**パス**: `users/{userId}/tasks/{taskId}`

```typescript
interface Task {
  id: string;
  seriesId: string;              // RTMのseries_id（リピート用）
  listId: string;                // 所属リストID
  parentId: string | null;       // 親タスクID（サブタスク用）

  // 基本情報
  name: string;
  priority: Priority;            // 1, 2, 3, 4
  tags: string[];                // タグID配列

  // 日時
  dueDate: Timestamp | null;
  dueHasTime: boolean;
  startDate: Timestamp | null;
  startHasTime: boolean;

  // 繰り返し
  repeat: RepeatRule | null;

  // ノート
  notes: Note[];

  // 状態
  completed: boolean;
  completedAt: Timestamp | null;
  postponed: number;             // 延期回数

  // メタ
  source: string;                // 作成元（web, ios, import）
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

type Priority = 1 | 2 | 3 | 4;   // 1:高, 2:中, 3:低, 4:なし

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface RepeatRule {
  type: "daily" | "weekly" | "monthly" | "yearly" | "after";
  interval: number;              // 間隔
  daysOfWeek?: number[];         // 曜日指定 (0-6)
  endDate?: Timestamp;           // 終了日
}
```

**RTMマッピング**:
| RTM | TodoBridge | 変換 |
|-----|-------|------|
| id | id | そのまま |
| series_id | seriesId | そのまま |
| list_id | listId | そのまま |
| parent_id | parentId | そのまま |
| name | name | そのまま |
| priority | priority | P1→1, P2→2, P3→3, PN→4 |
| tags | tags | タグ名→タグID |
| date_due | dueDate | timestamp変換 |
| date_due_has_time | dueHasTime | そのまま |
| date_start | startDate | timestamp変換 |
| date_start_has_time | startHasTime | そのまま |
| repeat_every | repeat | 要パース |
| date_completed | completedAt | timestamp変換 |
| date_completed != null | completed | 判定 |
| postponed | postponed | そのまま |
| source | source | そのまま |
| date_created | createdAt | timestamp変換 |
| date_modified | updatedAt | timestamp変換 |

### 3.4 Tag (タグ)

**パス**: `users/{userId}/tags/{tagId}`

```typescript
interface Tag {
  id: string;
  name: string;
  color?: string;                // 将来用
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 3.5 SmartList (スマートリスト)

**パス**: `users/{userId}/smartLists/{smartListId}`

```typescript
interface SmartList {
  id: string;
  name: string;
  filter: SmartListFilter;
  icon?: string;
  sortOrder: number;
  isBuiltIn: boolean;            // システム定義
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface SmartListFilter {
  // 日付フィルター
  dueDateRange?: DateRange;
  startDateRange?: DateRange;

  // 属性フィルター
  priority?: Priority[];
  listIds?: string[];
  tagIds?: string[];

  // 状態フィルター
  completed?: boolean;
  hasNotes?: boolean;

  // テキストフィルター
  nameContains?: string;

  // 論理演算
  operator: "AND" | "OR";
}

interface DateRange {
  type: "today" | "tomorrow" | "thisWeek" | "nextWeek" |
        "overdue" | "noDate" | "custom";
  customStart?: Timestamp;
  customEnd?: Timestamp;
}
```

**ビルトインスマートリスト**:
| ID | 名前 | フィルター |
|----|------|-----------|
| today | 今日 | dueDate = today |
| tomorrow | 明日 | dueDate = tomorrow |
| this_week | 今週 | dueDate in thisWeek |
| overdue | 期限切れ | dueDate < today & !completed |
| all | すべて | (なし) |
| completed | 完了済み | completed = true |

---

## 4. インデックス設計

### 4.1 複合インデックス

```javascript
// tasks コレクション
{ listId: ASC, completed: ASC, dueDate: ASC }
{ listId: ASC, completed: ASC, priority: ASC }
{ tags: ARRAY_CONTAINS, completed: ASC, dueDate: ASC }
{ completed: ASC, dueDate: ASC }
```

### 4.2 単一フィールドインデックス
- tasks.dueDate
- tasks.createdAt
- tasks.updatedAt
- tasks.completed

---

## 5. セキュリティルール

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ユーザードキュメント
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      // サブコレクション
      match /{subcollection}/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

---

## 6. RTMデータ変換仕様

### 6.1 優先度変換
```typescript
const priorityMap: Record<string, Priority> = {
  "P1": 1,  // 高
  "P2": 2,  // 中
  "P3": 3,  // 低
  "PN": 4,  // なし
};
```

### 6.2 タイムスタンプ変換
```typescript
// RTM: ミリ秒タイムスタンプ (number)
// Firestore: Timestamp
const convertTimestamp = (rtmTs: number): Timestamp => {
  return Timestamp.fromMillis(rtmTs);
};
```

### 6.3 タグ変換
```typescript
// RTMではタスクにタグ名の配列が直接格納
// ReRTMではタグをTagエンティティとして管理し、タスクにはタグIDを格納

// 1. 全タスクからユニークなタグ名を収集
// 2. Tagエンティティを作成
// 3. タスクのタグ名をタグIDに変換
```

---

## 7. データ整合性

### 7.1 削除時の挙動
| 削除対象 | 影響 | 処理 |
|---------|------|------|
| List | 所属タスク | リストと共に削除 or Inboxに移動 |
| Tag | タスクのtags配列 | タグIDを配列から削除 |
| Task | サブタスク | 親と共に削除 |

### 7.2 バリデーション
- タスク名: 1-500文字
- リスト名: 1-100文字
- タグ名: 1-50文字
- ノート: 1-10000文字
