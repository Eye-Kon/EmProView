import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'
import type { AnalyzeRequest } from '../types/analyze'

const OPERATOR_OPTIONS = ['FAA', 'AAL', 'UAL', 'DAL'] as const

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(',')

/** Mirrors the backend's 5 MB multer cap so oversize charts fail fast, client-side. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

interface ControlPanelProps {
  values: AnalyzeRequest
  loading: boolean
  onChange: (field: keyof AnalyzeRequest, value: string) => void
  onSubmit: () => void
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read the selected image.'))
    reader.readAsDataURL(file)
  })
}

export function ControlPanel({
  values,
  loading,
  onChange,
  onSubmit,
}: ControlPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const clearImage = () => {
    onChange('image_base64', '')
    setFileName(null)
    setPreviewUrl(null)
    setFileError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleFile = async (file: File) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setFileError('Unsupported file type. Upload a JPEG, PNG, or WEBP chart image.')
      return
    }

    if (file.size > MAX_IMAGE_BYTES) {
      setFileError('Image exceeds the 5 MB limit.')
      return
    }

    try {
      const dataUrl = await readFileAsDataUrl(file)
      // Strip the "data:image/...;base64," prefix — the API expects the bare payload.
      onChange('image_base64', dataUrl.slice(dataUrl.indexOf(',') + 1))
      setFileName(file.name)
      setPreviewUrl(dataUrl)
      setFileError(null)
    } catch {
      setFileError('Failed to read the selected image. Try a different file.')
    }
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      void handleFile(file)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    if (loading) {
      return
    }

    const file = event.dataTransfer.files?.[0]
    if (file) {
      void handleFile(file)
    }
  }

  const openFilePicker = () => {
    if (!loading) {
      fileInputRef.current?.click()
    }
  }

  const handleDropzoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openFilePicker()
    }
  }

  return (
    <aside className="control-panel">
      <header className="panel-header">
        <p className="eyebrow">EmProView</p>
        <h1>Geodetic Path Analyzer</h1>
        <p className="panel-subtitle">
          Upload a procedure chart to extract the full engine failure
          procedure matrix — every runway and its leg sequence.
        </p>
      </header>

      <form
        className="analyze-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="field">
          <span>Procedure Chart Image</span>
          <div
            className={`dropzone${dragActive ? ' drag-active' : ''}${loading ? ' disabled' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Upload procedure chart image"
            onClick={openFilePicker}
            onKeyDown={handleDropzoneKeyDown}
            onDragOver={(event) => {
              event.preventDefault()
              if (!loading) {
                setDragActive(true)
              }
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            {previewUrl ? (
              <div className="dropzone-preview">
                <img src={previewUrl} alt="Uploaded procedure chart" />
                <div className="dropzone-file-meta">
                  <span className="dropzone-file-name">{fileName}</span>
                  <button
                    type="button"
                    className="dropzone-clear"
                    disabled={loading}
                    onClick={(event) => {
                      event.stopPropagation()
                      clearImage()
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <p className="dropzone-hint">
                Drag &amp; drop a chart image here, or click to browse.
                <span>JPEG, PNG, or WEBP — 5 MB max.</span>
              </p>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            className="dropzone-input"
            onChange={handleInputChange}
            disabled={loading}
          />
          {fileError ? (
            <p className="field-error" role="alert">
              {fileError}
            </p>
          ) : null}
        </div>

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

        <label className="field">
          <span>Operator</span>
          <select
            value={values.operator_id ?? ''}
            onChange={(event) => onChange('operator_id', event.target.value)}
            disabled={loading}
            required
          >
            <option value="" disabled>
              Select Operator
            </option>
            {OPERATOR_OPTIONS.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
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
            <span>Navaid ID</span>
            <input
              type="text"
              value={values.navaidId}
              onChange={(event) => onChange('navaidId', event.target.value)}
              disabled={loading}
            />
          </label>
        </div>

        <button
          type="submit"
          className="submit-button"
          disabled={loading || !values.operator_id || !values.image_base64}
        >
          {loading ? 'Analyzing Path…' : 'Analyze Path'}
        </button>
      </form>
    </aside>
  )
}
