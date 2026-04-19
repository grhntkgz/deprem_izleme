import type { Config } from '@netlify/functions'

import { answerChat, fetchEarthquakes, getAfadUrl } from './_lib/afad.mts'

export default async (req: Request) => {
  try {
    const body = (await req.json()) as { message?: string }
    const message = typeof body.message === 'string' ? body.message.trim() : ''

    if (!message) {
      return Response.json({ message: 'Soru bos olamaz.' }, { status: 400 })
    }

    const earthquakes = await fetchEarthquakes()
    const answer = answerChat(message, earthquakes)

    return Response.json({
      answer,
      source: getAfadUrl(),
      fetchedAtMs: Date.now(),
    })
  } catch (error) {
    console.error('Chat cevabi olusturulamadi:', error)
    return Response.json(
      {
        message: 'Deprem asistani su an cevap veremiyor. Lutfen tekrar deneyin.',
      },
      { status: 502 },
    )
  }
}

export const config: Config = {
  path: '/api/chat',
}
