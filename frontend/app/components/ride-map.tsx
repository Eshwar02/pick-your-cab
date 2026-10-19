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
const vehicleLabels: Record<string, string> = { auto: "Auto", bike: "Bike", cab: "Cab", maxi_cab: "Maxi cab" };
const tamilDriverNames = ["அருண்", "கார்த்திக்", "மீனா", "சரவணன்", "காவ்யா", "பிரபு", "திவ்யா", "விஜய்", "லதா", "முருகன்", "நந்தினி", "ரமேஷ்", "யாழினி", "செல்வம்", "அனிதா", "மணிகண்டன்", "பிரியா", "சுரேஷ்", "கீர்த்தனா", "பாலா"];
const mockVehicles = Array.from({ length: 20 }, (_, index) => ({
  name: tamilDriverNames[index],
  mode: (["auto", "bike", "cab", "maxi_cab"] as const)[index % 4],
  // Stable per-vehicle values keep the demo fleet spread out after every render.
  angle: index * 2.399963 + ((index * 37) % 19) / 19,
  radius: 120 + ((index * 173) % 590),
  phase: ((index * 47) % 360) * Math.PI / 180,
  cycleSeconds: 38 + (index * 17) % 43,
  orbit: 28 + (index * 23) % 48,
}));

function nearbyVehiclePosition(pickup: Place, vehicle: (typeof mockVehicles)[number], elapsedSeconds: number): [number, number] {
  // Give each demo driver a distinct nearby starting point, then move it on its
  // own short loop instead of marching every icon along the rider's route.
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.max(0.2, Math.cos(pickup.latitude * Math.PI / 180));
  const cycle = elapsedSeconds / vehicle.cycleSeconds * Math.PI * 2 + vehicle.phase;
  const driftEast = Math.sin(cycle) * vehicle.orbit + Math.sin(cycle * 0.43) * vehicle.orbit * 0.28;
  const driftNorth = Math.cos(cycle * 0.79) * vehicle.orbit * 0.72;
  const distanceEast = Math.cos(vehicle.angle) * vehicle.radius + driftEast;
  const distanceNorth = Math.sin(vehicle.angle) * vehicle.radius + driftNorth;
  return [pickup.latitude + distanceNorth / latitudeScale, pickup.longitude + distanceEast / longitudeScale];
}

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
        if (mockDriverMarkers.current.length !== mockVehicles.length) {
          mockDriverMarkers.current.forEach((marker) => marker.remove());
          mockDriverMarkers.current = mockVehicles.map((vehicle) => {
            const latLng = nearbyVehiclePosition(pickup, vehicle, 0);
            const icon = vehicleIcons[vehicle.mode];
            return L.marker(latLng, { icon: L.divIcon({ className: "zoomo-leaflet-icon mock-vehicle-icon", html: `<span aria-label="Nearby ${vehicleLabels[vehicle.mode]}">${icon}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] }) })
              .addTo(map.current!)
              .bindTooltip(`${vehicle.name} · ${vehicleLabels[vehicle.mode]} · ${formatDistance(distanceFromPickupKm(pickup, latLng))} from pickup`, { direction: "top", offset: [0, -14] });
          });
        }
        const startedAt = Date.now();
        const moveVehicles = () => {
          const elapsed = (Date.now() - startedAt) / 1000;
          mockVehicles.forEach((vehicle, index) => {
            const position = nearbyVehiclePosition(pickup, vehicle, elapsed);
            const marker = mockDriverMarkers.current[index];
            marker?.setLatLng(position);
            marker?.setTooltipContent(`${vehicle.name} · ${vehicleLabels[vehicle.mode]} · ${formatDistance(distanceFromPickupKm(pickup, position))} from pickup`);
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

  return <div className="ride-map" ref={host} aria-label="OpenStreetMap route map">{searching && <div className="mock-driver-banner" role="status"><span className="mock-driver-pulse" />Finding your driver · 20 nearby drivers</div>}</div>;
}
