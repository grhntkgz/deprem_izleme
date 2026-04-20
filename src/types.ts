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

export type EarthquakeWindowStat = {
  label: string
  count: number
}

export type EarthquakeProvinceStat = {
  name: string
  count: number
  strongestMagnitude: number
}

export type EarthquakeTimelineStat = {
  label: string
  count: number
}

export type EarthquakeHighlightStat = {
  id: string
  place: string
  magnitude: number
  timeMs: number
}

export type EarthquakeStats = {
  total: number
  highestMagnitude: number
  averageDepth: number
  averageMagnitude: number
  shallowestDepth: number
  deepestDepth: number
  windows: EarthquakeWindowStat[]
  topProvinces: EarthquakeProvinceStat[]
  timeline: EarthquakeTimelineStat[]
  highlights: EarthquakeHighlightStat[]
}

export type EarthquakeResponse = {
  source: string
  fetchedAtMs: number
  total: number
  earthquakes: Earthquake[]
  stats: EarthquakeStats
}
