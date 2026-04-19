import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'

import './App.css'
import type { Earthquake, EarthquakeResponse } from './types'

const refreshIntervalMs = 60_000
const TURKEY_CENTER: [number, number] = [39.05, 35.2]
const TURKEY_BOUNDS: L.LatLngBoundsExpression = [
  [34.6, 24.2],
  [43.4, 46.8],
]

type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

function formatDate(timeMs: number) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(timeMs))
}

function formatShortTime(timeMs: number) {
  return new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timeMs))
}

function minutesAgo(timeMs: number) {
  return Math.max(0, Math.round((Date.now() - timeMs) / 60_000))
}

function getMagnitudeColor(magnitude: number) {
  if (magnitude >= 5) return '#ff4d4d'
  if (magnitude >= 4) return '#ff8f3d'
  if (magnitude >= 3) return '#ffd23f'
  if (magnitude >= 2) return '#b6ff63'
  return '#79ffd8'
}

function getMagnitudeRadius(magnitude: number) {
  return Math.max(5, magnitude * 4)
}

function EarthquakeMap({
  earthquakes,
  latestEarthquakeId,
}: {
  earthquakes: Earthquake[]
  latestEarthquakeId?: string
}) {
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return

    const map = L.map(mapElementRef.current, {
      center: TURKEY_CENTER,
      zoom: 6,
      minZoom: 4,
      maxZoom: 8,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
    })

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png').addTo(map)

    map.fitBounds(TURKEY_BOUNDS, {
      padding: [12, 12],
    })

    markersRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapRef.current) return

    const resizeMap = () => {
      mapRef.current?.invalidateSize()
    }

    const observer = mapElementRef.current
      ? new ResizeObserver(() => {
          resizeMap()
        })
      : null

    if (mapElementRef.current && observer) {
      observer.observe(mapElementRef.current)
    }

    window.setTimeout(resizeMap, 0)
    window.setTimeout(resizeMap, 150)
    window.addEventListener('resize', resizeMap)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resizeMap)
    }
  }, [])

  useEffect(() => {
    if (!markersRef.current) return

    const markerLayer = markersRef.current
    markerLayer.clearLayers()

    earthquakes.forEach((earthquake) => {
      const color = getMagnitudeColor(earthquake.magnitude)
      const radius = getMagnitudeRadius(earthquake.magnitude)
      const isLatest = earthquake.id === latestEarthquakeId

      const glow = L.circleMarker([earthquake.latitude, earthquake.longitude], {
        radius: radius * (isLatest ? 3.2 : 2.6),
        stroke: false,
        fillColor: color,
        fillOpacity: isLatest ? 0.14 : 0.08,
      })

      const marker = L.circleMarker([earthquake.latitude, earthquake.longitude], {
        radius,
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.85,
        className: 'quake-glow-marker',
      })

      marker.bindPopup(
        `
          <strong>${earthquake.place}</strong><br/>
          Buyukluk: ${earthquake.magnitude.toFixed(1)}<br/>
          Derinlik: ${earthquake.depthKm.toFixed(1)} km<br/>
          Zaman: ${formatDate(earthquake.timeMs)}<br/>
          <a href="${earthquake.detailUrl}" target="_blank" rel="noreferrer">AFAD detay</a>
        `,
      )

      glow.addTo(markerLayer)
      marker.addTo(markerLayer)

      if (isLatest) {
        const latestPulse = L.marker([earthquake.latitude, earthquake.longitude], {
          interactive: false,
          icon: L.divIcon({
            className: 'latest-quake-icon',
            html: `<span class="latest-quake-pulse" style="--latest-color:${color}"></span>`,
            iconSize: [radius * 6, radius * 6],
            iconAnchor: [radius * 3, radius * 3],
          }),
        })

        latestPulse.addTo(markerLayer)
      }
    })
  }, [earthquakes, latestEarthquakeId])

  return <div ref={mapElementRef} className="world-map" />
}

function App() {
  const [data, setData] = useState<EarthquakeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [minMagnitude, setMinMagnitude] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'AFAD deprem asistani hazir. Bana "son 1 saatte en buyuk deprem nerede oldu?" gibi bir soru sor.',
    },
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  const earthquakes = useMemo(() => data?.earthquakes ?? [], [data])

  useEffect(() => {
    let isMounted = true

    const load = async () => {
      try {
        if (isMounted) setLoading(true)

        const response = await fetch('/api/earthquakes')
        if (!response.ok) throw new Error('Veri alinamadi')

        const payload = (await response.json()) as EarthquakeResponse

        if (isMounted) {
          setData(payload)
          setError(null)
        }
      } catch (loadError) {
        if (isMounted) {
          setError('AFAD verisi su an yuklenemedi.')
        }
        console.error(loadError)
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    void load()
    const interval = window.setInterval(() => {
      void load()
    }, refreshIntervalMs)

    return () => {
      isMounted = false
      window.clearInterval(interval)
    }
  }, [])

  const filteredEarthquakes = useMemo(
    () => earthquakes.filter((earthquake) => earthquake.magnitude >= minMagnitude),
    [earthquakes, minMagnitude],
  )

  const feed = useMemo(() => filteredEarthquakes.slice(0, 12), [filteredEarthquakes])

  const stats = useMemo(() => {
    const highestMagnitude = filteredEarthquakes.reduce(
      (max, earthquake) => Math.max(max, earthquake.magnitude),
      0,
    )

    const averageDepth =
      filteredEarthquakes.reduce((sum, earthquake) => sum + earthquake.depthKm, 0) /
      Math.max(filteredEarthquakes.length, 1)

    return {
      total: filteredEarthquakes.length,
      highestMagnitude,
      averageDepth,
    }
  }, [filteredEarthquakes])

  const latestEarthquakeId = filteredEarthquakes[0]?.id

  async function handleChatSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = chatInput.trim()

    if (!trimmed || chatLoading) {
      return
    }

    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: 'user',
      text: trimmed,
    }

    setMessages((current) => [...current, userMessage])
    setChatInput('')
    setChatLoading(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: trimmed }),
      })

      if (!response.ok) {
        throw new Error('Chat cevabi alinamadi')
      }

      const payload = (await response.json()) as { answer: string }
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          text: payload.answer,
        },
      ])
    } catch (chatError) {
      console.error(chatError)
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-assistant-error`,
          role: 'assistant',
          text: 'Su an cevap olusturamadim. Biraz sonra tekrar deneyelim.',
        },
      ])
    } finally {
      setChatLoading(false)
    }
  }

  return (
    <div className="tracker-page">
      <header className="tracker-header">
        <h1>AFAD Son 100 Deprem Haritasi</h1>
        <div className="tracker-header-right">
          <label className="magnitude-control">
            <span>Buyukluk limiti</span>
            <select value={minMagnitude} onChange={(event) => setMinMagnitude(Number(event.target.value))}>
              <option value="0">0.0+</option>
              <option value="1">1.0+</option>
              <option value="2.5">2.5+</option>
              <option value="4">4.0+</option>
              <option value="5">5.0+</option>
            </select>
          </label>
          <span className="last-updated">
            Son guncelleme: {data ? formatDate(data.fetchedAtMs) : 'Yukleniyor'}
          </span>
        </div>
      </header>

      {error ? <div className="status-banner error">{error}</div> : null}
      {loading ? <div className="status-banner">AFAD verisi yukleniyor...</div> : null}

      <main className="tracker-layout">
        <aside className="sidebar">
          <section className="sidebar-section">
            <h2>Son Depremler</h2>
            <div className="feed-list">
              {feed.map((earthquake) => (
                <article className="feed-item" key={earthquake.id}>
                  <div className="feed-item-head">
                    <span
                      className="feed-badge"
                      style={{ backgroundColor: getMagnitudeColor(earthquake.magnitude) }}
                    >
                      {earthquake.magnitude.toFixed(1)}
                    </span>
                    <time>{formatShortTime(earthquake.timeMs)}</time>
                  </div>
                  <h3>{earthquake.place}</h3>
                  <div className="feed-meta">
                    <span>{minutesAgo(earthquake.timeMs)} dk once</span>
                    <span>{earthquake.depthKm.toFixed(0)} km</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="sidebar-section">
            <h2>Deprem Istatistikleri</h2>
            <div className="stats-card">
              <div className="stat-row">
                <span>Toplam olay</span>
                <strong>{stats.total}</strong>
              </div>
              <div className="stat-row">
                <span>En buyuk</span>
                <strong>{stats.highestMagnitude.toFixed(1)}</strong>
              </div>
              <div className="stat-row">
                <span>Ort. derinlik</span>
                <strong>{stats.averageDepth.toFixed(1)} km</strong>
              </div>
            </div>
            <div className="legend">
              <span>Buyukluk skalasi</span>
              <div className="legend-items">
                {[1, 2, 3, 4, 5].map((magnitude) => (
                  <div className="legend-item" key={magnitude}>
                    <i style={{ backgroundColor: getMagnitudeColor(magnitude) }} />
                    <span>{magnitude.toFixed(1)}+</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="sidebar-section chat-section">
            <div className="chat-section-head">
              <h2>Deprem Asistani</h2>
              <span>AI</span>
            </div>
            <div className="chat-list">
              {messages.map((message) => (
                <article
                  className={`chat-message chat-message-${message.role}`}
                  key={message.id}
                >
                  {message.text}
                </article>
              ))}
            </div>
            <form className="chat-form" onSubmit={handleChatSubmit}>
              <input
                type="text"
                placeholder="Son 1 saatte en buyuk deprem nerede oldu?"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
              />
              <button type="submit" disabled={chatLoading}>
                {chatLoading ? 'Bekleniyor' : 'Sor'}
              </button>
            </form>
          </section>
        </aside>

        <section className="map-panel">
          <EarthquakeMap
            earthquakes={filteredEarthquakes}
            latestEarthquakeId={latestEarthquakeId}
          />
        </section>
      </main>
    </div>
  )
}

export default App
