"use client";

import { useEffect, useRef } from "react";

export type Place = { label: string; latitude: number; longitude: number };

type RideMapProps = {
  pickup: Place;
  destination: Place;
  path: [number, number][];
  mode: string;
  driver?: { latitude: number | null; longitude: number | null } | null;
  searching?: boolean;
};

const vehicleIcons: Record<string, string> = { auto: "🛺", bike: "🏍️", cab: "🚕", maxi_cab: "🚐" };
const mockVehicles = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1,
  mode: (["auto", "bike", "cab", "maxi_cab"] as const)[index % 4],
  phase: index / 20,
  cycleSeconds: 150 + (index % 8) * 13,
  eta: 1 + (index % 7),
}));

function pathSampler(path: [number, number][]) {
  const distances = [0];
  for (let index = 1; index < path.length; index += 1) {
    const [lat1, lon1] = path[index - 1];
    const [lat2, lon2] = path[index];
    const latitudeKm = (lat2 - lat1) * 111.32;
    const longitudeKm = (lon2 - lon1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    distances.push(distances[index - 1] + Math.hypot(latitudeKm, longitudeKm));
  }
  const totalKm = distances.at(-1) ?? 0;
  const visibleDistance = Math.min(totalKm, 1.4);
  return (progress: number): [number, number] => {
    if (path.length < 2 || totalKm === 0) return path[0] ?? [13.0827, 80.2707];
    const target = Math.min(totalKm, progress * visibleDistance);
    let segment = 1;
    while (segment < distances.length - 1 && distances[segment] < target) segment += 1;
    const segmentLength = distances[segment] - distances[segment - 1] || 1;
    const fraction = Math.max(0, Math.min(1, (target - distances[segment - 1]) / segmentLength));
    return [
      path[segment - 1][0] + (path[segment][0] - path[segment - 1][0]) * fraction,
      path[segment - 1][1] + (path[segment][1] - path[segment - 1][1]) * fraction,
    ];
  };
}

export default function RideMap({ pickup, destination, path, driver, mode, searching = false }: RideMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const pickupMarker = useRef<import("leaflet").Marker | null>(null);
  const destinationMarker = useRef<import("leaflet").Marker | null>(null);
  const driverMarker = useRef<import("leaflet").Marker | null>(null);
  const mockDriverMarkers = useRef<import("leaflet").Marker[]>([]);
  const routeLine = useRef<import("leaflet").Polyline | null>(null);
  const routeFlowLine = useRef<import("leaflet").Polyline | null>(null);
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
      mockDriverMarkers.current = [];
      routeLine.current = null;
      routeFlowLine.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let motionTimer: number | undefined;
    void import("leaflet").then((L) => {
      if (disposed || !map.current) return;
      pickupMarker.current?.setLatLng([pickup.latitude, pickup.longitude]);
      destinationMarker.current?.setLatLng([destination.latitude, destination.longitude]);
      if (routeLine.current) routeLine.current.setLatLngs(path);
      else routeLine.current = L.polyline(path, { color: "#1685f8", weight: 7, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map.current!);
      if (routeFlowLine.current) routeFlowLine.current.setLatLngs(path);
      else routeFlowLine.current = L.polyline(path, { className: "ride-route-flow-line", color: "#fff", weight: 3, opacity: 0.98, dashArray: "9 15", dashOffset: "0", lineCap: "round", lineJoin: "round", interactive: false }).addTo(map.current!);
      if (driver?.latitude != null && driver.longitude != null) {
        if (!driverMarker.current) {
          const vehicle = vehicleIcons[mode] ?? vehicleIcons.cab;
          driverMarker.current = L.marker([driver.latitude, driver.longitude], { icon: L.divIcon({ className: "zoomo-leaflet-icon driver-leaflet-icon", html: `<span aria-label="${mode} vehicle">${vehicle}</span>`, iconSize: [46, 46], iconAnchor: [23, 23] }) }).addTo(map.current!);
        } else {
          driverMarker.current.setLatLng([driver.latitude, driver.longitude]);
        }
      }
      if (searching && driver?.latitude == null && path.length > 1) {
        const sampleRoad = pathSampler(path);
        if (mockDriverMarkers.current.length !== mockVehicles.length) {
          mockDriverMarkers.current.forEach((marker) => marker.remove());
          mockDriverMarkers.current = mockVehicles.map((vehicle) => {
            const latLng = sampleRoad(vehicle.phase * 0.96);
            const icon = vehicleIcons[vehicle.mode];
            return L.marker(latLng, { icon: L.divIcon({ className: "zoomo-leaflet-icon mock-vehicle-icon", html: `<span aria-label="Simulated ${vehicle.mode.replace("_", " ")}">${icon}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] }) })
              .addTo(map.current!)
              .bindTooltip(`Demo ${vehicle.mode.replace("_", " ")} · Nearby driver ${String(vehicle.id).padStart(2, "0")} · ~${vehicle.eta} min`, { direction: "top", offset: [0, -14] });
          });
        }
        const startedAt = Date.now();
        const moveVehicles = () => {
          const elapsed = (Date.now() - startedAt) / 1000;
          mockVehicles.forEach((vehicle, index) => {
            const cycle = ((elapsed / vehicle.cycleSeconds + vehicle.phase) % 2 + 2) % 2;
            const position = sampleRoad(cycle <= 1 ? cycle : 2 - cycle);
            mockDriverMarkers.current[index]?.setLatLng(position);
          });
        };
        moveVehicles();
        motionTimer = window.setInterval(moveVehicles, 350);
      } else {
        mockDriverMarkers.current.forEach((marker) => marker.remove());
        mockDriverMarkers.current = [];
      }
      const points: [number, number][] = [...path, [pickup.latitude, pickup.longitude], [destination.latitude, destination.longitude]];
      if (driver?.latitude != null && driver.longitude != null) points.push([driver.latitude, driver.longitude]);
      if (searching && driver?.latitude == null) map.current!.setView([pickup.latitude, pickup.longitude], 15, { animate: true, duration: 0.55 });
      else map.current!.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15, animate: true, duration: 0.55 });
    });
    return () => { disposed = true; if (motionTimer) window.clearInterval(motionTimer); };
  }, [pickup, destination, pickup.latitude, pickup.longitude, destination.latitude, destination.longitude, path, driver?.latitude, driver?.longitude, mode, searching]);

  return <div className="ride-map" ref={host} aria-label="OpenStreetMap route map">{searching && <div className="mock-driver-banner" role="status"><span className="mock-driver-pulse" />Finding your driver · 20 nearby demo vehicles</div>}</div>;
}
