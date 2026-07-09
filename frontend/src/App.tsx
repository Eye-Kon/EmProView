import { useState } from 'react'
import { analyzeProcedure } from './api/analyze'
import { ControlPanel } from './components/ControlPanel'
import { DataReadout } from './components/DataReadout'
import { MapCanvas } from './components/MapCanvas'
import { DEFAULT_ANALYZE_REQUEST } from './constants/defaults'
import {
  AnalyzeApiError,
  type AnalyzeRequest,
  type AnalyzeResponse,
} from './types/analyze'
import './App.css'

function App() {
  const [formValues, setFormValues] = useState<AnalyzeRequest>(
    DEFAULT_ANALYZE_REQUEST,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalyzeResponse | null>(null)

  const handleFieldChange = (field: keyof AnalyzeRequest, value: string) => {
    setFormValues((current) => ({ ...current, [field]: value }))
  }

  const handleSubmit = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await analyzeProcedure(formValues)
      setResult(response)
    } catch (caught) {
      setResult(null)

      if (caught instanceof AnalyzeApiError) {
        setError(caught.message)
      } else if (caught instanceof Error) {
        setError(caught.message)
      } else {
        setError('An unexpected error occurred while analyzing the procedure.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-shell">
      <ControlPanel
        values={formValues}
        loading={loading}
        onChange={handleFieldChange}
        onSubmit={handleSubmit}
      />

      <main className="workspace">
        {error ? (
          <div className="status-banner error" role="alert">
            <strong>Analysis failed.</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="status-banner loading" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>Solving geodetic path…</span>
          </div>
        ) : null}

        <MapCanvas
          geojson={result?.geojson ?? null}
          triggerPoint={result?.triggerPoint ?? null}
        />

        <DataReadout
          extraction={result?.extraction ?? null}
          triggerPoint={result?.triggerPoint ?? null}
        />
      </main>
    </div>
  )
}

export default App
