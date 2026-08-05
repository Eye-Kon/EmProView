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
  /** Initial climb / runway magnetic heading when stated. */
  initial_magnetic_heading?: number | null
  /** Resolved lateral trigger distance (charted DME, or derived from altitude). */
  trigger_distance_nm: number
  /** Altitude trigger in feet MSL when no lateral distance was charted. */
  trigger_altitude_msl?: number | null
  /** Climb gradient ft/NM when stated; engine defaults to 400 if omitted. */
  climb_gradient_ft_nm?: number | null
  /** Post-turn magnetic heading when charted; null for turn-direct-to-fix. */
  target_magnetic_heading: number | null
  /** Navaid/fix ident for turn-direct procedures (e.g. CLT). */
  target_navaid?: string | null
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
