import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat as fileStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CreateDownloadUrlInput,
  CreateUploadUrlInput,
  ListedObject,
  ObjectStorageProvider,
  SignedDownload,
  SignedUpload,
  StoredObject,
  WriteObjectInput,
} from './types'

const LOCAL_STORAGE_DIRECTORY = join(tmpdir(), 'rertm-document-objects')
const LOCAL_SIGNING_SECRET = 'rertm-local-emulator-only'

interface LocalObjectMetadata {
  objectKey: string
  contentType: string
  metadata: Record<string, string>
  updatedAt: string
}

function getProjectId(): string {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { projectId?: string }
    return config.projectId ?? 'demo-rertm'
  } catch {
    return 'demo-rertm'
  }
}

function getObjectId(objectKey: string): string {
  return createHash('sha256').update(objectKey).digest('hex')
}

function getObjectPaths(objectKey: string): { dataPath: string; metadataPath: string } {
  const objectId = getObjectId(objectKey)
  return {
    dataPath: join(LOCAL_STORAGE_DIRECTORY, `${objectId}.bin`),
    metadataPath: join(LOCAL_STORAGE_DIRECTORY, `${objectId}.json`),
  }
}

function encodeMetadata(metadata: Record<string, string>): string {
  return Buffer.from(JSON.stringify(metadata)).toString('base64url')
}

function decodeMetadata(value: string | undefined): Record<string, string> {
  if (!value) return {}
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function buildSignature(parameters: URLSearchParams): string {
  const values = [
    parameters.get('operation') ?? '',
    parameters.get('objectKey') ?? '',
    parameters.get('expires') ?? '',
    parameters.get('contentType') ?? '',
    parameters.get('contentLength') ?? '',
    parameters.get('metadata') ?? '',
    parameters.get('downloadFileName') ?? '',
  ]
  return createHmac('sha256', LOCAL_SIGNING_SECRET).update(values.join('\n')).digest('hex')
}

export function isValidLocalSignature(parameters: URLSearchParams): boolean {
  const actual = parameters.get('signature') ?? ''
  const expected = buildSignature(parameters)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

function createSignedLocalUrl(parameters: Record<string, string>): string {
  const query = new URLSearchParams(parameters)
  query.set('signature', buildSignature(query))
  const host = process.env.DOCUMENT_EMULATOR_HOST?.trim() || '127.0.0.1'
  if (!/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})$/.test(host)) {
    throw new Error('DOCUMENT_EMULATOR_HOSTが不正です')
  }
  return `http://${host}:5001/${getProjectId()}/asia-northeast1/localDocumentObject?${query}`
}

async function readMetadata(objectKey: string): Promise<LocalObjectMetadata | null> {
  const { metadataPath } = getObjectPaths(objectKey)
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8')) as LocalObjectMetadata
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeLocalObject(
  objectKey: string,
  contentType: string,
  metadata: Record<string, string>,
  data: Buffer
): Promise<void> {
  await mkdir(LOCAL_STORAGE_DIRECTORY, { recursive: true })
  const paths = getObjectPaths(objectKey)
  const record: LocalObjectMetadata = {
    objectKey,
    contentType,
    metadata,
    updatedAt: new Date().toISOString(),
  }
  await Promise.all([
    writeFile(paths.dataPath, data),
    writeFile(paths.metadataPath, JSON.stringify(record)),
  ])
}

export async function readLocalObject(objectKey: string): Promise<Buffer | null> {
  const { dataPath } = getObjectPaths(objectKey)
  try {
    return await readFile(dataPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class LocalObjectStorageProvider implements ObjectStorageProvider {
  async createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000)
    return {
      url: createSignedLocalUrl({
        operation: 'put',
        objectKey: input.objectKey,
        expires: String(expiresAt.getTime()),
        contentType: input.contentType,
        contentLength: String(input.contentLength),
        metadata: encodeMetadata(input.metadata ?? {}),
        downloadFileName: '',
      }),
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt,
    }
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<SignedDownload> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000)
    return {
      url: createSignedLocalUrl({
        operation: 'get',
        objectKey: input.objectKey,
        expires: String(expiresAt.getTime()),
        contentType: '',
        contentLength: '',
        metadata: '',
        downloadFileName: input.downloadFileName ?? '',
      }),
      expiresAt,
    }
  }

  async stat(objectKey: string): Promise<StoredObject | null> {
    const metadata = await readMetadata(objectKey)
    if (!metadata) return null
    const { dataPath } = getObjectPaths(objectKey)
    try {
      const result = await fileStat(dataPath)
      return {
        objectKey,
        sizeBytes: result.size,
        contentType: metadata.contentType,
        etag: getObjectId(objectKey),
        lastModifiedAt: new Date(metadata.updatedAt),
        metadata: metadata.metadata,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async listObjects(prefix: string): Promise<ListedObject[]> {
    let fileNames: string[]
    try {
      fileNames = await readdir(LOCAL_STORAGE_DIRECTORY)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const objects = await Promise.all(fileNames
      .filter((fileName) => fileName.endsWith('.json'))
      .map(async (fileName): Promise<ListedObject | null> => {
        try {
          const metadata = JSON.parse(
            await readFile(join(LOCAL_STORAGE_DIRECTORY, fileName), 'utf8')
          ) as LocalObjectMetadata
          if (!metadata.objectKey.startsWith(prefix)) return null
          const storedObject = await this.stat(metadata.objectKey)
          if (!storedObject) return null
          return {
            objectKey: storedObject.objectKey,
            sizeBytes: storedObject.sizeBytes,
            lastModifiedAt: storedObject.lastModifiedAt,
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }))
    return objects.filter((object): object is ListedObject => object !== null)
  }

  async readObject(objectKey: string): Promise<Buffer | null> {
    return readLocalObject(objectKey)
  }

  async writeObject(input: WriteObjectInput): Promise<void> {
    await writeLocalObject(
      input.objectKey,
      input.contentType,
      input.metadata ?? {},
      input.data
    )
  }

  async deleteObjects(objectKeys: string[]): Promise<void> {
    await Promise.all(objectKeys.flatMap((objectKey) => {
      const paths = getObjectPaths(objectKey)
      return [
        rm(paths.dataPath, { force: true }),
        rm(paths.metadataPath, { force: true }),
      ]
    }))
  }
}

export function getLocalRequestParameters(url: string): URLSearchParams {
  return new URL(url, 'http://127.0.0.1').searchParams
}

export function getLocalRequestMetadata(parameters: URLSearchParams): Record<string, string> {
  return decodeMetadata(parameters.get('metadata') ?? undefined)
}
