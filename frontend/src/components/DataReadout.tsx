import type { ExtractionResult, TriggerPoint } from '../types/analyze'

interface DataReadoutProps {
  extraction: ExtractionResult | null
  triggerPoint: TriggerPoint | null
}

export function DataReadout({ extraction, triggerPoint }: DataReadoutProps) {
  return (
    <section className="data-readout">
      <header>
        <h2>Geodetic Readout</h2>
        <p>Verify LLM extraction against computed trigger geometry.</p>
      </header>

      <div className="readout-grid">
        <article className="readout-card">
          <h3>Extraction</h3>
          {extraction ? (
            <pre>{JSON.stringify(extraction, null, 2)}</pre>
          ) : (
            <p className="placeholder">Run an analysis to populate extraction data.</p>
          )}
        </article>

        <article className="readout-card">
          <h3>Trigger Point</h3>
          {triggerPoint ? (
            <dl className="metric-list">
              <div>
                <dt>Distance Along Track</dt>
                <dd>{triggerPoint.distanceAlongTrackNM.toFixed(3)} NM</dd>
              </div>
              <div>
                <dt>DME Error</dt>
                <dd>{triggerPoint.dmeErrorNM.toFixed(4)} NM</dd>
              </div>
              <div>
                <dt>Latitude</dt>
                <dd>{triggerPoint.latitude.toFixed(6)}</dd>
              </div>
              <div>
                <dt>Longitude</dt>
                <dd>{triggerPoint.longitude.toFixed(6)}</dd>
              </div>
            </dl>
          ) : (
            <p className="placeholder">Trigger metrics will appear after a successful solve.</p>
          )}
        </article>
      </div>
    </section>
  )
}
