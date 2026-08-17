import type { AnalyzeRequest } from '../types/analyze'

export const DEFAULT_ANALYZE_REQUEST: AnalyzeRequest = {
  image_base64: '',
  extraction_target:
    'Extract the full engine failure procedure matrix: every runway with its ordered legs (DME tracks, turns, altitude climbs).',
  operator_id: '',
  airportId: 'KCLT',
  navaidId: 'CLT',
}
