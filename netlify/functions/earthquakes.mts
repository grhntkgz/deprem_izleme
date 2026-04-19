import type { Config } from '@netlify/functions'

import { fetchEarthquakes, getAfadUrl } from './_lib/afad.mts'

export default async () => {
  try {
    const earthquakes = await fetchEarthquakes()

    return Response.json({
      source: getAfadUrl(),
      fetchedAtMs: Date.now(),
      total: earthquakes.length,
      earthquakes,
    })
  } catch (error) {
    console.error('AFAD verisi alinamadi:', error)
    return Response.json(
      {
        message: 'AFAD deprem verisi su an alinmadi. Lutfen biraz sonra tekrar deneyin.',
      },
      { status: 502 },
    )
  }
}

export const config: Config = {
  path: '/api/earthquakes',
}
