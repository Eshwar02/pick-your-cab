"use client";

import { useEffect, useRef, useState } from "react";

export type Place = { label: string; latitude: number; longitude: number };

type RideMapProps = {
  pickup: Place;
  destination: Place;
  path: [number, number][];
  mode: string;
  token: string;
  driver?: { latitude: number | null; longitude: number | null } | null;
  searching?: boolean;
  cancelled?: boolean;
};
type NearbyDriver = { id: number; name: string; car: string; plate: string; ride_type: string; rating: number | null; latitude: number; longitude: number; distance_km: number };

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const vehicleIcons: Record<string, string> = {
  auto: '<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M18 2 30 9v18l-12 7L6 27V9z" fill="#f1c533" stroke="#28313a" stroke-width="2.5" stroke-linejoin="round"/><path d="M11 13h14v9H11z" fill="#fff" stroke="#28313a" stroke-width="1.7"/><path d="M13 8h10M13 27h10" stroke="#28313a" stroke-width="2" stroke-linecap="round"/><circle cx="5" cy="13" r="2" fill="#28313a"/><circle cx="31" cy="13" r="2" fill="#28313a"/><circle cx="5" cy="24" r="2" fill="#28313a"/><circle cx="31" cy="24" r="2" fill="#28313a"/></svg>',
  bike: '<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="6" r="4" fill="#28313a"/><circle cx="18" cy="30" r="4" fill="#28313a"/><path d="M18 10v6l-5 5 5 5M18 16l6 4-6 4" fill="none" stroke="#f1c533" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 10v6l-5 5 5 5M18 16l6 4-6 4" fill="none" stroke="#28313a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cab: '<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M11 3h14l5 6v18l-5 6H11l-5-6V9z" fill="#f1c533" stroke="#28313a" stroke-width="2.5" stroke-linejoin="round"/><path d="M10 11h16v6H10zM10 21h16v6H10z" fill="#d8eff7" stroke="#28313a" stroke-width="1.7"/><path d="M11 3h14" stroke="#28313a" stroke-width="2"/></svg>',
  maxi_cab: '<svg viewBox="0 0 36 36" aria-hidden="true"><rect x="8" y="2" width="20" height="32" rx="6" fill="#f1c533" stroke="#28313a" stroke-width="2.5"/><path d="M11 7h14v7H11zM11 17h14v8H11z" fill="#d8eff7" stroke="#28313a" stroke-width="1.6"/><path d="M12 29h12" stroke="#28313a" stroke-width="2" stroke-linecap="round"/></svg>',
};
function distanceFromPickupKm(pickup: Place, position: [number, number]) {
  const radians = Math.PI / 180;
  const latitudeDelta = (position[0] - pickup.latitude) * radians;
  const longitudeDelta = (position[1] - pickup.longitude) * radians;
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(pickup.latitude * radians) * Math.cos(position[0] * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function formatDistance(distanceKm: number) {
  return distanceKm < 1 ? `${Math.max(10, Math.round(distanceKm * 1000 / 10) * 10)} m` : `${distanceKm.toFixed(1)} km`;
}

export default function RideMap({ pickup, destination, path, token, driver, mode, searching = false, cancelled = false }: RideMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const pickupMarker = useRef<import("leaflet").Marker | null>(null);
  const destinationMarker = useRef<import("leaflet").Marker | null>(null);
  const driverMarker = useRef<import("leaflet").Marker | null>(null);
  const nearbyDriverMarkers = useRef<Map<number, import("leaflet").Marker>>(new Map());
  const routeLine = useRef<import("leaflet").Polyline | null>(null);
  const routeFlowLine = useRef<import("leaflet").Polyline | null>(null);
  const [nearbyDrivers, setNearbyDrivers] = useState<NearbyDriver[]>([]);
  const searchCenter = useRef<[number, number] | null>(null);
  const initialPickup = useRef(pickup);
  const initialDestination = useRef(destination);

  useEffect(() => {
    let disposed = false;
    let activeMap: import("leaflet").Map | undefined;
    void import("leaflet").then((L) => {
      if (!host.current || disposed) return;
      activeMap = L.map(host.current, { zoomControl: true, scrollWheelZoom: true }).setView([initialPickup.current.latitude, initialPickup.current.longitude], 13);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(activeMap);
      map.current = activeMap;
      pickupMarker.current = L.marker([initialPickup.current.latitude, initialPickup.current.longitude], { icon: L.divIcon({ className: "zoomo-leaflet-icon pickup-leaflet-icon", html: "<span>●</span>", iconSize: [28, 28], iconAnchor: [14, 23] }) }).addTo(activeMap);
      destinationMarker.current = L.marker([initialDestination.current.latitude, initialDestination.current.longitude], { icon: L.divIcon({ className: "zoomo-leaflet-icon destination-leaflet-icon", html: "<span>◆</span>", iconSize: [28, 28], iconAnchor: [14, 23] }) }).addTo(activeMap);
      window.setTimeout(() => activeMap?.invalidateSize(), 50);
    });
    return () => {
      disposed = true;
      activeMap?.remove();
      map.current = null;
      pickupMarker.current = null;
      destinationMarker.current = null;
      driverMarker.current = null;
      nearbyDriverMarkers.current.clear();
      routeLine.current = null;
      routeFlowLine.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!searching) {
      queueMicrotask(() => { if (active) setNearbyDrivers([]); });
      return () => { active = false; };
    }
    const params = new URLSearchParams({ latitude: String(pickup.latitude), longitude: String(pickup.longitude) });
    const loadNearbyDrivers = () => {
      void fetch(`${API}/api/drivers/nearby?${params}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          const body = await response.json().catch(() => []);
          if (!response.ok) throw new Error("Nearby drivers unavailable");
          return body as NearbyDriver[];
        })
        .then((drivers) => { if (active) setNearbyDrivers(drivers); })
        .catch(() => {});
    };
    loadNearbyDrivers();
    const timer = window.setInterval(loadNearbyDrivers, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pickup.latitude, pickup.longitude, searching, token]);

  useEffect(() => {
    let disposed = false;
    void import("leaflet").then((L) => {
      if (disposed || !map.current) return;
      pickupMarker.current?.setLatLng([pickup.latitude, pickup.longitude]);
      destinationMarker.current?.setLatLng([destination.latitude, destination.longitude]);
      if (!cancelled && path.length > 1) {
        if (routeLine.current) routeLine.current.setLatLngs(path);
        else routeLine.current = L.polyline(path, { color: "#1685f8", weight: 7, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map.current!);
        if (routeFlowLine.current) routeFlowLine.current.setLatLngs(path);
        else routeFlowLine.current = L.polyline(path, { className: "ride-route-flow-line", color: "#fff", weight: 3, opacity: 0.98, dashArray: "9 15", dashOffset: "0", lineCap: "round", lineJoin: "round", interactive: false }).addTo(map.current!);
      } else {
        routeLine.current?.remove(); routeLine.current = null;
        routeFlowLine.current?.remove(); routeFlowLine.current = null;
      }
      if (cancelled) {
        destinationMarker.current?.remove(); destinationMarker.current = null;
        driverMarker.current?.remove(); driverMarker.current = null;
      } else if (driver?.latitude != null && driver.longitude != null) {
        if (!driverMarker.current) {
          const vehicle = vehicleIcons[mode] ?? vehicleIcons.cab;
          driverMarker.current = L.marker([driver.latitude, driver.longitude], { icon: L.divIcon({ className: "zoomo-leaflet-icon driver-leaflet-icon", html: `<span aria-label="${mode} vehicle">${vehicle}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] }) }).addTo(map.current!);
        } else {
          driverMarker.current.setLatLng([driver.latitude, driver.longitude]);
        }
      }
      if (searching && driver?.latitude == null && !cancelled) {
        const visibleIds = new Set<number>();
        nearbyDrivers.forEach((nearbyDriver) => {
          visibleIds.add(nearbyDriver.id);
          const position: [number, number] = [nearbyDriver.latitude, nearbyDriver.longitude];
          const icon = vehicleIcons[nearbyDriver.ride_type] ?? vehicleIcons.cab;
          const detail = document.createElement("div");
          detail.textContent = `${nearbyDriver.name} · ${nearbyDriver.car} · ${formatDistance(distanceFromPickupKm(pickup, position))} from pickup`;
          let marker = nearbyDriverMarkers.current.get(nearbyDriver.id);
          if (!marker) {
            marker = L.marker(position, { icon: L.divIcon({ className: "zoomo-leaflet-icon driver-leaflet-icon", html: `<span aria-label="${nearbyDriver.ride_type} vehicle">${icon}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] }) })
              .addTo(map.current!)
              .bindTooltip(detail, { direction: "top", offset: [0, -14] });
            nearbyDriverMarkers.current.set(nearbyDriver.id, marker);
          } else {
            marker.setLatLng(position);
            marker.setTooltipContent(detail);
          }
        });
        nearbyDriverMarkers.current.forEach((marker, id) => {
          if (!visibleIds.has(id)) { marker.remove(); nearbyDriverMarkers.current.delete(id); }
        });
      } else {
        nearbyDriverMarkers.current.forEach((marker) => marker.remove());
        nearbyDriverMarkers.current.clear();
      }
      const points: [number, number][] = [...path, [pickup.latitude, pickup.longitude], [destination.latitude, destination.longitude]];
      if (driver?.latitude != null && driver.longitude != null) points.push([driver.latitude, driver.longitude]);
      if (cancelled) {
        map.current!.setView([pickup.latitude, pickup.longitude], 16, { animate: true, duration: 0.55 });
        searchCenter.current = null;
      } else if (searching && driver?.latitude == null) {
        const previous = searchCenter.current;
        if (!previous || previous[0] !== pickup.latitude || previous[1] !== pickup.longitude) {
          map.current!.setView([pickup.latitude, pickup.longitude], 15, { animate: true, duration: 0.55 });
          searchCenter.current = [pickup.latitude, pickup.longitude];
        }
      } else {
        searchCenter.current = null;
        map.current!.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15, animate: true, duration: 0.55 });
      }
    });
    return () => { disposed = true; };
  }, [pickup, destination, pickup.latitude, pickup.longitude, destination.latitude, destination.longitude, path, nearbyDrivers, driver?.latitude, driver?.longitude, mode, searching, cancelled]);

  return <div className="ride-map" ref={host} aria-label="OpenStreetMap route map">{searching && <div className="nearby-driver-banner" role="status"><span className="nearby-driver-pulse" />Searching nearby drivers</div>}</div>;
}
