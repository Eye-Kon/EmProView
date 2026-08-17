import type { FeatureCollection } from 'geojson'

export interface AnalyzeRequest {
  /**
   * Base64-encoded procedure chart image (bare payload, no data-URL prefix).
   * The backend runs vision OCR on it before semantic extraction.
   */
  image_base64: string
  extraction_target: string
  airportId: string
  runwayId: string
  navaidId: string
  /**
   * Optional tenant discriminator for tailored procedures (e.g. "AAL").
   * Trigger-navaid resolution searches that operator's proprietary dataset
   * first, then falls back to the public FAA baseline. Omitted defaults to
   * "FAA" (the public ARINC 424 baseline).
   */
  operator_id?: string
}

export interface ExtractionResult {
  extracted_value: string
  turn_direction: 'LEFT' | 'RIGHT' | 'NONE'
  /** Initial climb / runway magnetic heading when stated. */
  initial_magnetic_heading?: number | null
  /** Flat trigger discriminator — the trigger fields below are independent, never conditional. */
  trigger_type: 'altitude' | 'dme' | 'unspecified'
  /** Resolved lateral trigger distance (charted DME, or derived from altitude). */
  trigger_distance_nm: number
  /** Charted DME distance in NM when trigger_type is 'dme'; null otherwise. */
  trigger_dme_distance_nm: number | null
  /** Ident of the DME station the distance is measured from, when charted. */
  trigger_navaid_ident: string | null
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

/** Resolved station the charted DME distance is measured from. */
export interface TriggerNavaid {
  identifier: string
  name: string | null
  type: string | null
  state: string | null
  /** Tenant that resolved the station ("FAA" public, or e.g. "AAL" tailored). */
  operator_id: string
  coordinates: {
    latitude: number
    longitude: number
  }
  elevationFtMsl: number
  magneticVariation: number
  selection: {
    tier: 'terminal' | 'enroute_40nm'
    distanceNM: number
    candidateCount: number
    /** Operator whose dataset the station came from. */
    operator: string
    /** Whether the tailored dataset or the public FAA fallback resolved it. */
    dataset: 'tailored' | 'public'
    note: string
  }
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
  /** Present when the LLM extracted a trigger_navaid_ident; null otherwise. */
  triggerNavaid: TriggerNavaid | null
  triggerPoint: TriggerPoint
  parametric: Record<string, unknown>
  geojson: FeatureCollection
  disambiguation: Disambiguation | null
}

export interface ApiErrorBody {
  error?: string
  /** Stage-1 vision OCR transcription, echoed back on 422 rejections. */
  transcription?: string
}

export class AnalyzeApiError extends Error {
  readonly status: number
  /** Raw vision OCR text when the backend included it in the error body. */
  readonly transcription: string | null

  constructor(status: number, message: string, transcription: string | null = null) {
    super(message)
    this.name = 'AnalyzeApiError'
    this.status = status
    this.transcription = transcription
  }
}
