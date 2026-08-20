import { useState } from 'react'
import type { FormEvent } from 'react'
import { compileCycle } from '../api/compileCycle'
import {
  CompileCycleApiError,
  type CompileCycleResponse,
} from '../types/compileCycle'

const AIRAC_CYCLE_PATTERN = /^\d{4}$/
const OPERATOR_SUGGESTIONS = ['AAL', 'UAL', 'DAL', 'FAA'] as const

type Banner =
  | { kind: 'error'; message: string }
  | { kind: 'warning'; message: string }
  | { kind: 'success'; message: string }

function normalizeOperatorId(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

function normalizeAiracCycle(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4)
}

function payloadIsEmpty(payload: unknown): boolean {
  return typeof payload !== 'string' || payload.trim() === ''
}

function downloadArinc424Blob(
  payload: string,
  operatorId: string,
  airacCycle: string,
): string {
  const fileName = `${operatorId}_${airacCycle}_Master.424`
  const blob = new Blob([payload], { type: 'text/plain' })
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = objectUrl
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)

  return fileName
}

export function CycleExportPanel() {
  const [operatorId, setOperatorId] = useState('')
  const [airacCycle, setAiracCycle] = useState('')
  const [loading, setLoading] = useState(false)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [result, setResult] = useState<CompileCycleResponse | null>(null)

  const canSubmit =
    operatorId.length > 0 && AIRAC_CYCLE_PATTERN.test(airacCycle) && !loading

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const operator_id = normalizeOperatorId(operatorId)
    const airac_cycle = normalizeAiracCycle(airacCycle)

    if (!operator_id) {
      setBanner({ kind: 'error', message: 'Enter an operator ID (e.g. AAL).' })
      return
    }

    if (!AIRAC_CYCLE_PATTERN.test(airac_cycle)) {
      setBanner({
        kind: 'error',
        message: 'AIRAC cycle must be exactly 4 digits (e.g. 2608).',
      })
      return
    }

    setLoading(true)
    setBanner(null)
    setResult(null)

    try {
      const pack = await compileCycle({ operator_id, airac_cycle })
      setResult(pack)

      if (payloadIsEmpty(pack.arinc424_payload)) {
        setBanner({
          kind: 'warning',
          message: 'No active procedures found for this operator/cycle',
        })
        return
      }

      const fileName = downloadArinc424Blob(
        pack.arinc424_payload,
        operator_id,
        airac_cycle,
      )
      setBanner({
        kind: 'success',
        message: `Downloaded ${fileName}`,
      })
    } catch (caught) {
      setResult(null)

      if (caught instanceof CompileCycleApiError) {
        setBanner({ kind: 'error', message: caught.message })
      } else if (caught instanceof Error) {
        setBanner({ kind: 'error', message: caught.message })
      } else {
        setBanner({
          kind: 'error',
          message: 'An unexpected error occurred while compiling the cycle.',
        })
      }
    } finally {
      setLoading(false)
    }
  }

  const rejections = result?.rejection_manifest ?? []
  const summary = result?.summary

  return (
    <section className="cycle-export-panel">
      <header className="cycle-export-header">
        <p className="eyebrow">Monthly Release</p>
        <h2>ARINC 424 Cycle Export</h2>
        <p>
          Compile every active procedure lock for an operator into a single
          132-character ARINC 424 pack, then download the master file.
        </p>
      </header>

      <form className="cycle-export-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Operator ID</span>
          <input
            type="text"
            name="operator_id"
            value={operatorId}
            onChange={(event) =>
              setOperatorId(normalizeOperatorId(event.target.value))
            }
            placeholder="AAL"
            autoComplete="off"
            spellCheck={false}
            maxLength={8}
            list="cycle-operator-suggestions"
            disabled={loading}
            required
            aria-label="Operator ID"
          />
          <datalist id="cycle-operator-suggestions">
            {OPERATOR_SUGGESTIONS.map((operator) => (
              <option key={operator} value={operator} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>AIRAC Cycle</span>
          <input
            type="text"
            name="airac_cycle"
            value={airacCycle}
            onChange={(event) =>
              setAiracCycle(normalizeAiracCycle(event.target.value))
            }
            placeholder="2608"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            autoComplete="off"
            spellCheck={false}
            disabled={loading}
            required
            aria-label="AIRAC Cycle"
          />
        </label>

        <button
          type="submit"
          className="submit-button cycle-export-submit"
          disabled={!canSubmit}
        >
          {loading ? 'Compiling Cycle…' : 'Compile & Download Cycle'}
        </button>
      </form>

      {loading ? (
        <div className="status-banner loading" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Compiling operator cycle pack…</span>
        </div>
      ) : null}

      {banner ? (
        <div
          className={`status-banner ${banner.kind}`}
          role={banner.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {banner.kind === 'error' ? (
            <div className="error-message">
              <strong>Cycle compile failed.</strong>
              <span>{banner.message}</span>
            </div>
          ) : (
            <span>{banner.message}</span>
          )}
        </div>
      ) : null}

      {summary ? (
        <div className="cycle-export-dashboard">
          <div className="cycle-export-metrics" aria-label="Compile summary">
            <article className="cycle-metric-card">
              <span className="cycle-metric-label">Total Attempted</span>
              <strong className="cycle-metric-value">
                {summary.total_attempted}
              </strong>
            </article>
            <article className="cycle-metric-card succeeded">
              <span className="cycle-metric-label">Succeeded</span>
              <strong className="cycle-metric-value">
                {summary.total_succeeded}
              </strong>
            </article>
            <article className="cycle-metric-card failed">
              <span className="cycle-metric-label">Failed</span>
              <strong className="cycle-metric-value">
                {summary.total_failed}
              </strong>
            </article>
          </div>

          {rejections.length > 0 ? (
            <div className="quarantine-panel">
              <header>
                <h3>Quarantined Procedures</h3>
                <p>
                  These extractions were dropped from the compiled file and
                  must be reviewed before the next AIRAC cutover.
                </p>
              </header>
              <div className="quarantine-table-wrap">
                <table className="quarantine-table">
                  <caption className="visually-hidden">
                    Procedures excluded from the compiled ARINC 424 file
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Airport ICAO</th>
                      <th scope="col">Procedure Ident</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rejections.map((entry, index) => (
                      <tr
                        key={`${entry.airport_icao}-${entry.procedure_ident}-${entry.route_type ?? ''}-${entry.transition ?? ''}-${index}`}
                      >
                        <td>{entry.airport_icao || '—'}</td>
                        <td>
                          <code>{entry.procedure_ident || '—'}</code>
                        </td>
                        <td>{entry.reason || 'No reason provided.'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
