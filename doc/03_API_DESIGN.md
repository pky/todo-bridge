# TodoBridge API/サービス設計

## 1. 概要

Firebase Firestoreを使用するため、REST APIではなくサービス層として設計する。
Web版（TypeScript）とiOS版（Swift）で同等の機能を提供する。

---

## 2. サービス層アーキテクチャ

### 2.1 Web版（TypeScript）

```
src/services/
├── firebase.ts          # Firebase初期化
├── authService.ts       # 認証サービス
├── taskService.ts       # タスクサービス
├── listService.ts       # リストサービス
├── tagService.ts        # タグサービス
├── smartListService.ts  # スマートリストサービス
└── importService.ts     # RTMインポートサービス
```

### 2.2 iOS版（Swift）

```
Services/
├── FirebaseService.swift
├── AuthService.swift
├── TaskService.swift
├── ListService.swift
├── TagService.swift
├── SmartListService.swift
└── ImportService.swift
```

---

## 3. 認証サービス (AuthService)

### 3.1 認証方針

**Googleログインのみ**

理由:
- セキュリティ最優先（Googleの2FA、不審ログイン検知を活用）
- パスワード管理不要（ReRTM側にパスワードを保存しない）
- 実装がシンプル
- 既存デバイス（スマホ/Mac）があれば新環境でもログイン可能

### 3.2 インターフェース

```typescript
interface AuthService {
  // 状態
  readonly currentUser: User | null;
  readonly isAuthenticated: boolean;

  // 認証（Googleのみ）
  signInWithGoogle(): Promise<User>;
  signOut(): Promise<void>;

  // リスナー
  onAuthStateChanged(callback: (user: User | null) => void): Unsubscribe;
}
```

### 3.2 実装詳細

```typescript
// Web版 (authService.ts)
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged as firebaseOnAuthStateChanged,
} from "firebase/auth";

export const authService = {
  async signInWithEmail(email: string, password: string): Promise<User> {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    return mapFirebaseUser(credential.user);
  },

  async signUpWithEmail(email: string, password: string): Promise<User> {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    // 初期データ作成
    await initializeUserData(credential.user.uid);
    return mapFirebaseUser(credential.user);
  },

  // ...
};
```

---

## 4. タスクサービス (TaskService)

### 4.1 インターフェース

```typescript
interface TaskService {
  // CRUD
  createTask(task: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;

  // 一覧取得
  getTasksByList(listId: string): Promise<Task[]>;
  getTasksBySmartList(smartListId: string): Promise<Task[]>;
  searchTasks(query: string): Promise<Task[]>;

  // 状態変更
  completeTask(taskId: string): Promise<Task>;
  uncompleteTask(taskId: string): Promise<Task>;
  postponeTask(taskId: string): Promise<Task>;

  // リアルタイム
  subscribeToTasks(listId: string, callback: (tasks: Task[]) => void): Unsubscribe;
}

interface CreateTaskInput {
  name: string;
  listId: string;
  priority?: Priority;
  dueDate?: Date;
  dueHasTime?: boolean;
  startDate?: Date;
  startHasTime?: boolean;
  tags?: string[];
  notes?: string[];
}

interface UpdateTaskInput {
  name?: string;
  listId?: string;
  priority?: Priority;
  dueDate?: Date | null;
  dueHasTime?: boolean;
  startDate?: Date | null;
  startHasTime?: boolean;
  tags?: string[];
  notes?: Note[];
}
```

### 4.2 Firestoreクエリ

```typescript
// リスト別タスク取得
async getTasksByList(listId: string): Promise<Task[]> {
  const q = query(
    collection(db, `users/${userId}/tasks`),
    where("listId", "==", listId),
    orderBy("completed"),
    orderBy("dueDate"),
    orderBy("priority")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(mapTask);
}

// スマートリスト: 今日
async getTodayTasks(): Promise<Task[]> {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);

  const q = query(
    collection(db, `users/${userId}/tasks`),
    where("completed", "==", false),
    where("dueDate", ">=", Timestamp.fromDate(today)),
    where("dueDate", "<", Timestamp.fromDate(tomorrow))
  );
  return (await getDocs(q)).docs.map(mapTask);
}

// スマートリスト: 期限切れ
async getOverdueTasks(): Promise<Task[]> {
  const today = startOfDay(new Date());

  const q = query(
    collection(db, `users/${userId}/tasks`),
    where("completed", "==", false),
    where("dueDate", "<", Timestamp.fromDate(today))
  );
  return (await getDocs(q)).docs.map(mapTask);
}
```

### 4.3 リアルタイム購読

```typescript
subscribeToTasks(listId: string, callback: (tasks: Task[]) => void): Unsubscribe {
  const q = query(
    collection(db, `users/${userId}/tasks`),
    where("listId", "==", listId),
    orderBy("completed"),
    orderBy("dueDate")
  );

  return onSnapshot(q, (snapshot) => {
    const tasks = snapshot.docs.map(mapTask);
    callback(tasks);
  });
}
```

---

## 5. リストサービス (ListService)

### 5.1 インターフェース

```typescript
interface ListService {
  // CRUD
  createList(name: string): Promise<List>;
  getList(listId: string): Promise<List | null>;
  updateList(listId: string, name: string): Promise<List>;
  deleteList(listId: string): Promise<void>;

  // 一覧
  getLists(): Promise<List[]>;

  // デフォルト
  getDefaultList(): Promise<List>;

  // リアルタイム
  subscribeToLists(callback: (lists: List[]) => void): Unsubscribe;

  // 統計
  getTaskCount(listId: string): Promise<number>;
}
```

### 5.2 リスト削除時の処理

```typescript
async deleteList(listId: string): Promise<void> {
  const batch = writeBatch(db);

  // リスト削除
  batch.delete(doc(db, `users/${userId}/lists/${listId}`));

  // 所属タスクをInboxに移動
  const tasks = await this.getTasksByList(listId);
  const defaultList = await this.getDefaultList();

  for (const task of tasks) {
    batch.update(doc(db, `users/${userId}/tasks/${task.id}`), {
      listId: defaultList.id,
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
}
```

---

## 6. タグサービス (TagService)

### 6.1 インターフェース

```typescript
interface TagService {
  // CRUD
  createTag(name: string): Promise<Tag>;
  getTag(tagId: string): Promise<Tag | null>;
  updateTag(tagId: string, name: string): Promise<Tag>;
  deleteTag(tagId: string): Promise<void>;

  // 一覧
  getTags(): Promise<Tag[]>;

  // 検索
  getTagByName(name: string): Promise<Tag | null>;
  getOrCreateTag(name: string): Promise<Tag>;

  // リアルタイム
  subscribeToTags(callback: (tags: Tag[]) => void): Unsubscribe;
}
```

---

## 7. スマートリストサービス (SmartListService)

### 7.1 インターフェース

```typescript
interface SmartListService {
  // ビルトイン
  getBuiltInSmartLists(): SmartList[];
  executeSmartListQuery(smartListId: string): Promise<Task[]>;

  // カスタム
  createSmartList(input: CreateSmartListInput): Promise<SmartList>;
  updateSmartList(id: string, input: UpdateSmartListInput): Promise<SmartList>;
  deleteSmartList(id: string): Promise<void>;

  // 一覧
  getSmartLists(): Promise<SmartList[]>;
}

interface CreateSmartListInput {
  name: string;
  filter: SmartListFilter;
}
```

### 7.2 ビルトインスマートリスト

```typescript
const BUILT_IN_SMART_LISTS: SmartList[] = [
  {
    id: "today",
    name: "今日",
    icon: "⭐",
    isBuiltIn: true,
    filter: {
      dueDateRange: { type: "today" },
      completed: false,
      operator: "AND",
    },
  },
  {
    id: "tomorrow",
    name: "明日",
    icon: "📅",
    isBuiltIn: true,
    filter: {
      dueDateRange: { type: "tomorrow" },
      completed: false,
      operator: "AND",
    },
  },
  {
    id: "this_week",
    name: "今週",
    icon: "📆",
    isBuiltIn: true,
    filter: {
      dueDateRange: { type: "thisWeek" },
      completed: false,
      operator: "AND",
    },
  },
  {
    id: "overdue",
    name: "期限切れ",
    icon: "⚠️",
    isBuiltIn: true,
    filter: {
      dueDateRange: { type: "overdue" },
      completed: false,
      operator: "AND",
    },
  },
  {
    id: "completed",
    name: "完了済み",
    icon: "✓",
    isBuiltIn: true,
    filter: {
      completed: true,
      operator: "AND",
    },
  },
];
```

---

## 8. インポートサービス (ImportService)

### 8.1 インターフェース

```typescript
interface ImportService {
  // インポート
  importRTMData(data: RTMExportData): Promise<ImportResult>;

  // 進捗
  onProgress(callback: (progress: ImportProgress) => void): void;
}

interface RTMExportData {
  config: RTMConfig;
  lists: RTMList[];
  tasks: RTMTask[];
  tags: RTMTag[];
  notes: RTMNote[];
  // ...
}

interface ImportResult {
  success: boolean;
  counts: {
    lists: number;
    tasks: number;
    tags: number;
    notes: number;
  };
  errors: ImportError[];
}

interface ImportProgress {
  phase: "lists" | "tags" | "tasks" | "notes";
  current: number;
  total: number;
  percent: number;
}
```

### 8.2 インポート処理フロー

```typescript
async importRTMData(data: RTMExportData): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    counts: { lists: 0, tasks: 0, tags: 0, notes: 0 },
    errors: [],
  };

  try {
    // 1. リストをインポート
    this.emitProgress("lists", 0, data.lists.length);
    const listIdMap = await this.importLists(data.lists);
    result.counts.lists = data.lists.length;

    // 2. タグをインポート
    this.emitProgress("tags", 0, data.tags.length);
    const tagIdMap = await this.importTags(data.tags);
    result.counts.tags = data.tags.length;

    // 3. タスクをインポート（バッチ処理）
    this.emitProgress("tasks", 0, data.tasks.length);
    await this.importTasks(data.tasks, listIdMap, tagIdMap, data.notes);
    result.counts.tasks = data.tasks.length;

  } catch (error) {
    result.success = false;
    result.errors.push({ message: error.message });
  }

  return result;
}

private async importTasks(
  tasks: RTMTask[],
  listIdMap: Map<string, string>,
  tagIdMap: Map<string, string>,
  notes: RTMNote[]
): Promise<void> {
  // ノートをタスクIDでグループ化
  const notesBySeriesId = this.groupNotesBySeriesId(notes);

  // バッチ処理（500件ずつ）
  const BATCH_SIZE = 500;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = tasks.slice(i, i + BATCH_SIZE);

    for (const rtmTask of chunk) {
      const task = this.convertTask(rtmTask, listIdMap, tagIdMap, notesBySeriesId);
      const docRef = doc(collection(db, `users/${userId}/tasks`));
      batch.set(docRef, task);
    }

    await batch.commit();
    this.emitProgress("tasks", i + chunk.length, tasks.length);
  }
}
```

### 8.3 データ変換

```typescript
private convertTask(
  rtm: RTMTask,
  listIdMap: Map<string, string>,
  tagIdMap: Map<string, string>,
  notesBySeriesId: Map<string, RTMNote[]>
): Task {
  return {
    id: rtm.id,
    seriesId: rtm.series_id,
    listId: listIdMap.get(rtm.list_id) || this.defaultListId,
    parentId: rtm.parent_id || null,
    name: rtm.name,
    priority: this.convertPriority(rtm.priority),
    tags: (rtm.tags || []).map(t => tagIdMap.get(t)).filter(Boolean),
    dueDate: rtm.date_due ? Timestamp.fromMillis(rtm.date_due) : null,
    dueHasTime: rtm.date_due_has_time || false,
    startDate: rtm.date_start ? Timestamp.fromMillis(rtm.date_start) : null,
    startHasTime: rtm.date_start_has_time || false,
    repeat: null, // RTMのrepeat形式は複雑なため、初期実装ではスキップ
    notes: this.convertNotes(notesBySeriesId.get(rtm.series_id) || []),
    completed: !!rtm.date_completed,
    completedAt: rtm.date_completed ? Timestamp.fromMillis(rtm.date_completed) : null,
    postponed: rtm.postponed || 0,
    source: "import",
    createdAt: Timestamp.fromMillis(rtm.date_created),
    updatedAt: Timestamp.fromMillis(rtm.date_modified),
  };
}

private convertPriority(rtmPriority: string): Priority {
  const map: Record<string, Priority> = {
    P1: 1,
    P2: 2,
    P3: 3,
    PN: 4,
  };
  return map[rtmPriority] || 4;
}
```

---

## 9. Smart Add パーサー

タスク入力時に自然言語でタグ、優先度、期限を指定できる機能。

### 9.1 構文

| 構文 | 意味 | 例 |
|------|------|-----|
| `#tag` | タグ追加 | `買い物 #urgent` |
| `!1` `!2` `!3` | 優先度 | `タスク !1` |
| `^today` | 期限:今日 | `レポート ^today` |
| `^tomorrow` | 期限:明日 | `会議準備 ^tomorrow` |
| `^monday` | 期限:次の月曜 | `提出 ^monday` |
| `^1/15` | 期限:日付 | `予約 ^1/15` |

### 9.2 パーサー実装

```typescript
interface ParsedTask {
  name: string;
  tags: string[];
  priority: Priority | null;
  dueDate: Date | null;
}

function parseSmartAdd(input: string): ParsedTask {
  const result: ParsedTask = {
    name: input,
    tags: [],
    priority: null,
    dueDate: null,
  };

  // タグ抽出: #tag
  const tagRegex = /#(\w+)/g;
  let match;
  while ((match = tagRegex.exec(input)) !== null) {
    result.tags.push(match[1]);
  }
  result.name = result.name.replace(tagRegex, "").trim();

  // 優先度抽出: !1, !2, !3
  const priorityMatch = result.name.match(/!([1-3])/);
  if (priorityMatch) {
    result.priority = parseInt(priorityMatch[1]) as Priority;
    result.name = result.name.replace(/![1-3]/, "").trim();
  }

  // 期限抽出: ^today, ^tomorrow, ^1/15
  const dueDateMatch = result.name.match(/\^(\S+)/);
  if (dueDateMatch) {
    result.dueDate = parseDueDate(dueDateMatch[1]);
    result.name = result.name.replace(/\^\S+/, "").trim();
  }

  return result;
}

function parseDueDate(input: string): Date | null {
  const today = new Date();

  switch (input.toLowerCase()) {
    case "today":
      return today;
    case "tomorrow":
      return addDays(today, 1);
    case "monday":
    case "mon":
      return nextDay(today, 1);
    // ... 他の曜日
    default:
      // 日付パース: 1/15, 2024/1/15
      const dateMatch = input.match(/(\d{1,2})\/(\d{1,2})/);
      if (dateMatch) {
        const month = parseInt(dateMatch[1]) - 1;
        const day = parseInt(dateMatch[2]);
        return new Date(today.getFullYear(), month, day);
      }
      return null;
  }
}
```

---

## 10. エラーハンドリング

### 10.1 エラー種別

```typescript
enum ErrorCode {
  // 認証
  AUTH_INVALID_EMAIL = "auth/invalid-email",
  AUTH_WRONG_PASSWORD = "auth/wrong-password",
  AUTH_USER_NOT_FOUND = "auth/user-not-found",

  // Firestore
  PERMISSION_DENIED = "permission-denied",
  NOT_FOUND = "not-found",
  ALREADY_EXISTS = "already-exists",

  // アプリ
  VALIDATION_ERROR = "validation-error",
  IMPORT_ERROR = "import-error",
}

class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}
```

### 10.2 エラーメッセージ

```typescript
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.AUTH_INVALID_EMAIL]: "メールアドレスの形式が正しくありません",
  [ErrorCode.AUTH_WRONG_PASSWORD]: "パスワードが正しくありません",
  [ErrorCode.AUTH_USER_NOT_FOUND]: "ユーザーが見つかりません",
  [ErrorCode.PERMISSION_DENIED]: "アクセス権限がありません",
  [ErrorCode.NOT_FOUND]: "データが見つかりません",
  [ErrorCode.ALREADY_EXISTS]: "既に存在します",
  [ErrorCode.VALIDATION_ERROR]: "入力内容に誤りがあります",
  [ErrorCode.IMPORT_ERROR]: "インポートに失敗しました",
};
```

---

## 11. オフライン対応（将来）

### 11.1 Firestore オフライン永続化

```typescript
// Web版
import { enableIndexedDbPersistence } from "firebase/firestore";

enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    // 複数タブで開いている
  } else if (err.code === "unimplemented") {
    // ブラウザが未対応
  }
});
```

```swift
// iOS版
let settings = FirestoreSettings()
settings.cacheSettings = PersistentCacheSettings()
Firestore.firestore().settings = settings
```
