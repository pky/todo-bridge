import { ClassificationResult, OcrPageResult } from '../providers/types'
import { FamilyDocumentCategory } from '../types'

const categoryKeywords: Record<Exclude<FamilyDocumentCategory, 'other'>, string[]> = {
  school_childcare: ['学校', '保育', '幼稚園', '園行事', '学級', '保護者', '児童', '生徒', '給食', '授業', '遠足'],
  medical: ['病院', '医院', '診療', '処方', '薬局', '健康診断', '予防接種', '医療'],
  insurance_tax: ['保険', '税', '確定申告', '控除', '年金', '納税'],
  home_warranty: ['保証', '修理', '取扱説明', '型番', '住宅', '家電', '点検'],
  billing_receipt: ['請求', '領収', '支払', 'お買上', '合計', '金額', '振込'],
  contact: ['名刺', '電話', '携帯', 'メール', 'email', 'e-mail', '住所'],
}

export function classifyDocumentByRules(
  documentName: string,
  pages: OcrPageResult[]
): ClassificationResult {
  const source = `${documentName}\n${pages.map((page) => page.text).join('\n')}`.toLocaleLowerCase('ja-JP')
  const scores = Object.entries(categoryKeywords).map(([category, keywords]) => ({
    category: category as Exclude<FamilyDocumentCategory, 'other'>,
    score: keywords.reduce((score, keyword) => (
      score + (source.includes(keyword.toLocaleLowerCase('ja-JP')) ? 1 : 0)
    ), 0),
  })).sort((left, right) => right.score - left.score)
  const best = scores[0]
  if (!best || best.score === 0) return { category: 'other', confidence: null }
  const secondScore = scores[1]?.score ?? 0
  const confidence = Math.min(0.95, 0.62 + best.score * 0.1 + (best.score > secondScore ? 0.08 : 0))
  return { category: best.category, confidence }
}
