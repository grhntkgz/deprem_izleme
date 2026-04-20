import type { Config } from '@netlify/functions'

import { calculateEarthquakeStats, fetchEarthquakes, getAfadUrl } from './_lib/afad.mts'

export default async () => {
  try {
    const earthquakes = await fetchEarthquakes()
    const fetchedAtMs = Date.now()
    const stats = calculateEarthquakeStats(earthquakes, fetchedAtMs)

    return Response.json({
      source: getAfadUrl(),
      fetchedAtMs,
      total: earthquakes.length,
      earthquakes,
      stats,
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
