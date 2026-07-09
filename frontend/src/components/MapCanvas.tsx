import { useMemo } from 'react'
import type { FeatureCollection } from 'geojson'
import L from 'leaflet'
import { GeoJSON, MapContainer, TileLayer } from 'react-leaflet'
import type { CircleMarkerOptions, PathOptions } from 'leaflet'
import type { TriggerPoint } from '../types/analyze'

const TRACK_STYLE: PathOptions = {
  color: '#3b82f6',
  weight: 6,
  opacity: 0.55,
  lineCap: 'round',
  lineJoin: 'round',
}

const TRIGGER_STYLE: CircleMarkerOptions = {
  color: '#ef4444',
  weight: 3,
  fillColor: '#ef4444',
  fillOpacity: 0.9,
  radius: 8,
}

const DEFAULT_CENTER: [number, number] = [35.214, -80.943]

interface MapCanvasProps {
  geojson: FeatureCollection | null
  triggerPoint: TriggerPoint | null
}

export function MapCanvas({ geojson, triggerPoint }: MapCanvasProps) {
  const center = useMemo<[number, number]>(() => {
    if (triggerPoint) {
      return [triggerPoint.latitude, triggerPoint.longitude]
    }
    return DEFAULT_CENTER
  }, [triggerPoint])

  const mapKey = triggerPoint
    ? `${triggerPoint.latitude.toFixed(5)}-${triggerPoint.longitude.toFixed(5)}`
    : 'default'

  return (
    <section className="map-canvas">
      <MapContainer
        key={mapKey}
        center={center}
        zoom={11}
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
              if (feature?.geometry.type === 'LineString') {
                return TRACK_STYLE
              }
              return {}
            }}
            pointToLayer={(_feature, latlng) => L.circleMarker(latlng, TRIGGER_STYLE)}
          />
        ) : null}
      </MapContainer>

      {!geojson ? (
        <div className="map-empty-state">
          <p>Submit the baseline procedure to render the projected flight path.</p>
        </div>
      ) : null}
    </section>
  )
}
