"use client";

import { useEffect, useRef } from "react";

export type Place = { label: string; latitude: number; longitude: number };

type RideMapProps = {
  pickup: Place;
  destination: Place;
  path: [number, number][];
  mode: string;
  driver?: { latitude: number | null; longitude: number | null } | null;
};

const vehicleIcons: Record<string, string> = { auto: "🛺", bike: "🏍️", cab: "🚕", maxi_cab: "🚐" };

export default function RideMap({ pickup, destination, path, driver, mode }: RideMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const pickupMarker = useRef<import("leaflet").Marker | null>(null);
  const destinationMarker = useRef<import("leaflet").Marker | null>(null);
  const driverMarker = useRef<import("leaflet").Marker | null>(null);
  const routeLine = useRef<import("leaflet").Polyline | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeMap: import("leaflet").Map | undefined;
    void import("leaflet").then((L) => {
      if (!host.current || disposed) return;
      activeMap = L.map(host.current, { zoomControl: true, scrollWheelZoom: true }).setView([pickup.latitude, pickup.longitude], 13);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(activeMap);
      map.current = activeMap;
      pickupMarker.current = L.marker([pickup.latitude, pickup.longitude], { icon: L.divIcon({ className: "cabby-leaflet-icon pickup-leaflet-icon", html: "<span>●</span>", iconSize: [28, 28], iconAnchor: [14, 23] }) }).addTo(activeMap);
      destinationMarker.current = L.marker([destination.latitude, destination.longitude], { icon: L.divIcon({ className: "cabby-leaflet-icon destination-leaflet-icon", html: "<span>◆</span>", iconSize: [28, 28], iconAnchor: [14, 23] }) }).addTo(activeMap);
      window.setTimeout(() => activeMap?.invalidateSize(), 50);
    });
    return () => {
      disposed = true;
      activeMap?.remove();
      map.current = null;
      pickupMarker.current = null;
      destinationMarker.current = null;
      driverMarker.current = null;
      routeLine.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void import("leaflet").then((L) => {
      if (disposed || !map.current) return;
      pickupMarker.current?.setLatLng([pickup.latitude, pickup.longitude]);
      destinationMarker.current?.setLatLng([destination.latitude, destination.longitude]);
      if (routeLine.current) routeLine.current.setLatLngs(path);
      else routeLine.current = L.polyline(path, { color: "#28684d", weight: 5, opacity: 0.86, lineCap: "round" }).addTo(map.current!);
      if (driver?.latitude != null && driver.longitude != null) {
        if (!driverMarker.current) {
          const vehicle = vehicleIcons[mode] ?? vehicleIcons.cab;
          driverMarker.current = L.marker([driver.latitude, driver.longitude], { icon: L.divIcon({ className: "cabby-leaflet-icon driver-leaflet-icon", html: `<span aria-label="${mode} vehicle">${vehicle}</span>`, iconSize: [46, 46], iconAnchor: [23, 23] }) }).addTo(map.current!);
        } else {
          driverMarker.current.setLatLng([driver.latitude, driver.longitude]);
        }
      }
      const points: [number, number][] = [...path, [pickup.latitude, pickup.longitude], [destination.latitude, destination.longitude]];
      if (driver?.latitude != null && driver.longitude != null) points.push([driver.latitude, driver.longitude]);
      map.current!.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
    });
    return () => { disposed = true; };
  }, [pickup, destination, path, driver?.latitude, driver?.longitude]);

  return <div className="ride-map" ref={host} aria-label="OpenStreetMap route map" />;
}
