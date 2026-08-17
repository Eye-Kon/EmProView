import { useMemo } from 'react'
import type { FeatureCollection } from 'geojson'
import L from 'leaflet'
import { GeoJSON, MapContainer, TileLayer } from 'react-leaflet'
import type { PathOptions } from 'leaflet'
import type { EscapePathFeatureProperties } from '../types/analyze'

/**
 * Distinct track colors assigned to runways in first-appearance order, so
 * the full multi-runway "spiderweb" stays readable when every escape path
 * renders simultaneously.
 */
const RUNWAY_PALETTE = [
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#10b981', // emerald
  '#a855f7', // purple
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
]

const DEFAULT_CENTER: [number, number] = [35.214, -80.943]

/** Leg-type styling: climb legs thinner, turns full weight, DME legs bold. */
const LEG_TYPE_STYLE: Record<string, Partial<PathOptions>> = {
  TRACK_TO_DME: { weight: 5 },
  TURN_TO_HEADING: { weight: 4 },
  TRACK_TO_ALTITUDE: { weight: 3 },
}

interface MapCanvasProps {
  geojson: FeatureCollection | null
}

export function MapCanvas({ geojson }: MapCanvasProps) {
  // Stable color per runway, in first-appearance order across the collection.
  const runwayColors = useMemo(() => {
    const colors = new Map<string, string>()
    if (!geojson) return colors

    for (const feature of geojson.features) {
      const runway = (feature.properties as EscapePathFeatureProperties | null)
        ?.runway
      if (runway && !colors.has(runway)) {
        colors.set(runway, RUNWAY_PALETTE[colors.size % RUNWAY_PALETTE.length])
      }
    }
    return colors
  }, [geojson])

  // Fit the whole spiderweb: bounds over every feature of every runway.
  const bounds = useMemo(() => {
    if (!geojson || geojson.features.length === 0) return null
    const computed = L.geoJSON(geojson).getBounds()
    return computed.isValid() ? computed.pad(0.15) : null
  }, [geojson])

  // MapContainer view props are immutable after mount; remount when a new
  // collection arrives so the viewport re-fits the new set of paths.
  const mapKey = bounds
    ? `${bounds.getSouthWest().toString()}|${bounds.getNorthEast().toString()}|${geojson?.features.length}`
    : 'default'

  return (
    <section className="map-canvas">
      <MapContainer
        key={mapKey}
        {...(bounds
          ? { bounds }
          : { center: DEFAULT_CENTER, zoom: 11 })}
        scrollWheelZoom
        className="leaflet-map"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {geojson ? (
          <GeoJSON
            data={geojson}
            style={(feature) => {
              const props = feature?.properties as
                | EscapePathFeatureProperties
                | undefined
              if (feature?.geometry.type !== 'LineString' || !props) {
                return {}
              }

              return {
                color: runwayColors.get(props.runway) ?? RUNWAY_PALETTE[0],
                opacity: 0.8,
                lineCap: 'round',
                lineJoin: 'round',
                // Provenance styles the stroke only — the underlying vector
                // math is identical for inherited and charted legs.
                dashArray:
                  props.provenance === 'ROWSPAN_INHERITED' ? '8 8' : undefined,
                ...(LEG_TYPE_STYLE[props.legType] ?? { weight: 4 }),
              }
            }}
            pointToLayer={(feature, latlng) => {
              const props = feature.properties as EscapePathFeatureProperties
              const color = runwayColors.get(props.runway) ?? '#ef4444'
              return L.circleMarker(latlng, {
                color,
                weight: 2,
                fillColor: color,
                fillOpacity: 0.9,
                radius: 6,
              })
            }}
            onEachFeature={(feature, layer) => {
              const props = feature.properties as
                | EscapePathFeatureProperties
                | undefined
              if (!props) return

              const label =
                props.role === 'trigger_point'
                  ? `RWY ${props.runway} — trigger: ${props.dmeDistanceNM} DME ${props.navaid ?? ''}`
                  : `RWY ${props.runway} — ${props.legType} (${props.provenance})`
              layer.bindTooltip(label, { sticky: true })
            }}
          />
        ) : null}
      </MapContainer>

      {geojson && runwayColors.size > 0 ? (
        <div className="map-legend">
          {[...runwayColors.entries()].map(([runway, color]) => (
            <span key={runway} className="map-legend-item">
              <span
                className="map-legend-swatch"
                style={{ backgroundColor: color }}
              />
              RWY {runway}
            </span>
          ))}
        </div>
      ) : null}

      {!geojson ? (
        <div className="map-empty-state">
          <p>
            Analyze a chart to render the escape paths for every extracted
            runway.
          </p>
        </div>
      ) : null}
    </section>
  )
}
