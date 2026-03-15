import { describe, it, expect } from 'vitest'
import {
  convertRTMPriority,
  convertRTMTask,
  convertRTMList,
  extractTags,
  groupNotesBySeriesId,
} from '@/utils/rtmConverter'
import type { RTMTask, RTMList, RTMNote } from '@/types/rtm'

describe('RTM Converter', () => {
  describe('convertRTMPriority', () => {
    it('P1 → 1 (高)', () => {
      expect(convertRTMPriority('P1')).toBe(1)
    })

    it('P2 → 2 (中)', () => {
      expect(convertRTMPriority('P2')).toBe(2)
    })

    it('P3 → 3 (低)', () => {
      expect(convertRTMPriority('P3')).toBe(3)
    })

    it('PN → 4 (なし)', () => {
      expect(convertRTMPriority('PN')).toBe(4)
    })
  })

  describe('convertRTMList', () => {
    it('RTMリストをReRTMリストに変換する', () => {
      const rtmList: RTMList = {
        id: '12345',
        name: 'テストリスト',
        date_created: 1609459200000, // 2021-01-01
        date_modified: 1609545600000, // 2021-01-02
      }

      const result = convertRTMList(rtmList)

      expect(result.rtmId).toBe('12345')
      expect(result.name).toBe('テストリスト')
      expect(result.dateCreated.getTime()).toBe(1609459200000)
      expect(result.dateModified.getTime()).toBe(1609545600000)
    })
  })

  describe('convertRTMTask', () => {
    const listIdMap = new Map([['rtm-list-1', 'firestore-list-1']])
    const notesMap = new Map<string, string[]>()

    it('基本的なタスクを変換する', () => {
      const rtmTask: RTMTask = {
        id: 'task-1',
        series_id: 'series-1',
        list_id: 'rtm-list-1',
        name: 'テストタスク',
        priority: 'P1',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        tags: [],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMap)

      expect(result.name).toBe('テストタスク')
      expect(result.listId).toBe('firestore-list-1')
      expect(result.priority).toBe(1)
      expect(result.completed).toBe(false)
      expect(result.tags).toEqual([])
    })

    it('完了したタスクを変換する', () => {
      const rtmTask: RTMTask = {
        id: 'task-2',
        series_id: 'series-2',
        list_id: 'rtm-list-1',
        name: '完了タスク',
        priority: 'PN',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        date_completed: 1609632000000,
        tags: [],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMap)

      expect(result.completed).toBe(true)
      expect(result.dateCompleted?.getTime()).toBe(1609632000000)
    })

    it('期限付きタスクを変換する', () => {
      const rtmTask: RTMTask = {
        id: 'task-3',
        series_id: 'series-3',
        list_id: 'rtm-list-1',
        name: '期限タスク',
        priority: 'P2',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        date_due: 1609718400000,
        tags: [],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMap)

      expect(result.dueDate?.getTime()).toBe(1609718400000)
    })

    it('タグ付きタスクを変換する', () => {
      const rtmTask: RTMTask = {
        id: 'task-4',
        series_id: 'series-4',
        list_id: 'rtm-list-1',
        name: 'タグ付きタスク',
        priority: 'P3',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        tags: ['重要', 'work'],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMap)

      expect(result.tags).toEqual(['重要', 'work'])
    })

    it('ノート付きタスクを変換する', () => {
      const notesMapWithNotes = new Map([
        ['series-5', ['メモ1', 'メモ2']],
      ])

      const rtmTask: RTMTask = {
        id: 'task-5',
        series_id: 'series-5',
        list_id: 'rtm-list-1',
        name: 'ノート付きタスク',
        priority: 'PN',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        tags: [],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMapWithNotes)

      expect(result.notes).toEqual(['メモ1', 'メモ2'])
    })

    it('存在しないリストIDの場合はInboxにフォールバック', () => {
      const rtmTask: RTMTask = {
        id: 'task-6',
        series_id: 'series-6',
        list_id: 'unknown-list',
        name: '不明リストタスク',
        priority: 'PN',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        tags: [],
      }

      const mapWithInbox = new Map([
        ['rtm-list-1', 'firestore-list-1'],
        ['inbox', 'inbox-id'],
      ])

      const result = convertRTMTask(rtmTask, mapWithInbox, notesMap, 'inbox-id')

      expect(result.listId).toBe('inbox-id')
    })

    it('サブタスク（parent_id有り）の場合、rtmParentIdが設定される', () => {
      const rtmTask: RTMTask = {
        id: 'subtask-1',
        series_id: 'series-sub-1',
        list_id: 'rtm-list-1',
        parent_id: 'parent-task-1',
        name: 'サブタスク',
        priority: 'PN',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        tags: [],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMap)

      expect(result.rtmParentId).toBe('parent-task-1')
    })

    it('親タスク（parent_id無し）の場合、rtmParentIdはnull', () => {
      const rtmTask: RTMTask = {
        id: 'parent-task-1',
        series_id: 'series-parent-1',
        list_id: 'rtm-list-1',
        name: '親タスク',
        priority: 'PN',
        date_created: 1609459200000,
        date_added: 1609459200000,
        date_modified: 1609545600000,
        tags: [],
      }

      const result = convertRTMTask(rtmTask, listIdMap, notesMap)

      expect(result.rtmParentId).toBeNull()
    })
  })

  describe('extractTags', () => {
    it('タスクから一意のタグを抽出する', () => {
      const tasks: RTMTask[] = [
        { id: '1', series_id: 's1', list_id: 'l1', name: 't1', priority: 'PN', date_created: 0, date_added: 0, date_modified: 0, tags: ['work', 'important'] },
        { id: '2', series_id: 's2', list_id: 'l1', name: 't2', priority: 'PN', date_created: 0, date_added: 0, date_modified: 0, tags: ['work', 'personal'] },
        { id: '3', series_id: 's3', list_id: 'l1', name: 't3', priority: 'PN', date_created: 0, date_added: 0, date_modified: 0, tags: [] },
      ]

      const result = extractTags(tasks)

      expect(result).toHaveLength(3)
      expect(result).toContain('work')
      expect(result).toContain('important')
      expect(result).toContain('personal')
    })

    it('タスクがない場合は空配列を返す', () => {
      const result = extractTags([])
      expect(result).toEqual([])
    })
  })

  describe('groupNotesBySeriesId', () => {
    it('ノートをseries_idでグループ化する', () => {
      const notes: RTMNote[] = [
        { id: 'n1', series_id: 's1', date_created: 0, date_modified: 0, content: 'ノート1' },
        { id: 'n2', series_id: 's1', date_created: 0, date_modified: 0, content: 'ノート2' },
        { id: 'n3', series_id: 's2', date_created: 0, date_modified: 0, content: 'ノート3' },
      ]

      const result = groupNotesBySeriesId(notes)

      expect(result.get('s1')).toEqual(['ノート1', 'ノート2'])
      expect(result.get('s2')).toEqual(['ノート3'])
    })

    it('タイトルがある場合はタイトル付きで追加', () => {
      const notes: RTMNote[] = [
        { id: 'n1', series_id: 's1', date_created: 0, date_modified: 0, title: '重要', content: '内容' },
      ]

      const result = groupNotesBySeriesId(notes)

      expect(result.get('s1')?.[0]).toBe('【重要】内容')
    })

    it('空のノート配列は空のMapを返す', () => {
      const result = groupNotesBySeriesId([])
      expect(result.size).toBe(0)
    })
  })
})
