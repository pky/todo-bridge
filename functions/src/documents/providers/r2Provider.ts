import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  CreateDownloadUrlInput,
  CreateUploadUrlInput,
  ObjectStorageProvider,
  SignedDownload,
  SignedUpload,
  StoredObject,
  WriteObjectInput,
} from './types'

export interface R2ProviderConfig {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

const REQUIRED_R2_ENV_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const

export function readR2ProviderConfig(
  environment: NodeJS.ProcessEnv = process.env
): R2ProviderConfig {
  const missingKeys = REQUIRED_R2_ENV_KEYS.filter((key) => !environment[key]?.trim())
  if (missingKeys.length > 0) {
    throw new Error(`R2設定が不足しています: ${missingKeys.join(', ')}`)
  }

  return {
    accountId: environment.R2_ACCOUNT_ID!.trim(),
    bucket: environment.R2_BUCKET!.trim(),
    accessKeyId: environment.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY!.trim(),
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate.name === 'NotFound'
    || candidate.name === 'NoSuchKey'
    || candidate.$metadata?.httpStatusCode === 404
}

function buildDownloadDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export function assertDeleteObjectsSucceeded(
  result: { Errors?: Array<{ Code?: string }> }
): void {
  if (!result.Errors?.length) return
  const codes = [...new Set(result.Errors.map((error) => error.Code).filter(Boolean))]
  const suffix = codes.length > 0 ? `: ${codes.join(', ')}` : ''
  throw new Error(`R2オブジェクトの一部を削除できませんでした（${result.Errors.length}件）${suffix}`)
}

export class R2ObjectStorageProvider implements ObjectStorageProvider {
  private readonly client: S3Client

  constructor(private readonly config: R2ProviderConfig) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  async createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      ContentType: input.contentType,
      Metadata: input.metadata,
    })
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
    })
    const headers: Record<string, string> = {
      'Content-Type': input.contentType,
    }
    Object.entries(input.metadata ?? {}).forEach(([key, value]) => {
      headers[`x-amz-meta-${key.toLowerCase()}`] = value
    })

    return {
      url,
      method: 'PUT',
      headers,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    }
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<SignedDownload> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      ...(input.downloadFileName
        ? { ResponseContentDisposition: buildDownloadDisposition(input.downloadFileName) }
        : {}),
    })
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
    })
    return {
      url,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    }
  }

  async stat(objectKey: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
      }))
      return {
        objectKey,
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
        lastModifiedAt: result.LastModified ?? null,
        metadata: result.Metadata ?? {},
      }
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async readObject(objectKey: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
      }))
      if (!result.Body) return null
      return Buffer.from(await result.Body.transformToByteArray())
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async writeObject(input: WriteObjectInput): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      Body: input.data,
      ContentType: input.contentType,
      Metadata: input.metadata,
    }))
  }

  async deleteObjects(objectKeys: string[]): Promise<void> {
    for (let index = 0; index < objectKeys.length; index += 1000) {
      const keys = objectKeys.slice(index, index + 1000)
      if (keys.length === 0) continue
      const result = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true,
        },
      }))
      assertDeleteObjectsSucceeded(result)
    }
  }
}

export function createR2ObjectStorageProvider(
  environment: NodeJS.ProcessEnv = process.env
): R2ObjectStorageProvider {
  return new R2ObjectStorageProvider(readR2ProviderConfig(environment))
}
