import * as functions from 'firebase-functions/v1'
import {
  getLocalRequestMetadata,
  isValidLocalSignature,
  readLocalObject,
  writeLocalObject,
} from './localProvider'

function applyCors(request: functions.https.Request, response: functions.Response): void {
  const origin = request.get('origin') ?? ''
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$/.test(origin)) {
    response.set('Access-Control-Allow-Origin', origin)
    response.set('Vary', 'Origin')
  }
  response.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS')
  response.set('Access-Control-Allow-Headers', 'Content-Type')
  response.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type')
}

function getParameters(request: functions.https.Request): URLSearchParams {
  return new URL(request.originalUrl, 'http://127.0.0.1').searchParams
}

export const localDocumentObject = functions
  .region('asia-northeast1')
  .https.onRequest(async (request, response) => {
    applyCors(request, response)
    if (request.method === 'OPTIONS') {
      response.status(204).end()
      return
    }

    if (process.env.FUNCTIONS_EMULATOR !== 'true') {
      response.status(404).end()
      return
    }

    const parameters = getParameters(request)
    const expires = Number(parameters.get('expires'))
    if (!Number.isSafeInteger(expires)
      || expires < Date.now()
      || !isValidLocalSignature(parameters)) {
      response.status(403).send('署名URLが無効または期限切れです')
      return
    }

    const objectKey = parameters.get('objectKey') ?? ''
    const operation = parameters.get('operation')
    response.set('Cache-Control', 'private, no-store')

    if (operation === 'put' && request.method === 'PUT') {
      const contentType = parameters.get('contentType') ?? ''
      const contentLength = Number(parameters.get('contentLength'))
      const requestContentType = request.get('content-type') ?? ''
      const body = request.rawBody
      if (!contentType
        || requestContentType !== contentType
        || !Number.isSafeInteger(contentLength)
        || contentLength <= 0
        || body.length !== contentLength) {
        response.status(400).send('アップロード内容が署名条件と一致しません')
        return
      }

      await writeLocalObject(
        objectKey,
        contentType,
        getLocalRequestMetadata(parameters),
        body
      )
      response.status(200).end()
      return
    }

    if (operation === 'get' && (request.method === 'GET' || request.method === 'HEAD')) {
      const body = await readLocalObject(objectKey)
      if (!body) {
        response.status(404).end()
        return
      }
      const metadata = await import('./localProvider').then((module) => (
        new module.LocalObjectStorageProvider().stat(objectKey)
      ))
      if (!metadata) {
        response.status(404).end()
        return
      }

      response.set('Content-Type', metadata.contentType ?? 'application/octet-stream')
      response.set('Content-Length', String(body.length))
      const downloadFileName = parameters.get('downloadFileName')
      if (downloadFileName) {
        response.set(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`
        )
      }
      if (request.method === 'HEAD') {
        response.status(200).end()
        return
      }
      response.status(200).send(body)
      return
    }

    response.status(405).end()
  })
