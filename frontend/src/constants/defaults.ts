import type { AnalyzeRequest } from '../types/analyze'

export const DEFAULT_ANALYZE_REQUEST: AnalyzeRequest = {
  image_base64: '',
  extraction_target:
    'Identify the turn direction, trigger distance, and target magnetic heading.',
  operator_id: '',
  airportId: 'KCLT',
  runwayId: '36R',
  navaidId: 'CLT',
}
