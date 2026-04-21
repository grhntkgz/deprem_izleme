import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as cheerio from 'cheerio'

const AFAD_URL = 'https://deprem.afad.gov.tr/last-earthquakes.html'

type Earthquake = {
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

function toNumber(value: string) {
  return Number(value.replace(',', '.').trim())
}

function toTimeMs(value: string) {
  const parsed = new Date(`${value.trim().replace(' ', 'T')}+03:00`).getTime()
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function extractProvince(place: string) {
  const match = place.match(/\(([^)]+)\)\s*$/)
  if (match?.[1]) {
    return match[1].trim()
  }

  return (
    place
      .split('-')
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) ?? place
  )
}

function parseEarthquakes(html: string): Earthquake[] {
  const $ = cheerio.load(html)

  return $('tbody tr')
    .map((_, row) => {
      const cells = $(row)
        .find('td')
        .map((__, cell) => $(cell).text().trim())
        .get()

      if (cells.length < 7) {
        return null
      }

      const timeMs = toTimeMs(cells[0])
      const latitude = toNumber(cells[1])
      const longitude = toNumber(cells[2])
      const depthKm = toNumber(cells[3])
      const magnitude = toNumber(cells[5])
      const place = cells[6] || 'Bilinmeyen konum'
      const detailUrl = $(row).find('a').attr('href')?.trim() ?? AFAD_URL
      const id = detailUrl.split('/').filter(Boolean).at(-1) ?? `${timeMs}-${latitude}-${longitude}`

      if (
        Number.isNaN(latitude) ||
        Number.isNaN(longitude) ||
        Number.isNaN(depthKm) ||
        Number.isNaN(magnitude)
      ) {
        return null
      }

      return {
        id,
        timeMs,
        updatedMs: timeMs,
        latitude,
        longitude,
        depthKm,
        magnitude,
        place,
        detailUrl,
        tsunami: 0,
        significance: Math.round(magnitude * 100),
      }
    })
    .get()
    .filter((earthquake): earthquake is Earthquake => earthquake !== null)
    .sort((left, right) => right.timeMs - left.timeMs)
    .slice(0, 100)
}

async function fetchEarthquakes() {
  const response = await fetch(AFAD_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0 Deprem Izleme Vercel Function',
    },
  })

  if (!response.ok) {
    throw new Error(`AFAD yaniti basarisiz: ${response.status}`)
  }

  return parseEarthquakes(await response.text())
}

function calculateStats(earthquakes: Earthquake[], referenceTimeMs = Date.now()) {
  const total = earthquakes.length
  const highestMagnitude = earthquakes.reduce((max, earthquake) => Math.max(max, earthquake.magnitude), 0)
  const averageDepth =
    earthquakes.reduce((sum, earthquake) => sum + earthquake.depthKm, 0) / Math.max(total, 1)
  const averageMagnitude =
    earthquakes.reduce((sum, earthquake) => sum + earthquake.magnitude, 0) / Math.max(total, 1)
  const shallowestDepth = earthquakes.reduce(
    (min, earthquake) => Math.min(min, earthquake.depthKm),
    Number.POSITIVE_INFINITY,
  )
  const deepestDepth = earthquakes.reduce((max, earthquake) => Math.max(max, earthquake.depthKm), 0)

  const windows = [
    { label: '1s', minutes: 60 },
    { label: '6s', minutes: 6 * 60 },
    { label: '24s', minutes: 24 * 60 },
  ].map((window) => ({
    label: window.label,
    count: earthquakes.filter(
      (earthquake) => earthquake.timeMs >= referenceTimeMs - window.minutes * 60 * 1000,
    ).length,
  }))

  const provinceMap = new Map<string, { count: number; strongestMagnitude: number }>()
  earthquakes.forEach((earthquake) => {
    const province = extractProvince(earthquake.place)
    const current = provinceMap.get(province) ?? { count: 0, strongestMagnitude: 0 }
    current.count += 1
    current.strongestMagnitude = Math.max(current.strongestMagnitude, earthquake.magnitude)
    provinceMap.set(province, current)
  })

  const topProvinces = [...provinceMap.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 5)
    .map(([name, value]) => ({
      name,
      count: value.count,
      strongestMagnitude: value.strongestMagnitude,
    }))

  const timeline = Array.from({ length: 6 }, (_, index) => {
    const endMs = referenceTimeMs - index * 4 * 60 * 60 * 1000
    const startMs = endMs - 4 * 60 * 60 * 1000
    const labelDate = new Date(startMs)

    return {
      label: `${labelDate.getHours().toString().padStart(2, '0')}:00`,
      count: earthquakes.filter(
        (earthquake) => earthquake.timeMs >= startMs && earthquake.timeMs < endMs,
      ).length,
    }
  }).reverse()

  const highlights = [...earthquakes]
    .sort((left, right) => right.magnitude - left.magnitude)
    .slice(0, 4)
    .map((earthquake) => ({
      id: earthquake.id,
      place: earthquake.place,
      magnitude: earthquake.magnitude,
      timeMs: earthquake.timeMs,
    }))

  return {
    total,
    highestMagnitude,
    averageDepth,
    averageMagnitude,
    shallowestDepth: Number.isFinite(shallowestDepth) ? shallowestDepth : 0,
    deepestDepth,
    windows,
    topProvinces,
    timeline,
    highlights,
  }
}

export default async function handler(_request: VercelRequest, response: VercelResponse) {
  try {
    const earthquakes = await fetchEarthquakes()
    const fetchedAtMs = Date.now()
    const stats = calculateStats(earthquakes, fetchedAtMs)

    return response.status(200).json({
      source: AFAD_URL,
      fetchedAtMs,
      total: earthquakes.length,
      earthquakes,
      stats,
    })
  } catch (error) {
    console.error('AFAD verisi alinamadi:', error)

    return response.status(502).json({
      message: 'AFAD deprem verisi su an alinmadi. Lutfen biraz sonra tekrar deneyin.',
      detail: error instanceof Error ? error.message : 'Bilinmeyen hata',
    })
  }
}
