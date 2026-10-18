"use client";

import { useEffect, useRef, useState } from "react";

type Point = { latitude: number; longitude: number };

export default function MapPicker({
  initialPoint,
  onConfirm,
  onCancel,
}: {
  initialPoint?: Point | null;
  onConfirm: (point: Point) => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const marker = useRef<import("leaflet").Marker | null>(null);
  const [point, setPoint] = useState<Point | null>(null);

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
      if (initialPoint) {
        setPoint(initialPoint);
        marker.current = L.marker(center).addTo(pickerMap);
      }
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

  return (
    <div className="map-picker-backdrop" role="presentation">
      <section className="map-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="map-picker-title">
        <div className="map-picker-heading">
          <div>
            <h2 id="map-picker-title">Choose location on map</h2>
            <p>Click the map to place your pin.</p>
          </div>
          <button type="button" className="map-picker-close" onClick={onCancel} aria-label="Close map">×</button>
        </div>
        <div className="map-picker-canvas" ref={host} />
        <div className="map-picker-actions">
          <small>{point ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` : "Select a point on the map"}</small>
          <div>
            <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
            <button type="button" className="next-button" disabled={!point} onClick={() => point && onConfirm(point)}>Use this location</button>
          </div>
        </div>
      </section>
    </div>
  );
}
