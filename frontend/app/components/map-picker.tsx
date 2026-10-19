"use client";

import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
type Point = { latitude: number; longitude: number };
type Place = Point & { label: string };

export default function MapPicker({
  initialPoint,
  purpose,
  token,
  onConfirm,
  onCancel,
}: {
  initialPoint?: Point | null;
  purpose: "pickup" | "drop-off";
  token: string;
  onConfirm: (point: Point) => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const marker = useRef<import("leaflet").Marker | null>(null);
  const [point, setPoint] = useState<Point | null>(initialPoint ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    let disposed = false;
    void import("leaflet").then((L) => {
      if (!host.current || disposed) return;
      const center: [number, number] = initialPoint
        ? [initialPoint.latitude, initialPoint.longitude]
        : [12.9716, 77.5946];
      const pickerMap = L.map(host.current, { zoomControl: true }).setView(center, initialPoint ? 15 : 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(pickerMap);
      map.current = pickerMap;
      if (initialPoint) marker.current = L.marker(center).addTo(pickerMap);
      pickerMap.on("click", (event: import("leaflet").LeafletMouseEvent) => {
        const selected = { latitude: event.latlng.lat, longitude: event.latlng.lng };
        setPoint(selected);
        if (marker.current) marker.current.setLatLng(event.latlng);
        else marker.current = L.marker(event.latlng).addTo(pickerMap);
      });
    });
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
  }, [initialPoint]);

  useEffect(() => {
    let stale = false;
    if (query.trim().length < 3) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`${API}/api/locations/suggest?q=${encodeURIComponent(query.trim())}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Location search failed");
        return body as Place[];
      }).then((places) => {
        if (!stale) setResults(places);
      }).catch((reason: unknown) => {
        if (!stale && !(reason instanceof DOMException && reason.name === "AbortError")) {
          setResults([]);
          setSearchError(reason instanceof Error ? reason.message : "Location search failed");
        }
      }).finally(() => { if (!stale) setSearching(false); });
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, token]);

  function chooseResult(place: Place) {
    const position: [number, number] = [place.latitude, place.longitude];
    setPoint({ latitude: place.latitude, longitude: place.longitude });
    setQuery("");
    setResults([]);
    map.current?.flyTo(position, 17, { duration: 0.5 });
    void import("leaflet").then((L) => {
      if (!map.current) return;
      if (marker.current) marker.current.setLatLng(position);
      else marker.current = L.marker(position).addTo(map.current);
    });
  }

  return (
    <div className="map-picker-backdrop" role="presentation">
      <section className="map-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="map-picker-title">
        <div className="map-picker-heading">
          <div>
            <h2 id="map-picker-title"><span className="map-picker-pin" aria-hidden="true">⌖</span>Choose {purpose} on map</h2>
            <p>Search for a place or move the pin to the exact point.</p>
          </div>
          <button type="button" className="map-picker-close" onClick={onCancel} aria-label="Close map">×</button>
        </div>
        <div className="map-picker-search">
          <label className="search-input-wrap">
            <span aria-hidden="true">⌕</span>
            <input aria-label={`Search ${purpose} location`} role="combobox" aria-autocomplete="list" aria-expanded={query.trim().length >= 3} aria-controls="map-place-results" value={query} onChange={(event) => { const value = event.target.value; setQuery(value); setResults([]); setSearching(value.trim().length >= 3); setSearchError(""); }} placeholder={`Search ${purpose}, street, or landmark`} autoComplete="off" />
            {query && <button type="button" aria-label="Clear map search" onClick={() => { setQuery(""); setResults([]); setSearching(false); setSearchError(""); }}>×</button>}
          </label>
          {query.trim().length >= 3 && <div className="map-picker-results" id="map-place-results" role="listbox" aria-label="Map search results">
            {searching ? <p className="suggestion-hint" role="status">Searching places…</p> : searchError ? <p className="suggestion-hint" role="status">{searchError}</p> : results.length ? results.map((place) => <button type="button" role="option" aria-selected={point?.latitude === place.latitude && point.longitude === place.longitude} className="place-result" key={`${place.latitude}-${place.longitude}`} onClick={() => chooseResult(place)}><span className="suggestion-pin" aria-hidden="true">⌖</span><span>{place.label}</span><b aria-hidden="true">↗</b></button>) : <p className="suggestion-hint" role="status">No matches. Try a nearby street or landmark.</p>}
          </div>}
        </div>
        <div className="map-picker-canvas" ref={host} />
        <div className="map-picker-actions">
          <small>{point ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` : "Select a point on the map"}</small>
          <div>
            <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
            <button type="button" className="next-button" disabled={!point} onClick={() => point && onConfirm(point)}>Use this {purpose}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
