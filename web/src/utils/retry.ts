const NON_RETRYABLE_CODES = new Set([
  'permission-denied',
  'unauthenticated',
  'not-found',
  'invalid-argument',
])

interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000 } = options
  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const code = (err as any)?.code as string | undefined
      if (code && NON_RETRYABLE_CODES.has(code)) throw err
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)))
      }
    }
  }

  throw lastError
}
