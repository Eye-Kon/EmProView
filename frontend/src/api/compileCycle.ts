import { API_BASE_URL, getApiKey, parseApiErrorMessage } from './client'
import {
  CompileCycleApiError,
  type CompileCycleRequest,
  type CompileCycleResponse,
} from '../types/compileCycle'

export async function compileCycle(
  request: CompileCycleRequest,
): Promise<CompileCycleResponse> {
  const apiKey = getApiKey()
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}/api/compile-cycle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(request),
    })
  } catch {
    throw new CompileCycleApiError(
      0,
      'Unable to reach the cycle compiler API. Confirm the backend is running.',
    )
  }

  if (!response.ok) {
    throw new CompileCycleApiError(
      response.status,
      await parseApiErrorMessage(response),
    )
  }

  return (await response.json()) as CompileCycleResponse
}
