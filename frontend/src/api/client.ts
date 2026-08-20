export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

export function getApiKey(): string {
  const apiKey = import.meta.env.VITE_API_KEY

  if (!apiKey) {
    throw new Error(
      'VITE_API_KEY is not configured. Add it to frontend/.env before submitting.',
    )
  }

  return apiKey
}

export async function parseApiErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error
    }
  } catch {
    // Non-JSON error bodies still surface as an HTTP status message.
  }

  return `Request failed with status ${response.status}`
}
