import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DocumentOcrSettingsSection from '@/components/settings/DocumentOcrSettingsSection.vue'

const updateSettingsMock = vi.hoisted(() => vi.fn())
const onSnapshotMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/documentService', () => ({
  updateDocumentOcrSettingsApi: updateSettingsMock,
}))

vi.mock('@/services/firebase', () => ({ db: {} }))

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((...args: unknown[]) => args),
  onSnapshot: onSnapshotMock,
}))

describe('DocumentOcrSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateSettingsMock.mockResolvedValue({ success: true })
    onSnapshotMock.mockImplementation((_reference, onNext) => {
      onNext({ exists: () => false, data: () => ({}) })
      return vi.fn()
    })
  })

  it('ownerは説明への同意後だけOCRを有効化できる', async () => {
    const wrapper = mount(DocumentOcrSettingsSection, {
      props: { spaceId: 'family-space', canManage: true },
    })

    await wrapper.get('button').trigger('click')
    const enableButton = wrapper.findAll('button').find((button) =>
      button.text().includes('同意して有効化')
    )
    expect(enableButton?.attributes('disabled')).toBeDefined()

    await wrapper.get('input[type="checkbox"]').setValue(true)
    expect(enableButton?.attributes('disabled')).toBeUndefined()
    await enableButton?.trigger('click')

    expect(updateSettingsMock).toHaveBeenCalledWith('family-space', true, 1)
  })

  it('memberには変更ボタンを表示しない', () => {
    const wrapper = mount(DocumentOcrSettingsSection, {
      props: { spaceId: 'family-space', canManage: false },
    })

    expect(wrapper.text()).toContain('ownerが管理します')
    expect(wrapper.text()).not.toContain('説明を確認して有効にする')
  })
})
