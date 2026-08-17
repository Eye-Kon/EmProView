import type { ProcedureLeg, RunwayProcedure } from '../types/analyze'

interface DataReadoutProps {
  runways: RunwayProcedure[] | null
  /** Stage-1 vision OCR markdown, for verifying the extraction against the chart. */
  transcription: string | null
}

function describeLeg(leg: ProcedureLeg): string {
  switch (leg.type) {
    case 'TRACK_TO_DME':
      return `Track to ${leg.value} DME${leg.navaid ? ` ${leg.navaid}` : ''}`
    case 'TURN_TO_HEADING':
      return `${leg.direction ? `${leg.direction} turn` : 'Turn'} to heading ${leg.value}°`
    case 'TRACK_TO_ALTITUDE':
      return `Climb to ${leg.value} ft MSL`
  }
}

export function DataReadout({ runways, transcription }: DataReadoutProps) {
  return (
    <section className="data-readout">
      <header>
        <h2>Procedure Matrix</h2>
        <p>Verify the extracted multi-runway leg sequences against the chart.</p>
      </header>

      <div className="readout-grid">
        <article className="readout-card">
          <h3>Extracted Runways</h3>
          {runways && runways.length > 0 ? (
            <dl className="metric-list">
              {runways.map((runway) => (
                <div key={runway.identifier}>
                  <dt>Runway {runway.identifier}</dt>
                  <dd>
                    <ol className="leg-list">
                      {runway.legs.map((leg, index) => (
                        <li
                          key={index}
                          className={
                            leg.provenance === 'ROWSPAN_INHERITED'
                              ? 'leg-inherited'
                              : undefined
                          }
                        >
                          <code>{leg.type}</code> — {describeLeg(leg)}
                          <span
                            className={`leg-badge ${
                              leg.provenance === 'ROWSPAN_INHERITED'
                                ? 'inherited'
                                : 'charted'
                            }`}
                            title={
                              leg.provenance === 'ROWSPAN_INHERITED'
                                ? 'Filled by expanding a vertical cell merge (rowspan) from the row above — verify against the chart.'
                                : 'Printed directly in this runway’s own table cell.'
                            }
                          >
                            {leg.provenance === 'ROWSPAN_INHERITED'
                              ? 'INHERITED'
                              : 'CHARTED'}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="placeholder">
              Run an analysis to populate the extracted procedure matrix.
            </p>
          )}
        </article>

        <article className="readout-card">
          <h3>Raw Extraction JSON</h3>
          {runways ? (
            <pre>{JSON.stringify(runways, null, 2)}</pre>
          ) : (
            <p className="placeholder">
              The validated JSON array will appear after a successful extraction.
            </p>
          )}
        </article>

        <article className="readout-card">
          <h3>Vision OCR Transcription</h3>
          {transcription ? (
            <pre>{transcription}</pre>
          ) : (
            <p className="placeholder">
              The Stage-1 markdown table transcription will appear here.
            </p>
          )}
        </article>
      </div>
    </section>
  )
}
