import * as cheerio from 'cheerio'

const AFAD_URL = 'https://deprem.afad.gov.tr/last-earthquakes.html'

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

export type EarthquakeStats = {
  total: number
  highestMagnitude: number
  averageDepth: number
  averageMagnitude: number
  shallowestDepth: number
  deepestDepth: number
  windows: Array<{ label: string; count: number }>
  topProvinces: Array<{ name: string; count: number; strongestMagnitude: number }>
  timeline: Array<{ label: string; count: number }>
  highlights: Array<{ id: string; place: string; magnitude: number; timeMs: number }>
}

type ChatContext = {
  selectedEarthquakeId?: string
}

export function getAfadUrl() {
  return AFAD_URL
}

function toNumber(value: string) {
  return Number(value.replace(',', '.').trim())
}

function toTimeMs(value: string) {
  const parsed = new Date(`${value.trim().replace(' ', 'T')}+03:00`).getTime()
  return Number.isNaN(parsed) ? Date.now() : parsed
}

export function parseEarthquakes(html: string): Earthquake[] {
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

export async function fetchEarthquakes() {
  const response = await fetch(AFAD_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0 Codex AFAD Earthquake Map',
    },
  })

  if (!response.ok) {
    throw new Error(`AFAD yaniti basarisiz: ${response.status}`)
  }

  const html = await response.text()
  return parseEarthquakes(html)
}

function normalizeText(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['".,!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatTime(timeMs: number) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timeMs))
}

function formatMagnitude(value: number) {
  return value.toFixed(1)
}

export function extractProvince(place: string) {
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

function distanceKm(left: Earthquake, right: Earthquake) {
  const earthRadiusKm = 6371
  const dLat = ((right.latitude - left.latitude) * Math.PI) / 180
  const dLon = ((right.longitude - left.longitude) * Math.PI) / 180
  const lat1 = (left.latitude * Math.PI) / 180
  const lat2 = (right.latitude * Math.PI) / 180

  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine))
}

export function calculateEarthquakeStats(
  earthquakes: Earthquake[],
  referenceTimeMs = Date.now(),
): EarthquakeStats {
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
  const deepestDepth = earthquakes.reduce(
    (max, earthquake) => Math.max(max, earthquake.depthKm),
    0,
  )

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
    const label = `${labelDate.getHours().toString().padStart(2, '0')}:00`

    return {
      label,
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

function getPlaceCandidates(earthquakes: Earthquake[]) {
  const places = new Set<string>()

  earthquakes.forEach((earthquake) => {
    places.add(earthquake.place)

    const parenthesized = [...earthquake.place.matchAll(/\(([^)]+)\)/g)]
    parenthesized.forEach((match) => {
      if (match[1]) {
        places.add(match[1])
      }
    })

    earthquake.place
      .split('-')
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => places.add(part))
  })

  return [...places]
}

function extractPlaceFilter(message: string, earthquakes: Earthquake[]) {
  const normalizedMessage = normalizeText(message)
  const candidates = getPlaceCandidates(earthquakes)
    .map((place) => ({
      raw: place,
      normalized: normalizeText(place),
    }))
    .filter((candidate) => candidate.normalized.length >= 3)
    .sort((left, right) => right.normalized.length - left.normalized.length)

  return candidates.find((candidate) => normalizedMessage.includes(candidate.normalized)) ?? null
}

function getWindowMinutes(message: string) {
  const lowered = normalizeText(message)
  const minuteMatch = lowered.match(/(\d+)\s*dakika/)
  if (minuteMatch) return Number(minuteMatch[1])

  const hourMatch = lowered.match(/(\d+)\s*saat/)
  if (hourMatch) return Number(hourMatch[1]) * 60

  if (lowered.includes('bugun')) return 24 * 60
  if (lowered.includes('dun')) return 48 * 60
  if (lowered.includes('son saat')) return 60
  if (lowered.includes('son yarim saat')) return 30
  return null
}

function getScopeText({
  placeLabel,
  windowMinutes,
}: {
  placeLabel?: string
  windowMinutes: number | null
}) {
  const parts: string[] = []

  if (placeLabel) {
    parts.push(`${placeLabel} icin`)
  }

  if (windowMinutes !== null) {
    if (windowMinutes < 60) {
      parts.push(`son ${windowMinutes} dakikada`)
    } else {
      const hours = Math.max(1, Math.round(windowMinutes / 60))
      parts.push(`son ${hours} saatte`)
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'AFAD son 100 listesinde'
}

function getNearbyEvents(base: Earthquake, earthquakes: Earthquake[], radiusKm = 80) {
  return earthquakes.filter((earthquake) => {
    if (earthquake.id === base.id) return false
    return distanceKm(base, earthquake) <= radiusKm
  })
}

function getProvinceStats(earthquakes: Earthquake[]) {
  const grouped = new Map<string, { count: number; strongestMagnitude: number }>()

  earthquakes.forEach((earthquake) => {
    const province = extractProvince(earthquake.place)
    const current = grouped.get(province) ?? { count: 0, strongestMagnitude: 0 }
    current.count += 1
    current.strongestMagnitude = Math.max(current.strongestMagnitude, earthquake.magnitude)
    grouped.set(province, current)
  })

  return [...grouped.entries()].sort((left, right) => right[1].count - left[1].count)
}

function getClusterSummary(earthquakes: Earthquake[]): { base: Earthquake; count: number } | null {
  if (earthquakes.length < 2) return null

  let bestBase: Earthquake | null = null
  let bestCount = 0

  earthquakes.forEach((earthquake) => {
    const nearbyCount = earthquakes.filter((candidate) => {
      if (candidate.id === earthquake.id) return false
      return distanceKm(earthquake, candidate) <= 75
    }).length

    if (nearbyCount > bestCount) {
      bestCount = nearbyCount
      bestBase = earthquake
    }
  })

  if (!bestBase || bestCount < 2) {
    return null
  }

  return {
    base: bestBase,
    count: bestCount + 1,
  }
}

export function answerChat(message: string, earthquakes: Earthquake[], context: ChatContext = {}) {
  const lowered = normalizeText(message)
  const now = Date.now()
  const windowMinutes = getWindowMinutes(message)
  const placeFilter = extractPlaceFilter(message, earthquakes)
  const countMatch = lowered.match(/(?:ilk|son|top)\s*(\d+)/)
  const requestedCount = countMatch ? Number(countMatch[1]) : null
  const selectedEarthquake = earthquakes.find(
    (earthquake) => earthquake.id === context.selectedEarthquakeId,
  )
  const referencesSelected =
    Boolean(selectedEarthquake) &&
    ['bu deprem', 'secili deprem', 'bunun', 'buna', 'bu olay', 'secili olay'].some((token) =>
      lowered.includes(token),
    )

  let scopedEarthquakes =
    windowMinutes === null
      ? earthquakes
      : earthquakes.filter((earthquake) => earthquake.timeMs >= now - windowMinutes * 60 * 1000)

  if (placeFilter) {
    scopedEarthquakes = scopedEarthquakes.filter((earthquake) =>
      normalizeText(earthquake.place).includes(placeFilter.normalized),
    )
  }

  if (scopedEarthquakes.length === 0) {
    if (placeFilter) {
      return `${getScopeText({ placeLabel: placeFilter.raw, windowMinutes })} AFAD verisinde eslesen deprem bulamadim.`
    }

    return 'Bu zaman araliginda AFAD verisinde eslesen deprem bulamadim.'
  }

  const latest = scopedEarthquakes[0]
  const strongest = [...scopedEarthquakes].sort((left, right) => right.magnitude - left.magnitude)[0]
  const shallowest = [...scopedEarthquakes].sort((left, right) => left.depthKm - right.depthKm)[0]
  const deepest = [...scopedEarthquakes].sort((left, right) => right.depthKm - left.depthKm)[0]
  const averageDepth =
    scopedEarthquakes.reduce((sum, earthquake) => sum + earthquake.depthKm, 0) /
    scopedEarthquakes.length
  const averageMagnitude =
    scopedEarthquakes.reduce((sum, earthquake) => sum + earthquake.magnitude, 0) /
    scopedEarthquakes.length
  const scopeText = getScopeText({
    placeLabel: placeFilter?.raw,
    windowMinutes,
  })
  const provinceStats = getProvinceStats(scopedEarthquakes)
  const [topProvince, topProvinceStats] =
    provinceStats[0] ?? ['Bilinmiyor', { count: 0, strongestMagnitude: 0 }]
  const clusterSummary = getClusterSummary(scopedEarthquakes)
  const selectedOrLatest = referencesSelected && selectedEarthquake ? selectedEarthquake : latest

  if (
    referencesSelected &&
    selectedEarthquake &&
    (lowered.includes('yak') ||
      lowered.includes('cevre') ||
      lowered.includes('etraf') ||
      lowered.includes('artci'))
  ) {
    const nearbyEvents = getNearbyEvents(selectedEarthquake, scopedEarthquakes, 90).slice(0, 6)

    if (nearbyEvents.length === 0) {
      return `Secili olay ${selectedEarthquake.place} icin 90 km capinda ek bir yogunluk goremedim. Olay buyuklugu ${formatMagnitude(selectedEarthquake.magnitude)}, derinligi ${selectedEarthquake.depthKm.toFixed(1)} km ve zamani ${formatTime(selectedEarthquake.timeMs)}.`
    }

    const strongestNearby = [...nearbyEvents].sort((left, right) => right.magnitude - left.magnitude)[0]
    return `Secili olay ${selectedEarthquake.place} cevresinde 90 km icinde ${nearbyEvents.length} ek deprem gorunuyor. En guclu yakin olay ${strongestNearby.place} konumunda M ${formatMagnitude(strongestNearby.magnitude)}. Bu gorunum yerel bir hareketlilige isaret ediyor olabilir; ancak AFAD listesi tek basina resmi risk yorumu yerine gecmez.`
  }

  if (lowered.includes('liste') || lowered.includes('goster')) {
    const limit = Math.min(Math.max(requestedCount ?? 5, 1), 10)
    const listed = scopedEarthquakes
      .slice(0, limit)
      .map(
        (earthquake, index) =>
          `${index + 1}. ${earthquake.place} | M ${formatMagnitude(earthquake.magnitude)} | ${earthquake.depthKm.toFixed(1)} km | ${formatTime(earthquake.timeMs)}`,
      )
      .join('\n')

    return `${scopeText} ilk ${limit} deprem:\n${listed}`
  }

  if (lowered.includes('en buyuk') || lowered.includes('en guclu')) {
    return `${scopeText} en buyuk deprem ${strongest.place} bolgesinde oldu. Buyukluk ${formatMagnitude(strongest.magnitude)}, derinlik ${strongest.depthKm.toFixed(1)} km, zaman ${formatTime(strongest.timeMs)}.`
  }

  if (lowered.includes('son deprem') || lowered.includes('en son')) {
    return `En son deprem ${latest.place} konumunda kaydedildi. Buyukluk ${formatMagnitude(latest.magnitude)}, derinlik ${latest.depthKm.toFixed(1)} km, zaman ${formatTime(latest.timeMs)}. ${topProvince} su anda en yogun gorunen il.`
  }

  if (lowered.includes('kac deprem')) {
    return `${scopeText} toplam ${scopedEarthquakes.length} deprem var. Bu veri setindeki en buyuk olay ${formatMagnitude(strongest.magnitude)} buyuklugunde.`
  }

  if (lowered.includes('ortalama') || lowered.includes('derinlik')) {
    return `${scopeText} ortalama derinlik ${averageDepth.toFixed(1)} km. Ortalama buyukluk ${averageMagnitude.toFixed(1)}. En sig olay ${shallowest.place} (${shallowest.depthKm.toFixed(1)} km), en derin olay ise ${deepest.place} (${deepest.depthKm.toFixed(1)} km).`
  }

  if (lowered.includes('hangi il') || lowered.includes('hangi bolge') || lowered.includes('en yogun')) {
    return `${scopeText} en hareketli konum ${topProvince}. Bu alanda ${topProvinceStats.count} deprem gorunuyor. O bolgedeki en buyuk olay M ${formatMagnitude(topProvinceStats.strongestMagnitude)}.`
  }

  if (
    lowered.includes('yorum') ||
    lowered.includes('analiz') ||
    lowered.includes('ozet') ||
    lowered.includes('degerlendir')
  ) {
    const summaryParts = [
      `${scopeText} ${scopedEarthquakes.length} olay var.`,
      `En guclu deprem ${strongest.place} konumunda M ${formatMagnitude(strongest.magnitude)}.`,
      `En yogun il ${topProvince} ve burada ${topProvinceStats.count} kayit bulunuyor.`,
    ]

    if (clusterSummary) {
      summaryParts.push(
        `${clusterSummary.base.place} cevresinde 75 km icinde ${clusterSummary.count} olaylik bir kume gorunuyor.`,
      )
    }

    summaryParts.push(`Ortalama derinlik ${averageDepth.toFixed(1)} km.`)

    return summaryParts.join(' ')
  }

  return `${scopeText} ${scopedEarthquakes.length} deprem gorunuyor. En son olay ${selectedOrLatest.place}, en buyuk olay ise ${strongest.place} bolgesinde ${formatMagnitude(strongest.magnitude)} buyuklugunde. En yogun il ${topProvince}. Ortalama derinlik ${averageDepth.toFixed(1)} km. Bana il, zaman, secili deprem ya da liste sayisi da verebilirsin.`
}
