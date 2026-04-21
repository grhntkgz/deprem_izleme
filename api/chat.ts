import type { VercelRequest, VercelResponse } from '@vercel/node'
import OpenAI from 'openai'

import { answerChat, calculateEarthquakeStats, fetchEarthquakes, getAfadUrl } from '../netlify/functions/_lib/afad.mts'

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

function getAiAvailability() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL)
}

function buildContextSummary(
  message: string,
  earthquakes: Awaited<ReturnType<typeof fetchEarthquakes>>,
  selectedEarthquakeId?: string,
) {
  const stats = calculateEarthquakeStats(earthquakes)
  const selectedEarthquake = earthquakes.find((earthquake) => earthquake.id === selectedEarthquakeId)
  const latest = earthquakes[0]

  const summary = {
    source: getAfadUrl(),
    total: stats.total,
    latest: latest
      ? {
          place: latest.place,
          magnitude: latest.magnitude,
          depthKm: latest.depthKm,
          timeMs: latest.timeMs,
        }
      : null,
    topProvinces: stats.topProvinces,
    windows: stats.windows,
    highlights: stats.highlights,
    selectedEarthquake: selectedEarthquake
      ? {
          place: selectedEarthquake.place,
          magnitude: selectedEarthquake.magnitude,
          depthKm: selectedEarthquake.depthKm,
          timeMs: selectedEarthquake.timeMs,
        }
      : null,
    recentEarthquakes: earthquakes.slice(0, 20).map((earthquake) => ({
      place: earthquake.place,
      magnitude: earthquake.magnitude,
      depthKm: earthquake.depthKm,
      timeMs: earthquake.timeMs,
    })),
    userQuestion: message,
  }

  return JSON.stringify(summary, null, 2)
}

async function answerWithModel({
  message,
  earthquakes,
  selectedEarthquakeId,
  messages,
}: {
  message: string
  earthquakes: Awaited<ReturnType<typeof fetchEarthquakes>>
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
        content: `AFAD veri ozeti:\n${buildContextSummary(message, earthquakes, selectedEarthquakeId)}`,
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

    const earthquakes = await fetchEarthquakes()
    const selectedEarthquakeId =
      typeof body.selectedEarthquakeId === 'string' ? body.selectedEarthquakeId : undefined

    let answer = ''

    if (getAiAvailability()) {
      try {
        answer = await answerWithModel({
          message,
          earthquakes,
          selectedEarthquakeId,
          messages: Array.isArray(body.messages) ? body.messages : [],
        })
      } catch (modelError) {
        console.error('Model cevabi alinamadi, fallback kullaniliyor:', modelError)
      }
    }

    if (!answer) {
      answer = answerChat(message, earthquakes, {
        selectedEarthquakeId,
      })
    }

    return response.status(200).json({
      answer,
      source: getAfadUrl(),
      fetchedAtMs: Date.now(),
      modelUsed: getAiAvailability() && answer ? modelName : 'fallback',
    })
  } catch (error) {
    console.error('Chat cevabi olusturulamadi:', error)

    return response.status(502).json({
      message: 'Deprem asistani su an cevap veremiyor. Lutfen tekrar deneyin.',
    })
  }
}
