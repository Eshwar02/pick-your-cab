"use client";

import { useEffect, useRef, useState } from "react";

export type MapPlace = { label: string; latitude: number; longitude: number };

export default function LocationSelectionMap({
  activeStep,
  pickup,
  destination,
  preview,
  path,
  interactive = true,
  onSelect,
}: {
  activeStep: "pickup" | "destination";
  pickup: MapPlace | null;
  destination: MapPlace | null;
  preview: MapPlace | null;
  path?: [number, number][];
  interactive?: boolean;
  onSelect: (point: { latitude: number; longitude: number }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const pickupMarker = useRef<import("leaflet").Marker | null>(null);
  const destinationMarker = useRef<import("leaflet").Marker | null>(null);
  const previewMarker = useRef<import("leaflet").Marker | null>(null);
  const routeLine = useRef<import("leaflet").Polyline | null>(null);
  const routeFlowLine = useRef<import("leaflet").Polyline | null>(null);
  const selectionCallback = useRef(onSelect);
  const currentPlaces = useRef({ activeStep, pickup, destination, preview, interactive });
  const [hovering, setHovering] = useState(false);

  useEffect(() => { selectionCallback.current = onSelect; }, [onSelect]);
  useEffect(() => { currentPlaces.current = { activeStep, pickup, destination, preview, interactive }; }, [activeStep, pickup, destination, preview, interactive]);

  useEffect(() => {
    let disposed = false;
    let activeMap: import("leaflet").Map | null = null;
    void import("leaflet").then((L) => {
      if (!host.current || disposed) return;
      const { activeStep: step, pickup: currentPickup, destination: currentDestination, preview: currentPreview } = currentPlaces.current;
      const focus = currentPreview ?? (step === "pickup" ? currentPickup : currentDestination) ?? currentPickup ?? currentDestination;
      const center: [number, number] = focus ? [focus.latitude, focus.longitude] : [12.9716, 77.5946];
      activeMap = L.map(host.current, { zoomControl: true, scrollWheelZoom: true }).setView(center, focus ? 15 : 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(activeMap);
      map.current = activeMap;
      activeMap.on("click", (event: import("leaflet").LeafletMouseEvent) => {
        if (!currentPlaces.current.interactive) return;
        const symbol = currentPlaces.current.activeStep === "pickup" ? "●" : "◆";
        const iconClass = currentPlaces.current.activeStep === "pickup" ? "selection-pickup-icon" : "selection-drop-icon";
        const icon = L.divIcon({ className: `zoomo-leaflet-icon ${iconClass}`, html: `<span aria-hidden="true">${symbol}</span>`, iconSize: [36, 42], iconAnchor: [18, 37] });
        if (previewMarker.current) previewMarker.current.setLatLng(event.latlng).setIcon(icon);
        else previewMarker.current = L.marker(event.latlng, { icon }).addTo(activeMap!);
        previewMarker.current.bindTooltip("Resolving address…", { direction: "top", offset: [0, -34], permanent: true });
        selectionCallback.current({ latitude: event.latlng.lat, longitude: event.latlng.lng });
      });
      window.setTimeout(() => activeMap?.invalidateSize(), 80);
    });
    return () => {
      disposed = true;
      activeMap?.remove();
      map.current = null;
      pickupMarker.current = null;
      destinationMarker.current = null;
      previewMarker.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void import("leaflet").then((L) => {
      const currentMap = map.current;
      if (disposed || !currentMap) return;

      const syncMarker = (ref: { current: import("leaflet").Marker | null }, place: MapPlace | null, kind: "pickup" | "drop" | "preview") => {
        if (!place) {
          ref.current?.remove();
          ref.current = null;
          return;
        }
        const position: [number, number] = [place.latitude, place.longitude];
        if (ref.current) ref.current.setLatLng(position);
        else {
          const symbol = kind === "pickup" ? "●" : kind === "drop" ? "◆" : "⌖";
          const className = `zoomo-leaflet-icon selection-${kind}-icon`;
          ref.current = L.marker(position, { icon: L.divIcon({ className, html: `<span aria-hidden="true">${symbol}</span>`, iconSize: [36, 42], iconAnchor: [18, 37] }) }).addTo(currentMap);
        }
        ref.current.bindTooltip(place.label, { direction: "top", offset: [0, -34] });
      };

      syncMarker(pickupMarker, pickup, "pickup");
      syncMarker(destinationMarker, destination, "drop");
      syncMarker(previewMarker, preview, "preview");
      if (path && path.length > 1) {
        if (routeLine.current) routeLine.current.setLatLngs(path);
        else routeLine.current = L.polyline(path, { color: "#1685f8", weight: 7, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(currentMap);
        if (routeFlowLine.current) routeFlowLine.current.setLatLngs(path);
        else routeFlowLine.current = L.polyline(path, { className: "route-flow-line", color: "#fff", weight: 3, opacity: 0.98, dashArray: "9 15", dashOffset: "0", lineCap: "round", lineJoin: "round", interactive: false }).addTo(currentMap);
        const boundsPoints: [number, number][] = [...path];
        if (pickup) boundsPoints.push([pickup.latitude, pickup.longitude]);
        if (destination) boundsPoints.push([destination.latitude, destination.longitude]);
        currentMap.fitBounds(L.latLngBounds(boundsPoints), { padding: [70, 70], maxZoom: 15, animate: true, duration: 0.55 });
      } else if (routeLine.current) {
        routeLine.current.remove();
        routeLine.current = null;
        routeFlowLine.current?.remove();
        routeFlowLine.current = null;
      }
      if (preview) currentMap.flyTo([preview.latitude, preview.longitude], Math.max(currentMap.getZoom(), 16), { duration: 0.45 });
    });
    return () => { disposed = true; };
  }, [pickup, destination, preview, path]);

  return (
    <div className="selection-map-wrap" onMouseEnter={() => interactive && setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <div className="selection-map-canvas" ref={host} aria-label={interactive ? "Map. Click to choose the active location." : "Map showing selected route."} />
      {interactive && hovering && <div className="map-hover-hint" role="status"><span aria-hidden="true">⌖</span>Select {activeStep === "pickup" ? "pickup" : "drop-off"} location on map</div>}
      <div className="selection-map-legend"><span><i className="legend-pickup" />Pickup</span><span><i className="legend-drop" />Drop-off</span><small>{interactive ? "Click map to move active pin" : "Estimated route"}</small></div>
    </div>
  );
}
