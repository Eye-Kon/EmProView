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
  const [errorTranscription, setErrorTranscription] = useState<string | null>(
    null,
  )
  const [result, setResult] = useState<AnalyzeResponse | null>(null)

  const handleFieldChange = (field: keyof AnalyzeRequest, value: string) => {
    setFormValues((current) => ({ ...current, [field]: value }))
  }

  const handleSubmit = async () => {
    if (!formValues.image_base64) {
      setError('Upload a procedure chart image before analyzing the path.')
      return
    }

    if (!formValues.operator_id) {
      setError('Select an operator before analyzing the path.')
      return
    }

    setLoading(true)
    setError(null)
    setErrorTranscription(null)

    try {
      const response = await analyzeProcedure(formValues)
      setResult(response)
    } catch (caught) {
      setResult(null)

      if (caught instanceof AnalyzeApiError) {
        setError(caught.message)
        setErrorTranscription(caught.transcription)
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
            <div className="error-message">
              <strong>Analysis failed.</strong>
              <span>{error}</span>
            </div>
            {errorTranscription ? (
              <div className="error-transcription">
                <span className="error-transcription-label">
                  Vision OCR transcription
                </span>
                <pre>{errorTranscription}</pre>
              </div>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="status-banner loading" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>Solving geodetic path…</span>
          </div>
        ) : null}

        {/* Phase 4.3: the unified FeatureCollection carries every runway's
            solved escape path — the map renders the full spiderweb at once. */}
        <MapCanvas geojson={result?.geojson ?? null} />

        <DataReadout
          runways={result?.runways ?? null}
          transcription={result?.transcription ?? null}
        />
      </main>
    </div>
  )
}

export default App
