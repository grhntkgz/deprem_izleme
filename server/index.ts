import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as cheerio from 'cheerio'
import express from 'express'

const AFAD_URL = 'https://deprem.afad.gov.tr/last-earthquakes.html'
const PORT = Number(process.env.PORT ?? 3001)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')

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

const app = express()
app.use(express.json())

function toNumber(value: string) {
  return Number(value.replace(',', '.').trim())
}

function toTimeMs(value: string) {
  const parsed = new Date(`${value.trim().replace(' ', 'T')}+03:00`).getTime()
  return Number.isNaN(parsed) ? Date.now() : parsed
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
      'user-agent': 'Mozilla/5.0 Codex AFAD Earthquake Map',
    },
  })

  if (!response.ok) {
    throw new Error(`AFAD yaniti basarisiz: ${response.status}`)
  }

  const html = await response.text()
  return parseEarthquakes(html)
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

function normalizeText(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['".,!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  if (lowered.includes('son saat')) return 60
  if (lowered.includes('son yarim saat') || lowered.includes('son yarım saat')) return 30
  return null
}

function getWindowHours(message: string) {
  const lowered = message.toLocaleLowerCase('tr-TR')
  const hourMatch = lowered.match(/(\d+)\s*saat/)
  if (hourMatch) return Number(hourMatch[1])
  if (lowered.includes('bugun')) return 24
  if (lowered.includes('son saat')) return 1
  return null
}

function answerChat(message: string, earthquakes: Earthquake[]) {
  const lowered = normalizeText(message)
  const now = Date.now()
  const windowMinutes = getWindowMinutes(message)
  const windowHours = getWindowHours(message)
  const placeFilter = extractPlaceFilter(message, earthquakes)
  const countMatch = lowered.match(/(?:ilk|son|top)\s*(\d+)/)
  const requestedCount = countMatch ? Number(countMatch[1]) : null

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
    if (placeFilter && windowHours) {
      return `Son ${windowHours} saatte ${placeFilter.raw} icin AFAD verisinde eslesen deprem bulamadim.`
    }

    if (placeFilter) {
      return `${placeFilter.raw} icin AFAD son 100 listesinde eslesen deprem bulamadim.`
    }

    return 'Bu zaman araliginda AFAD verisinde eslesen deprem bulamadim.'
  }

  const latest = scopedEarthquakes[0]
  const strongest = [...scopedEarthquakes].sort((left, right) => right.magnitude - left.magnitude)[0]
  const averageDepth =
    scopedEarthquakes.reduce((sum, earthquake) => sum + earthquake.depthKm, 0) /
    scopedEarthquakes.length
  const averageMagnitude =
    scopedEarthquakes.reduce((sum, earthquake) => sum + earthquake.magnitude, 0) /
    scopedEarthquakes.length
  const prefix = [
    placeFilter ? `${placeFilter.raw} icin` : null,
    windowHours ? `son ${windowHours} saatte` : null,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
  const scopeText = prefix.length > 0 ? prefix : 'AFAD son 100 listesinde'

  if (lowered.includes('liste') || lowered.includes('goster') || lowered.includes('gosterir misin')) {
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

  if (lowered.includes('en buyuk') || lowered.includes('en güçlü') || lowered.includes('en guclu')) {
    return `${scopeText} en buyuk deprem ${strongest.place} bolgesinde oldu. Buyukluk ${formatMagnitude(strongest.magnitude)}, derinlik ${strongest.depthKm.toFixed(1)} km, zaman ${formatTime(strongest.timeMs)}.`
  }

  if (lowered.includes('son deprem') || lowered.includes('en son')) {
    return `En son deprem ${latest.place} konumunda kaydedildi. Buyukluk ${formatMagnitude(latest.magnitude)}, derinlik ${latest.depthKm.toFixed(1)} km, zaman ${formatTime(latest.timeMs)}.`
  }

  if (lowered.includes('kaç deprem') || lowered.includes('kac deprem')) {
    return `${scopeText} toplam ${scopedEarthquakes.length} deprem var. Bu veri setindeki en buyuk olay ${formatMagnitude(strongest.magnitude)} buyuklugunde.`
  }

  if (lowered.includes('ortalama') || lowered.includes('derinlik')) {
    return `${scopeText} ortalama derinlik ${averageDepth.toFixed(1)} km. Ortalama buyukluk ${averageMagnitude.toFixed(1)}. En son olay ${latest.place}, en buyuk olay ise ${strongest.place}.`
  }

  if (lowered.includes('hangi il') || lowered.includes('hangi bolge') || lowered.includes('hangi bölge')) {
    const grouped = new Map<string, number>()
    scopedEarthquakes.forEach((earthquake) => {
      const match = earthquake.place.match(/\(([^)]+)\)\s*$/)
      const key = match?.[1] ?? earthquake.place
      grouped.set(key, (grouped.get(key) ?? 0) + 1)
    })

    const [topPlace, topCount] =
      [...grouped.entries()].sort((left, right) => right[1] - left[1])[0] ?? ['Bilinmiyor', 0]

    return `${scopeText} en hareketli konum ${topPlace}. Bu alanda ${topCount} deprem gorunuyor.`
  }

  return `${scopeText} ${scopedEarthquakes.length} deprem gorunuyor. En son olay ${latest.place}, en buyuk olay ise ${strongest.place} bolgesinde ${formatMagnitude(strongest.magnitude)} buyuklugunde. Ortalama derinlik ${averageDepth.toFixed(1)} km. Bana il, zaman veya liste sayisi da verebilirsin.`
}

app.get('/api/earthquakes', async (_req, res) => {
  try {
    const earthquakes = await fetchEarthquakes()

    res.json({
      source: AFAD_URL,
      fetchedAtMs: Date.now(),
      total: earthquakes.length,
      earthquakes,
    })
  } catch (error) {
    console.error('AFAD verisi alinamadi:', error)
    res.status(502).json({
      message: 'AFAD deprem verisi su an alinmadi. Lutfen biraz sonra tekrar deneyin.',
    })
  }
})

app.post('/api/chat', async (req, res) => {
  try {
    const message =
      typeof req.body?.message === 'string' ? req.body.message.trim() : ''

    if (!message) {
      res.status(400).json({ message: 'Soru bos olamaz.' })
      return
    }

    const earthquakes = await fetchEarthquakes()
    const answer = answerChat(message, earthquakes)

    res.json({
      answer,
      source: AFAD_URL,
      fetchedAtMs: Date.now(),
    })
  } catch (error) {
    console.error('Chat cevabi olusturulamadi:', error)
    res.status(502).json({
      message: 'Deprem asistani su an cevap veremiyor. Lutfen tekrar deneyin.',
    })
  }
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distDir))

  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`AFAD deprem haritasi http://localhost:${PORT} adresinde calisiyor`)
})
