import type { FeatureCollection } from 'geojson'

export interface AnalyzeRequest {
  /**
   * Base64-encoded procedure chart image (bare payload, no data-URL prefix).
   * The backend runs vision OCR on it before semantic extraction.
   *
   * Phase 4: no runwayId — the backend extracts the entire engine-failure-
   * procedure matrix (every runway on the chart) in a single pass.
   */
  image_base64: string
  extraction_target: string
  airportId: string
  navaidId: string
  /**
   * Optional tenant discriminator for tailored procedures (e.g. "AAL").
   * Trigger-navaid resolution searches that operator's proprietary dataset
   * first, then falls back to the public FAA baseline. Omitted defaults to
   * "FAA" (the public ARINC 424 baseline).
   */
  operator_id?: string
}

/** ARINC 424-style leg discriminator emitted by the Phase 4 extraction. */
export type ProcedureLegType =
  | 'TRACK_TO_DME'
  | 'TURN_TO_HEADING'
  | 'TRACK_TO_ALTITUDE'

/**
 * Audit-trail tag from the Tier-1 occupancy-grid expansion:
 * CHARTED — the value was physically printed in this runway's own table cell;
 * ROWSPAN_INHERITED — the cell was filled by expanding a vertical merge
 * (rowspan) from the row above.
 */
export type LegProvenance = 'CHARTED' | 'ROWSPAN_INHERITED'

export interface ProcedureLeg {
  type: ProcedureLegType
  /** DME distance NM, magnetic heading, or altitude ft MSL — per leg type. */
  value: number
  /** DME station / navaid ident (e.g. "TCH") when charted; null otherwise. */
  navaid: string | null
  /** Turn direction on TURN_TO_HEADING legs when charted; null otherwise. */
  direction: 'LEFT' | 'RIGHT' | null
  /** Source of this leg's data: printed on the chart vs. structurally inherited. */
  provenance: LegProvenance
}

/** One unrolled runway (grouped rows like "16L/R" arrive as separate entries). */
export interface RunwayProcedure {
  identifier: string
  legs: ProcedureLeg[]
}

export interface LatLng {
  latitude: number
  longitude: number
}

/** One solved leg in a runway's parametric record (Phase 4.3 Stage 4). */
export interface SolvedLeg {
  legType: ProcedureLegType
  provenance: LegProvenance
  startPoint: LatLng
  endPoint: LatLng
  trueHeading?: number
  dme?: {
    navaid: string
    distanceNM: number
    distanceAlongTrackNM: number
    dmeErrorNM: number
  }
  turn?: {
    direction: 'left' | 'right'
    directionSource: 'charted' | 'shortest_turn'
    sweepDegrees: number
    radiusNM: number
    radiusSource: string
    bankAngleDegrees: number
    center: LatLng
    entryTrueHeading: number
    exitTrueHeading: number
    targetMagneticHeading: number
  }
  climb?: {
    targetAltitudeFtMsl: number
    startAltitudeFtMsl: number
    distanceNM: number
    gradientFtPerNM: number
    gradientSource: string
  }
}

/** ARINC-style parametric source of truth for one runway's escape path. */
export interface RunwayParametricPath {
  runway: string
  origin: LatLng
  departureTrueHeading: number
  finalTrueHeading: number
  totalDistanceNM: number
  finalAltitudeFtMsl: number | null
  legs: SolvedLeg[]
}

/** Phase 4.3 response entry: extracted matrix row + solved geometry. */
export interface SolvedRunway extends RunwayProcedure {
  parametric: RunwayParametricPath
  disambiguation: Disambiguation | null
}

/**
 * Properties stamped on every feature of the unified escape-path
 * FeatureCollection: LineString legs (role "leg") and DME trigger
 * intersections (role "trigger_point").
 */
export interface EscapePathFeatureProperties {
  runway: string
  legIndex: number
  legType: ProcedureLegType
  provenance: LegProvenance
  role: 'leg' | 'trigger_point'
  /** Trigger points only. */
  dmeDistanceNM?: number
  navaid?: string
  /** Final turn legs only: display-only rollout extension length. */
  rolloutExtensionNM?: number
}

/**
 * Pre-Phase 4 flat extraction shape. Retained only for reference while the
 * geometry cascade is bypassed; no longer returned by /api/analyze.
 */
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

/**
 * Phase 4.3 response: the validated multi-runway matrix with the WGS-84
 * geometry cascade re-enabled per runway/leg. `geojson` is the single
 * unified FeatureCollection covering every runway's escape path — the
 * "spiderweb" the map renders in one pass.
 */
export interface AnalyzeResponse {
  runways: SolvedRunway[]
  airacCycle: AiracCycle
  geojson: FeatureCollection
  /** Stage-1 vision OCR markdown transcription, for matrix verification. */
  transcription: string
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
