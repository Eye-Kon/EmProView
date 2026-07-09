import type { AnalyzeRequest } from '../types/analyze'

interface ControlPanelProps {
  values: AnalyzeRequest
  loading: boolean
  onChange: (field: keyof AnalyzeRequest, value: string) => void
  onSubmit: () => void
}

export function ControlPanel({
  values,
  loading,
  onChange,
  onSubmit,
}: ControlPanelProps) {
  return (
    <aside className="control-panel">
      <header className="panel-header">
        <p className="eyebrow">EmProView</p>
        <h1>Geodetic Path Analyzer</h1>
        <p className="panel-subtitle">
          Submit procedural text and physical identifiers to solve the trigger
          point and render the computed flight path.
        </p>
      </header>

      <form
        className="analyze-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <label className="field">
          <span>Procedure Text</span>
          <textarea
            rows={5}
            value={values.procedure_text}
            onChange={(event) => onChange('procedure_text', event.target.value)}
            disabled={loading}
          />
        </label>

        <label className="field">
          <span>Extraction Target</span>
          <textarea
            rows={3}
            value={values.extraction_target}
            onChange={(event) =>
              onChange('extraction_target', event.target.value)
            }
            disabled={loading}
          />
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Airport ID</span>
            <input
              type="text"
              value={values.airportId}
              onChange={(event) => onChange('airportId', event.target.value)}
              disabled={loading}
            />
          </label>

          <label className="field">
            <span>Runway ID</span>
            <input
              type="text"
              value={values.runwayId}
              onChange={(event) => onChange('runwayId', event.target.value)}
              disabled={loading}
            />
          </label>

          <label className="field">
            <span>Navaid ID</span>
            <input
              type="text"
              value={values.navaidId}
              onChange={(event) => onChange('navaidId', event.target.value)}
              disabled={loading}
            />
          </label>
        </div>

        <button type="submit" className="submit-button" disabled={loading}>
          {loading ? 'Analyzing Path…' : 'Analyze Path'}
        </button>
      </form>
    </aside>
  )
}
