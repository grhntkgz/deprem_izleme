import type { VercelRequest, VercelResponse } from '@vercel/node'

import { calculateEarthquakeStats, fetchEarthquakes, getAfadUrl } from './_lib/afad'

export default async function handler(_request: VercelRequest, response: VercelResponse) {
  try {
    const earthquakes = await fetchEarthquakes()
    const fetchedAtMs = Date.now()
    const stats = calculateEarthquakeStats(earthquakes, fetchedAtMs)

    return response.status(200).json({
      source: getAfadUrl(),
      fetchedAtMs,
      total: earthquakes.length,
      earthquakes,
      stats,
    })
  } catch (error) {
    console.error('AFAD verisi alinamadi:', error)

    return response.status(502).json({
      message: 'AFAD deprem verisi su an alinmadi. Lutfen biraz sonra tekrar deneyin.',
    })
  }
}
