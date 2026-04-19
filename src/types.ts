export type Earthquake = {
  id: string
  timeMs: number
  updatedMs: number
  latitude: number
  longitude: number
  depthKm: number
  magnitude: number
  place: string
  detailUrl: string
  tsunami: number
  significance: number
}

export type EarthquakeResponse = {
  source: string
  fetchedAtMs: number
  total: number
  earthquakes: Earthquake[]
}
