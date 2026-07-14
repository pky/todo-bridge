import { GoogleAuth } from 'google-auth-library'
import { DocumentOcrProvider, OcrPageInput, OcrPageResult } from './types'

export const CLOUD_VISION_EU_ENDPOINT = 'https://eu-vision.googleapis.com/v1/images:annotate'

interface CloudVisionPage {
  confidence?: number
}

interface CloudVisionResponse {
  responses?: Array<{
    fullTextAnnotation?: {
      text?: string
      pages?: CloudVisionPage[]
    }
    error?: {
      code?: number
      message?: string
    }
  }>
}

export interface CloudVisionRequest {
  requests: Array<{
    image: { content: string }
    features: Array<{ type: 'DOCUMENT_TEXT_DETECTION' }>
    imageContext?: { languageHints: string[] }
  }>
}

export type CloudVisionRequester = (
  request: CloudVisionRequest
) => Promise<CloudVisionResponse>

async function requestCloudVision(request: CloudVisionRequest): Promise<CloudVisionResponse> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const client = await auth.getClient()
  const response = await client.request<CloudVisionResponse>({
    url: CLOUD_VISION_EU_ENDPOINT,
    method: 'POST',
    data: request,
  })
  return response.data
}

function calculateConfidence(pages: CloudVisionPage[] | undefined): number | null {
  const values = pages
    ?.map((page) => page.confidence)
    .filter((confidence): confidence is number => typeof confidence === 'number') ?? []
  if (values.length === 0) return null
  return values.reduce((sum, confidence) => sum + confidence, 0) / values.length
}

export class CloudVisionOcrProvider implements DocumentOcrProvider {
  constructor(private readonly requester: CloudVisionRequester = requestCloudVision) {}

  async extractPage(input: OcrPageInput): Promise<OcrPageResult> {
    const response = await this.requester({
      requests: [{
        image: { content: input.image.toString('base64') },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        ...(input.languageHints.length > 0
          ? { imageContext: { languageHints: input.languageHints } }
          : {}),
      }],
    })
    const result = response.responses?.[0]
    if (!result) throw new Error('Cloud Visionから結果が返されませんでした')
    if (result.error) {
      const code = result.error.code === undefined ? '' : `（${result.error.code}）`
      throw new Error(`Cloud Visionの処理に失敗しました${code}`)
    }

    return {
      pageNumber: input.pageNumber,
      text: result.fullTextAnnotation?.text?.trim() ?? '',
      confidence: calculateConfidence(result.fullTextAnnotation?.pages),
      source: 'cloud_vision',
    }
  }
}
