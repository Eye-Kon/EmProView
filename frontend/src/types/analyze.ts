import type { FeatureCollection } from 'geojson'

export interface AnalyzeRequest {
  procedure_text: string
  extraction_target: string
  airportId: string
  runwayId: string
  navaidId: string
}

export interface ExtractionResult {
  extracted_value: string
  turn_direction: 'LEFT' | 'RIGHT' | 'NONE'
  trigger_distance_nm: number
  target_magnetic_heading: number | null
}

export interface TriggerPoint {
  latitude: number
  longitude: number
  distanceAlongTrackNM: number
  dmeErrorNM: number
}

export interface AiracCycle {
  ident: string
  effectiveFrom: string
  effectiveTo: string
  source: string
}

export interface Disambiguation {
  candidateCount: number
  selectedDistanceNM: number
  nextNearestDistanceNM: number
  note: string
}

export interface AnalyzeResponse {
  extraction: ExtractionResult
  airacCycle: AiracCycle
  triggerPoint: TriggerPoint
  parametric: Record<string, unknown>
  geojson: FeatureCollection
  disambiguation: Disambiguation | null
}

export interface ApiErrorBody {
  error?: string
}

export class AnalyzeApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AnalyzeApiError'
    this.status = status
  }
}
