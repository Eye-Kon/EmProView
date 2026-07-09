import type { AnalyzeRequest } from '../types/analyze'

export const DEFAULT_ANALYZE_REQUEST: AnalyzeRequest = {
  procedure_text:
    'Climb on heading 360. At 5 DME from CLT VORTAC, turn RIGHT heading 050.',
  extraction_target:
    'Identify the turn direction, trigger distance, and target magnetic heading.',
  airportId: 'KCLT',
  runwayId: '36R',
  navaidId: 'CLT',
}
