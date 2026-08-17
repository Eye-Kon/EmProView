import {
  AnalyzeApiError,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type ApiErrorBody,
} from '../types/analyze'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

function getApiKey(): string {
  const apiKey = import.meta.env.VITE_API_KEY

  if (!apiKey) {
    throw new AnalyzeApiError(
      0,
      'VITE_API_KEY is not configured. Add it to frontend/.env before submitting.',
    )
  }

  return apiKey
}

async function parseErrorBody(
  response: Response,
): Promise<{ message: string; transcription: string | null }> {
  try {
    const body = (await response.json()) as ApiErrorBody
    const message =
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : `Request failed with status ${response.status}`
    const transcription =
      typeof body.transcription === 'string' && body.transcription.trim()
        ? body.transcription
        : null

    return { message, transcription }
  } catch {
    return {
      message: `Request failed with status ${response.status}`,
      transcription: null,
    }
  }
}

export async function analyzeProcedure(
  request: AnalyzeRequest,
): Promise<AnalyzeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getApiKey(),
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const { message, transcription } = await parseErrorBody(response)
    throw new AnalyzeApiError(response.status, message, transcription)
  }

  return (await response.json()) as AnalyzeResponse
}
