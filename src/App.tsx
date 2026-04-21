import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'

import './App.css'
import type { Earthquake, EarthquakeResponse, EarthquakeStats } from './types'

const refreshIntervalMs = 60_000
const latestPulseThresholdMs = 6 * 60 * 60 * 1000
const TURKEY_CENTER: [number, number] = [39.05, 35.8]
const TURKEY_BOUNDS: L.LatLngBoundsExpression = [
  [35.3, 26.2],
  [42.5, 45.0],
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

function getMovementSignals(timeline: EarthquakeStats['timeline']) {
  const counts = timeline.map((entry) => entry.count)
  const last = counts.at(-1) ?? 0
  const previous = counts.at(-2) ?? last
  const beforePrevious = counts.at(-3) ?? previous

  const lastDelta = last - previous
  const previousDelta = previous - beforePrevious
  const stableThreshold = 2

  let direction = 'Dengeli'
  if (lastDelta > stableThreshold) direction = 'Artiyor'
  if (lastDelta < -stableThreshold) direction = 'Azaliyor'

  let momentum = 'Kararsiz'
  if (Math.abs(lastDelta) <= stableThreshold && Math.abs(previousDelta) <= stableThreshold) {
    momentum = 'Durgun'
  } else if (
    (lastDelta > stableThreshold && previousDelta < -stableThreshold) ||
    (lastDelta < -stableThreshold && previousDelta > stableThreshold)
  ) {
    momentum = 'Tersine donuyor'
  } else if (Math.abs(lastDelta) > Math.abs(previousDelta) + 1) {
    momentum = 'Gucleniyor'
  } else if (Math.abs(lastDelta) + 1 < Math.abs(previousDelta)) {
    momentum = 'Zayifliyor'
  }

  return {
    direction,
    momentum,
    delta: lastDelta,
  }
}

function getAftershockDensityLabel(count: number) {
  if (count >= 10) return 'Yuksek'
  if (count >= 5) return 'Orta'
  if (count >= 1) return 'Dusuk'
  return 'Sakin'
}

function formatSilenceDuration(durationMs: number) {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000))

  if (totalMinutes < 60) {
    return `${totalMinutes} dk`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours < 24) {
    return minutes > 0 ? `${hours} sa ${minutes} dk` : `${hours} sa`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24

  if (remainingHours > 0) {
    return `${days} gun ${remainingHours} sa`
  }

  return `${days} gun`
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

function calculateDisplayStats(
  earthquakes: Earthquake[],
  referenceTimeMs: number,
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

function EarthquakeMap({
  earthquakes,
  latestEarthquakeId,
  selectedEarthquakeId,
  onSelectEarthquake,
}: {
  earthquakes: Earthquake[]
  latestEarthquakeId?: string
  selectedEarthquakeId?: string | null
  onSelectEarthquake?: (earthquakeId: string) => void
}) {
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)

  function fitTurkeyBounds(map: L.Map) {
    const containerWidth = map.getContainer().clientWidth
    const horizontalPadding = containerWidth < 640 ? 4 : 10
    const topBottomPadding = containerWidth < 640 ? 4 : 8
    const rightOverlayPadding = containerWidth > 960 ? Math.min(400, containerWidth * 0.28) : horizontalPadding

    map.fitBounds(TURKEY_BOUNDS, {
      paddingTopLeft: [horizontalPadding, topBottomPadding],
      paddingBottomRight: [rightOverlayPadding, topBottomPadding],
    })
  }

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

    fitTurkeyBounds(map)

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
      const map = mapRef.current
      if (!map) return

      map.invalidateSize()
      fitTurkeyBounds(map)
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
      const isSelected = earthquake.id === selectedEarthquakeId

      const glow = L.circleMarker([earthquake.latitude, earthquake.longitude], {
        radius: radius * (isSelected ? 3.5 : isLatest ? 3.2 : 2.6),
        stroke: false,
        fillColor: color,
        fillOpacity: isSelected ? 0.18 : isLatest ? 0.14 : 0.08,
      })

      const marker = L.circleMarker([earthquake.latitude, earthquake.longitude], {
        radius: isSelected ? radius + 1.5 : radius,
        color,
        weight: isSelected ? 2 : 1,
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

      marker.on('click', () => {
        onSelectEarthquake?.(earthquake.id)
      })

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
  }, [earthquakes, latestEarthquakeId, onSelectEarthquake, selectedEarthquakeId])

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
  const [selectedEarthquakeId, setSelectedEarthquakeId] = useState<string | null>(null)

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
          setError('Guncel veri su an yuklenemedi.')
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
  const effectiveSelectedEarthquakeId = useMemo(() => {
    if (filteredEarthquakes.length === 0) {
      return null
    }

    if (selectedEarthquakeId && filteredEarthquakes.some((earthquake) => earthquake.id === selectedEarthquakeId)) {
      return selectedEarthquakeId
    }

    return filteredEarthquakes[0].id
  }, [filteredEarthquakes, selectedEarthquakeId])
  const selectedEarthquake = useMemo(
    () => filteredEarthquakes.find((earthquake) => earthquake.id === effectiveSelectedEarthquakeId) ?? null,
    [filteredEarthquakes, effectiveSelectedEarthquakeId],
  )

  const latestEarthquakeId = filteredEarthquakes[0]?.id
  const latestEarthquake = filteredEarthquakes[0] ?? null
  const referenceTimeMs = data?.fetchedAtMs ?? 0
  const isDataStale =
    latestEarthquake && referenceTimeMs
      ? referenceTimeMs - latestEarthquake.timeMs > latestPulseThresholdMs
      : false
  const pulsingEarthquakeId = latestEarthquakeId
  const statsReferenceTimeMs = referenceTimeMs || latestEarthquake?.timeMs || 0
  const displayStats = useMemo(
    () => calculateDisplayStats(filteredEarthquakes, statsReferenceTimeMs),
    [filteredEarthquakes, statsReferenceTimeMs],
  )
  const topProvinceMax = Math.max(...displayStats.topProvinces.map((province) => province.count), 1)
  const timelineMax = Math.max(...displayStats.timeline.map((entry) => entry.count), 1)
  const aftershockDensityCount = useMemo(() => {
    if (!selectedEarthquake) return 0

    return filteredEarthquakes.filter((earthquake) => {
      if (earthquake.id === selectedEarthquake.id) return false
      const isNearby = distanceKm(selectedEarthquake, earthquake) <= 80
      const isCloseInTime = Math.abs(selectedEarthquake.timeMs - earthquake.timeMs) <= 24 * 60 * 60 * 1000
      const isComparableMagnitude = earthquake.magnitude <= selectedEarthquake.magnitude + 0.5

      return isNearby && isCloseInTime && isComparableMagnitude
    }).length
  }, [filteredEarthquakes, selectedEarthquake])
  const aftershockDensityLabel = useMemo(
    () => getAftershockDensityLabel(aftershockDensityCount),
    [aftershockDensityCount],
  )
  const silenceDurationLabel = useMemo(() => {
    if (!latestEarthquake || !referenceTimeMs) return '0 dk'
    return formatSilenceDuration(referenceTimeMs - latestEarthquake.timeMs)
  }, [latestEarthquake, referenceTimeMs])
  const movementSignals = useMemo(
    () => getMovementSignals(displayStats.timeline),
    [displayStats.timeline],
  )

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
        body: JSON.stringify({
          message: trimmed,
          selectedEarthquakeId: effectiveSelectedEarthquakeId ?? undefined,
          messages: messages.slice(-8).map((message) => ({
            role: message.role,
            text: message.text,
          })),
        }),
      })

      if (!response.ok) {
        throw new Error('Chat cevabi alinamadi')
      }

      const payload = (await response.json()) as { answer: string; modelUsed?: string }
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
        <h1>Son 100 Deprem</h1>
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
      {loading ? <div className="status-banner">Veri yukleniyor.</div> : null}
      {!loading && !error && isDataStale && latestEarthquake ? (
        <div className="status-banner warning">
          Kaynak su anda guncel gorunmuyor. Son kayit {formatDate(latestEarthquake.timeMs)} zamanina ait.
        </div>
      ) : null}

      <main className="tracker-layout">
        <aside className="sidebar">
          <section className="sidebar-section">
            <h2>Son Depremler</h2>
            <div className="feed-list">
              {feed.map((earthquake) => (
                <button
                  className={`feed-item${earthquake.id === effectiveSelectedEarthquakeId ? ' feed-item-active' : ''}`}
                  key={earthquake.id}
                  type="button"
                  onClick={() => setSelectedEarthquakeId(earthquake.id)}
                >
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
                </button>
              ))}
            </div>
          </section>

        </aside>

        <section className="content-panel">
          <section className="overview-panel">
            <div className="overview-top-grid">
              <div className="overview-main-stack">
                <div className="stats-hero-grid">
                <div className="stats-hero-card">
                  <span>Toplam olay</span>
                  <strong>{displayStats.total}</strong>
                  <small>Filtrelenmis gorunum</small>
                </div>
                <div className="stats-hero-card">
                  <span>En büyük</span>
                  <strong>{displayStats.highestMagnitude.toFixed(1)}</strong>
                  <small>Son 100 kayit icinde</small>
                </div>
                <div className="stats-hero-card">
                  <span>Ort. derinlik</span>
                  <strong>{displayStats.averageDepth.toFixed(1)} km</strong>
                  <small>Ort. buyukluk {displayStats.averageMagnitude.toFixed(1)}</small>
                </div>
                </div>

                <div className="insight-strip">
                  <div className="insight-card">
                    <span>Artçı yoğunluğu</span>
                    <strong>{aftershockDensityLabel}</strong>
                    <small>{aftershockDensityCount} yakin olay / 24 saat / 80 km</small>
                  </div>
                  <div className="insight-card">
                    <span>Sessizlik süresi</span>
                    <strong>{silenceDurationLabel}</strong>
                    <small>Son depremden beri gecen sure</small>
                  </div>
                  <div className="insight-card">
                    <span>Hareket yönü</span>
                    <strong>{movementSignals.direction}</strong>
                    <small>
                      Ivme: {movementSignals.momentum}
                      {movementSignals.delta !== 0 ? ` · Son fark ${movementSignals.delta > 0 ? '+' : ''}${movementSignals.delta}` : ''}
                    </small>
                  </div>
                </div>
              </div>

              <div className="stats-card stats-card-windows">
                <div className="stats-card-head">
                  <span>Hızlı pencere</span>
                </div>
                <div className="window-grid">
                  {displayStats.windows.map((window) => (
                    <div className="window-pill" key={window.label}>
                      <strong>{window.count}</strong>
                      <span>{window.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="overview-bottom-grid">
              <div className="stats-card">
                <div className="stats-card-head">
                  <span>Bölgesel yoğunluk</span>
                </div>
                <div className="province-list">
                  {displayStats.topProvinces.map((province) => (
                    <div className="province-row" key={province.name}>
                      <div className="province-row-top">
                        <strong>{province.name}</strong>
                        <span>{province.count} olay</span>
                      </div>
                      <div className="province-bar">
                        <span
                          style={{
                            width: `${(province.count / topProvinceMax) * 100}%`,
                            background: `linear-gradient(90deg, ${getMagnitudeColor(
                              province.strongestMagnitude,
                            )}, #79ffd8)`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="stats-card">
                <div className="stats-card-head">
                  <span>Zaman akışı</span>
                  <small>4 saatlik bloklar</small>
                </div>
                <div className="timeline-bars">
                  {displayStats.timeline.map((entry) => (
                    <div className="timeline-bar-item" key={entry.label}>
                      <div
                        className="timeline-bar-fill"
                        style={{
                          height: `${Math.max((entry.count / timelineMax) * 100, entry.count > 0 ? 12 : 4)}%`,
                        }}
                      />
                      <span>{entry.label}</span>
                      <strong>{entry.count}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="stats-card">
                <div className="stats-card-head">
                  <span>Öne çıkan olaylar</span>
                </div>
                <div className="highlight-list">
                  {displayStats.highlights.map((earthquake) => (
                    <div className="highlight-row" key={earthquake.id}>
                      <span
                        className="highlight-badge"
                        style={{ backgroundColor: getMagnitudeColor(earthquake.magnitude) }}
                      >
                        M {earthquake.magnitude.toFixed(1)}
                      </span>
                      <div>
                        <strong>{earthquake.place}</strong>
                        <small>{formatShortTime(earthquake.timeMs)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="stats-card">
                <div className="stats-card-head">
                  <span>Büyüklük skalası</span>
                </div>
                <div className="legend-items">
                  {[1, 2, 3, 4, 5].map((magnitude) => (
                    <div className="legend-item" key={magnitude}>
                      <i style={{ backgroundColor: getMagnitudeColor(magnitude) }} />
                      <span>{magnitude.toFixed(1)}+</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="map-panel">
            <EarthquakeMap
              earthquakes={filteredEarthquakes}
              latestEarthquakeId={pulsingEarthquakeId}
              selectedEarthquakeId={effectiveSelectedEarthquakeId}
              onSelectEarthquake={setSelectedEarthquakeId}
            />
            <section className="chat-shell">
              <div className="chat-section chat-section-floating">
                <div className="chat-section-head">
                  <h2>Deprem Asistanı</h2>
                  <span>AI</span>
                </div>
                {selectedEarthquake ? (
                  <div className="chat-context-card">
                    <span className="chat-context-label">Secili deprem</span>
                    <strong>{selectedEarthquake.place}</strong>
                    <div className="chat-context-meta">
                      <span>M {selectedEarthquake.magnitude.toFixed(1)}</span>
                      <span>{selectedEarthquake.depthKm.toFixed(1)} km</span>
                      <span>{formatShortTime(selectedEarthquake.timeMs)}</span>
                    </div>
                  </div>
                ) : null}
                <div className="chat-prompt-row">
                  {[
                    'En yogun bolge neresi?',
                    'Son 1 saatte en buyuk deprem hangisi?',
                    'Secili deprem cevresinde hareketlilik var mi?',
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="chat-prompt-chip"
                      onClick={() => setChatInput(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
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
              </div>
            </section>
          </section>
        </section>
      </main>
    </div>
  )
}

export default App
