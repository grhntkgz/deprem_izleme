import type { VercelRequest, VercelResponse } from '@vercel/node'
import OpenAI from 'openai'

type Earthquake = {
  id: string
  timeMs: number
  latitude: number
  longitude: number
  depthKm: number
  magnitude: number
  place: string
}

type ChatRequestMessage = {
  role?: 'assistant' | 'user'
  text?: string
}

const modelName = 'gpt-5-mini'
const systemPrompt = `
Sen bir deprem veri analiz asistanisin.
Yanitlarini kisa, net, anlasilir ve Turkce ver.
Sadece sana verilen AFAD veri ozeti ve mesaj gecmisine gore cevap ver.
Veri yetersizse bunu acikca soyle. Kesin risk tahmini yapma.
Mumkun oldugunda sonuca once kisa cevap, sonra 1-3 maddelik analitik destek ver.
`

function getBaseUrl(request: VercelRequest) {
  const host = request.headers['x-forwarded-host'] ?? request.headers.host
  const protocol = request.headers['x-forwarded-proto'] ?? 'https'
  return `${protocol}://${host}`
}

async function fetchEarthquakes(request: VercelRequest) {
  const response = await fetch(`${getBaseUrl(request)}/api/earthquakes`)

  if (!response.ok) {
    throw new Error(`Deprem API yaniti basarisiz: ${response.status}`)
  }

  const payload = (await response.json()) as {
    earthquakes?: Earthquake[]
    source?: string
    stats?: {
      total: number
      topProvinces: Array<{ name: string; count: number; strongestMagnitude: number }>
      windows: Array<{ label: string; count: number }>
      highlights: Array<{ id: string; place: string; magnitude: number; timeMs: number }>
    }
  }

  return {
    source: payload.source ?? 'https://deprem.afad.gov.tr/last-earthquakes.html',
    stats: payload.stats,
    earthquakes: Array.isArray(payload.earthquakes) ? payload.earthquakes : [],
  }
}

function extractProvince(place: string) {
  const match = place.match(/\(([^)]+)\)\s*$/)
  return match?.[1]?.trim() ?? place
}

function formatTime(timeMs: number) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timeMs))
}

function fallbackAnswer(message: string, earthquakes: Earthquake[], selectedEarthquakeId?: string) {
  if (earthquakes.length === 0) {
    return 'Su an yorumlayabilecegim deprem verisi bulunamadi.'
  }

  const normalizedMessage = message.toLocaleLowerCase('tr-TR')
  const latest = earthquakes[0]
  const selected = earthquakes.find((earthquake) => earthquake.id === selectedEarthquakeId)
  const strongest = [...earthquakes].sort((left, right) => right.magnitude - left.magnitude)[0]
  const averageDepth =
    earthquakes.reduce((sum, earthquake) => sum + earthquake.depthKm, 0) / earthquakes.length

  const provinceCounts = new Map<string, number>()
  earthquakes.forEach((earthquake) => {
    const province = extractProvince(earthquake.place)
    provinceCounts.set(province, (provinceCounts.get(province) ?? 0) + 1)
  })
  const [topProvince, topProvinceCount] =
    [...provinceCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? ['Bilinmiyor', 0]

  if (normalizedMessage.includes('secili') && selected) {
    return `Secili deprem ${selected.place} konumunda. Buyukluk M ${selected.magnitude.toFixed(1)}, derinlik ${selected.depthKm.toFixed(1)} km, zaman ${formatTime(selected.timeMs)}.`
  }

  if (normalizedMessage.includes('en buyuk') || normalizedMessage.includes('en büyük')) {
    return `Son 100 kayittaki en buyuk deprem ${strongest.place} konumunda. Buyukluk M ${strongest.magnitude.toFixed(1)}, derinlik ${strongest.depthKm.toFixed(1)} km, zaman ${formatTime(strongest.timeMs)}.`
  }

  if (normalizedMessage.includes('en yogun') || normalizedMessage.includes('en yoğun')) {
    return `Son 100 kayitta en yogun gorunen bolge ${topProvince}. Bu bolgede ${topProvinceCount} olay var.`
  }

  return `Son 100 kayitta ${earthquakes.length} deprem gorunuyor. En son olay ${latest.place}, en buyuk olay ${strongest.place} konumunda M ${strongest.magnitude.toFixed(1)}. En yogun bolge ${topProvince}. Ortalama derinlik ${averageDepth.toFixed(1)} km.`
}

function buildContextSummary({
  message,
  source,
  stats,
  earthquakes,
  selectedEarthquakeId,
}: {
  message: string
  source: string
  stats?: Awaited<ReturnType<typeof fetchEarthquakes>>['stats']
  earthquakes: Earthquake[]
  selectedEarthquakeId?: string
}) {
  const selectedEarthquake = earthquakes.find((earthquake) => earthquake.id === selectedEarthquakeId)
  const latest = earthquakes[0]

  return JSON.stringify(
    {
      source,
      total: stats?.total ?? earthquakes.length,
      latest,
      topProvinces: stats?.topProvinces,
      windows: stats?.windows,
      highlights: stats?.highlights,
      selectedEarthquake,
      recentEarthquakes: earthquakes.slice(0, 20).map((earthquake) => ({
        place: earthquake.place,
        magnitude: earthquake.magnitude,
        depthKm: earthquake.depthKm,
        timeMs: earthquake.timeMs,
      })),
      userQuestion: message,
    },
    null,
    2,
  )
}

async function answerWithModel({
  message,
  source,
  stats,
  earthquakes,
  selectedEarthquakeId,
  messages,
}: {
  message: string
  source: string
  stats?: Awaited<ReturnType<typeof fetchEarthquakes>>['stats']
  earthquakes: Earthquake[]
  selectedEarthquakeId?: string
  messages: ChatRequestMessage[]
}) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  })
  const recentMessages = messages
    .filter(
      (item): item is { role: 'assistant' | 'user'; text: string } =>
        (item.role === 'assistant' || item.role === 'user') &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0,
    )
    .slice(-8)
    .map((item) => ({
      role: item.role,
      content: item.text.trim(),
    }))

  const modelResponse = await openai.responses.create({
    model: modelName,
    input: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'system',
        content: `AFAD veri ozeti:\n${buildContextSummary({
          message,
          source,
          stats,
          earthquakes,
          selectedEarthquakeId,
        })}`,
      },
      ...recentMessages,
      {
        role: 'user',
        content: message,
      },
    ],
  })

  return modelResponse.output_text.trim()
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Sadece POST istekleri desteklenir.' })
  }

  try {
    const body = request.body as {
      message?: string
      selectedEarthquakeId?: string
      messages?: ChatRequestMessage[]
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''

    if (!message) {
      return response.status(400).json({ message: 'Soru bos olamaz.' })
    }

    const { source, stats, earthquakes } = await fetchEarthquakes(request)
    const selectedEarthquakeId =
      typeof body.selectedEarthquakeId === 'string' ? body.selectedEarthquakeId : undefined

    let answer = ''
    let modelUsed = 'fallback'

    if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
      try {
        answer = await answerWithModel({
          message,
          source,
          stats,
          earthquakes,
          selectedEarthquakeId,
          messages: Array.isArray(body.messages) ? body.messages : [],
        })
        modelUsed = modelName
      } catch (modelError) {
        console.error('Model cevabi alinamadi, fallback kullaniliyor:', modelError)
      }
    }

    if (!answer) {
      answer = fallbackAnswer(message, earthquakes, selectedEarthquakeId)
    }

    return response.status(200).json({
      answer,
      source,
      fetchedAtMs: Date.now(),
      modelUsed,
    })
  } catch (error) {
    console.error('Chat cevabi olusturulamadi:', error)

    return response.status(502).json({
      message: 'Deprem asistani su an cevap veremiyor. Lutfen tekrar deneyin.',
      detail: error instanceof Error ? error.message : 'Bilinmeyen hata',
    })
  }
}
