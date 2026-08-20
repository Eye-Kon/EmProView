export interface CompileCycleRequest {
  operator_id: string
  airac_cycle: string
}

export interface CycleCompileSummary {
  total_attempted: number
  total_succeeded: number
  total_failed: number
}

export interface RejectionManifestEntry {
  operator_id: string
  airport_icao: string
  procedure_ident: string
  route_type?: string
  transition?: string
  reason: string
}

export interface CompileCycleResponse {
  operator_id: string
  airac_cycle: string
  summary: CycleCompileSummary
  rejection_manifest: RejectionManifestEntry[]
  arinc424_payload: string
}

export class CompileCycleApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CompileCycleApiError'
    this.status = status
  }
}
