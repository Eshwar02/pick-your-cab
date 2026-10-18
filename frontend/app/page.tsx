"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const MapPicker = dynamic(() => import("./components/map-picker"), { ssr: false });
const RideMap = dynamic(() => import("./components/ride-map"), { ssr: false });
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
type Place = { label: string; latitude: number; longitude: number };
type User = { id: number; name: string; email: string; role: "rider" | "driver" };
type Mode = { id: string; name: string; description: string; icon: string; seats: number; fare_paise: number };
type Ride = { id: number; pickup: string; destination: string; ride_type: string; status: string; distance_km: number; duration_min: number; fare_paise: number; payment_status: string; otp?: string | null; driver: null | { name: string; car: string; plate: string; latitude: number | null; longitude: number | null } };
type Route = { distance_km: number; duration_min: number; path: [number, number][]; modes?: Mode[] };

async function api<T>(path: string, token?: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Request failed. Check API connection.");
  return body as T;
}
const fmt = (paise: number) => `₹${Math.round(paise / 100)}`;

export default function Home() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [register, setRegister] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"rider" | "driver">("rider");
  const [vehicle, setVehicle] = useState("");
  const [plate, setPlate] = useState("");
  const [driverMode, setDriverMode] = useState("auto");
  const [step, setStep] = useState<"pickup" | "destination" | "modes" | "tracking">("pickup");
  const [pickup, setPickup] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [approachPath, setApproachPath] = useState<[number, number][] | null>(null);
  const lastApproachFetch = useRef(0);
  const [selectedMode, setSelectedMode] = useState("");
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [ride, setRide] = useState<Ride | null>(null);
  const [history, setHistory] = useState<Ride[]>([]);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState<number[]>([]);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState("");
  const [driverRides, setDriverRides] = useState<Ride[]>([]);
  const [availability, setAvailability] = useState(true);
  const [otpInput, setOtpInput] = useState("");
  const [error, setError] = useState("");
  const [paymentNotice, setPaymentNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"ride" | "history" | "driver">("ride");

  useEffect(() => {
    const saved = localStorage.getItem("cabby_token");
    if (!saved) { setSessionReady(true); return; }
    setToken(saved);
    api<User>("/api/auth/me", saved).then(setUser).catch(() => { localStorage.removeItem("cabby_token"); setToken(""); }).finally(() => setSessionReady(true));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    if (payment === "success") setPaymentNotice("Payment submitted. Ride history will update after Stripe confirms it.");
    if (payment === "cancelled") setPaymentNotice("Payment cancelled. You can retry from ride history.");
    if (payment) {
      params.delete("payment"); params.delete("session_id"); params.delete("ride_id");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }, []);

  const loadCurrentLocation = useCallback(() => {
    setError("");
    if (!navigator.geolocation) { setError("Location unavailable. Search pickup manually."); return; }
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try { setPickup(await api<Place>(`/api/locations/reverse?latitude=${coords.latitude}&longitude=${coords.longitude}`, token)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Could not find location"); }
    }, () => setError("Location permission denied. Search pickup manually."), { enableHighAccuracy: true, timeout: 12000 });
  }, [token]);

  useEffect(() => {
    let stale = false;
    if (!token || !["pickup", "destination"].includes(step) || query.trim().length < 3) {
      setResults([]); setSuggestionsLoading(false);
      return;
    }
    setSuggestionsLoading(true);
    const timer = window.setTimeout(() => {
      void api<Place[]>(`/api/locations/suggest?q=${encodeURIComponent(query.trim())}`, token)
        .then((places) => { if (!stale) setResults(places); })
        .catch(() => { if (!stale) setResults([]); })
        .finally(() => { if (!stale) setSuggestionsLoading(false); });
    }, 400);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [query, step, token]);

  async function choosePlace(place: Place) {
    setError(""); setResults([]); setQuery("");
    if (step === "pickup") { setPickup(place); return; }
    setDestination(place); setBusy(true);
    try {
      if (!pickup) throw new Error("Choose pickup first");
      const params = new URLSearchParams({ origin_latitude: String(pickup.latitude), origin_longitude: String(pickup.longitude), destination_latitude: String(place.latitude), destination_longitude: String(place.longitude) });
      const estimate = await api<Route>(`/api/rides/estimate?${params}`, token);
      setRoute(estimate); setStep("modes");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not estimate ride"); }
    finally { setBusy(false); }
  }

  async function confirmMapPoint(point: { latitude: number; longitude: number }) {
    setMapPickerOpen(false); setBusy(true); setError("");
    try {
      const place = await api<Place>(`/api/locations/reverse?latitude=${point.latitude}&longitude=${point.longitude}`, token);
      await choosePlace(place);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not resolve this map location"); }
    finally { setBusy(false); }
  }

  function placeSearch(placeholder: string) {
    return <div className="location-search"><div className="search-input-wrap"><span aria-hidden="true">⌕</span><input role="combobox" aria-autocomplete="list" aria-expanded={query.trim().length >= 3} aria-controls="location-suggestions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} autoComplete="off" />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}</div>{query.trim().length >= 3 && <div className="suggestion-list" id="location-suggestions" role="listbox">{suggestionsLoading ? <p className="suggestion-hint">Searching nearby places…</p> : results.length ? results.map((place) => <button role="option" aria-selected="false" className="place-result" key={`${place.latitude}-${place.longitude}`} onClick={() => void choosePlace(place)}><span className="suggestion-pin">⌖</span><span>{place.label}</span><b>↗</b></button>) : <p className="suggestion-hint">No matches. Try a nearby landmark or street.</p>}</div>}</div>;
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault(); setAuthBusy(true); setAuthError("");
    try {
      const result = await api<{ token: string; user: User }>(`/api/auth/${register ? "register" : "login"}`, undefined, { method: "POST", body: JSON.stringify({ name, email, password, role, vehicle, plate, ride_type: driverMode }) });
      localStorage.setItem("cabby_token", result.token); setToken(result.token); setUser(result.user);
    } catch (reason) { setAuthError(reason instanceof Error ? reason.message : "Authentication failed"); }
    finally { setAuthBusy(false); }
  }

  async function requestRide(mode = selectedMode) {
    if (!pickup || !destination) return;
    setBusy(true); setError("");
    try {
      const created = await api<Ride>("/api/rides", token, { method: "POST", body: JSON.stringify({ pickup: pickup.label, destination: destination.label, ride_type: mode, pickup_latitude: pickup.latitude, pickup_longitude: pickup.longitude, destination_latitude: destination.latitude, destination_longitude: destination.longitude }) });
      setRide(created); setSelectedMode(mode); setStep("tracking");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Booking failed"); }
    finally { setBusy(false); }
  }

  const refreshRide = useCallback(async () => {
    if (ride && token) { try { setRide(await api<Ride>(`/api/rides/${ride.id}`, token)); } catch { /* transient polling error */ } }
  }, [ride?.id, token]);

  useEffect(() => {
    if (!ride || !token) return;
    const timer = window.setInterval(() => { void refreshRide(); }, 4000);
    return () => window.clearInterval(timer);
  }, [ride?.id, token, refreshRide]);

  useEffect(() => {
    const driver = ride?.driver;
    if (!ride || !pickup || !driver || driver.latitude == null || driver.longitude == null || !["accepted", "arriving"].includes(ride.status)) return;
    if (Date.now() - lastApproachFetch.current < 12000) return;
    lastApproachFetch.current = Date.now();
    const params = new URLSearchParams({ origin_latitude: String(driver.latitude), origin_longitude: String(driver.longitude), destination_latitude: String(pickup.latitude), destination_longitude: String(pickup.longitude) });
    void api<Route>(`/api/route?${params}`, token).then((result) => setApproachPath(result.path)).catch(() => {});
  }, [ride?.status, ride?.driver?.latitude, ride?.driver?.longitude, pickup, token]);

  useEffect(() => {
    if (!token || !user) return;
    if (view === "history") void api<Ride[]>("/api/rides", token).then(setHistory).catch((reason: Error) => setError(reason.message));
    if (view === "driver") {
      const load = () => void api<Ride[]>("/api/drivers/rides", token).then(setDriverRides).catch((reason: Error) => setError(reason.message));
      load(); const timer = window.setInterval(load, 4000);
      void api<{ available: boolean }>("/api/drivers/me", token).then((data) => setAvailability(data.available)).catch(() => {});
      return () => window.clearInterval(timer);
    }
  }, [token, user, view]);

  useEffect(() => {
    if (user?.role !== "driver" || view !== "driver" || !availability || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(({ coords }) => {
      void api("/api/drivers/location", token, { method: "PATCH", body: JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude }) }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 4000 });
    return () => navigator.geolocation.clearWatch(watch);
  }, [user, view, availability, token]);

  async function driverAction(path: string, body?: object) {
    setBusy(true); setError("");
    try { await api(path, token, { method: "PATCH", ...(body ? { body: JSON.stringify(body) } : {}) }); await api<Ride[]>("/api/drivers/rides", token).then(setDriverRides); if (ride) void refreshRide(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed"); }
    finally { setBusy(false); }
  }

  async function verifyOtp(rideId: number) {
    setBusy(true); setError("");
    try { await api(`/api/rides/${rideId}/verify-otp`, token, { method: "POST", body: JSON.stringify({ otp: otpInput }) }); setOtpInput(""); await api<Ride[]>("/api/drivers/rides", token).then(setDriverRides); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "OTP verification failed"); }
    finally { setBusy(false); }
  }

  async function payRide(rideId: number) {
    setError("");
    try {
      const result = await api<{ url?: string }>(`/api/rides/${rideId}/payment-intent`, token, { method: "POST" });
      if (result.url) window.location.assign(result.url);
      else setHistory((items) => items.map((item) => item.id === rideId ? { ...item, payment_status: "demo_paid" } : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Payment failed"); }
  }

  async function cancelRide() {
    if (!ride) return;
    setBusy(true);
    try { setRide(await api<Ride>(`/api/rides/${ride.id}/cancel`, token, { method: "POST" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not cancel ride"); }
    finally { setBusy(false); }
  }

  async function submitReview(rideId: number) {
    try {
      await api(`/api/rides/${rideId}/review`, token, { method: "POST", body: JSON.stringify({ rating: reviewRating, comment: reviewComment }) });
      setReviewed((items) => [...items, rideId]); setReviewing(null); setReviewComment("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review failed"); }
  }

  function logout() { localStorage.removeItem("cabby_token"); setToken(""); setUser(null); setRide(null); setPickup(null); setDestination(null); setStep("pickup"); setView("ride"); }

  if (!sessionReady) return <main className="auth-gate"><div className="auth-card" role="status">Checking your account…</div></main>;
  if (!user) return <main className="auth-gate"><div className="auth-card"><a className="brand" href="#">✳ cabby</a><span className="section-kicker">YOUR CITY, YOUR RIDE</span><h1>{register ? "Create your account" : "Welcome back"}</h1><p>Sign in to book rides. No guest access.</p><form onSubmit={submitAuth}>
    {register && <><label>Name<input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></label><label>Account type<select value={role} onChange={(e) => setRole(e.target.value as "rider" | "driver")}><option value="rider">Rider</option><option value="driver">Driver</option></select></label>{role === "driver" && <><label>Vehicle<input required value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Vehicle model" /></label><label>Plate number<input required value={plate} onChange={(e) => setPlate(e.target.value)} /></label><label>Ride category<select value={driverMode} onChange={(e) => setDriverMode(e.target.value)}>{["auto", "bike", "cab", "maxi_cab"].map((mode) => <option key={mode} value={mode}>{mode.replace("_", " ")}</option>)}</select></label></>}</>}
    <label>Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Password<input required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>{authError && <p className="form-error">{authError}</p>}<button className="book-button" disabled={authBusy}>{authBusy ? "Please wait…" : register ? "Create account" : "Sign in"}</button></form><button className="text-button" onClick={() => { setRegister(!register); setAuthError(""); }}>{register ? "Have account? Sign in" : "New here? Create account"}</button></div></main>;

  const modes = route?.modes ?? [];
  const statuses: Record<string, string> = { requested: "Finding a nearby driver", accepted: "Driver accepted your ride", arriving: "Driver is on the way", arrived: "Driver arrived · share OTP", in_progress: "Ride in progress", completed: "Ride completed", cancelled: "Ride cancelled" };
  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#">✳ cabby</a><nav><button className={view === "ride" ? "active" : ""} onClick={() => setView("ride")}>Book ride</button>{user.role === "rider" ? <button onClick={() => setView("history")}>History</button> : <button onClick={() => setView("driver")}>Driver</button>}</nav><div className="profile-button">{user.name}<button onClick={logout}>Sign out</button></div></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {paymentNotice && <p className="payment-notice" role="status">{paymentNotice}</p>}
    {view === "ride" && user.role === "rider" && <>
      {step !== "tracking" && <section className="hero"><div><span className="eyebrow">YOUR CITY, YOUR RIDE</span><h1>Good trips start <em>here.</em></h1><p>Clear routes. Real drivers. Upfront fares.</p></div></section>}
      {step === "pickup" && <section className="flow-card"><span className="section-kicker">STEP 1 OF 3 · PICKUP</span><h2>Where should we pick you up?</h2><p>Allow location access or search for your current location.</p><button className="book-button" onClick={loadCurrentLocation}>◎ Use my current location</button><button className="map-pick-action" onClick={() => setMapPickerOpen(true)}>⌖ Choose pickup on map</button>{pickup && <div className="selected-place">✓ {pickup.label}<button onClick={() => setStep("destination")}>Continue →</button></div>}{placeSearch("Search pickup, street, or landmark")}{pickup && <button className="next-button" onClick={() => { setStep("destination"); setQuery(""); setResults([]); }}>Confirm pickup →</button>}</section>}
      {step === "destination" && <section className="flow-card"><span className="section-kicker">STEP 2 OF 3 · DESTINATION</span><h2>Where are you going?</h2><p>Pickup: {pickup?.label}</p><button className="map-pick-action" onClick={() => setMapPickerOpen(true)}>⌖ Choose destination on map</button>{placeSearch("Search destination, street, or landmark")}<button className="text-button" onClick={() => setStep("pickup")}>← Change pickup</button></section>}
      {step === "modes" && route && <section className="flow-card"><span className="section-kicker">STEP 3 OF 3 · CHOOSE RIDE</span><h2>Pick your ride</h2><p>{route.distance_km} km · about {route.duration_min} min</p><div className="mode-list">{modes.map((mode) => <button key={mode.id} className={`mode-option ${selectedMode === mode.id ? "selected" : ""}`} onClick={() => setSelectedMode(mode.id)}><span className="mode-icon">{mode.icon}</span><span><strong>{mode.name}</strong><small>{mode.description} · {mode.seats} seats</small></span><b>{fmt(mode.fare_paise)}</b></button>)}</div>{selectedMode && <button className="book-button" disabled={busy} onClick={() => void requestRide()}>{busy ? "Requesting…" : `Request ${modes.find((mode) => mode.id === selectedMode)?.name}`}</button>}<button className="text-button" onClick={() => { setStep("destination"); setRoute(null); }}>← Change destination</button></section>}
      {step === "tracking" && ride && pickup && destination && <section className="tracking"><div className="track-info"><span className="section-kicker">RIDE #{ride.id} · {ride.ride_type.replace("_", " ").toUpperCase()}</span><h2>{statuses[ride.status] ?? ride.status}</h2><p>{pickup.label} → {destination.label}</p>{ride.driver && <><p><strong>{ride.driver.name}</strong> · {ride.driver.car} · {ride.driver.plate}</p>{ride.driver.latitude == null && <p className="gps-hint">Waiting for driver’s GPS signal…</p>}</>}{ride.status === "arrived" && <div className="otp-display"><small>Share this 4-digit OTP with driver</small><strong>{ride.otp ?? "····"}</strong></div>}{ride.status === "requested" && <p className="gps-hint">Vehicle appears on map when a driver accepts.</p>}<p>{fmt(ride.fare_paise)} · {ride.distance_km} km · {ride.duration_min} min</p>{["requested", "accepted", "arriving"].includes(ride.status) && <button className="text-button" disabled={busy} onClick={() => void cancelRide()}>Cancel ride</button>}{["completed", "cancelled"].includes(ride.status) && <button className="next-button" onClick={() => { setRide(null); setStep("pickup"); setDestination(null); setRoute(null); setApproachPath(null); }}>Book another ride</button>}</div><RideMap pickup={pickup} destination={destination} path={(["accepted", "arriving"].includes(ride.status) && approachPath) || route?.path || [[pickup.latitude, pickup.longitude], [destination.latitude, destination.longitude]]} driver={ride.driver} mode={ride.ride_type} /><small className="map-credit">© OpenStreetMap contributors</small></section>}
    </>}
    {view === "history" && <section className="flow-card"><span className="section-kicker">YOUR JOURNEYS</span><h2>Ride history</h2>{history.map((item) => <article className="history-row" key={item.id}><div><strong>{item.pickup} → {item.destination}</strong><small>#{item.id} · {item.ride_type} · {item.status} · {item.payment_status}</small></div><b>{fmt(item.fare_paise)}</b>{item.status === "completed" && !["paid", "demo_paid"].includes(item.payment_status) && <button onClick={() => void payRide(item.id)}>Pay fare</button>}{item.status === "completed" && !reviewed.includes(item.id) && (reviewing === item.id ? <span className="review-inline"><select value={reviewRating} onChange={(e) => setReviewRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={rating}>{rating} stars</option>)}</select><input placeholder="Review" value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} /><button onClick={() => void submitReview(item.id)}>Send</button></span> : <button onClick={() => setReviewing(item.id)}>Rate</button>)}</article>)}{!history.length && <p>No rides yet.</p>}</section>}
    {view === "driver" && user.role === "driver" && <section className="flow-card"><span className="section-kicker">DRIVER SPACE</span><div className="driver-heading"><h2>Ride requests</h2><button className="next-button" onClick={async () => { const result = await api<{ available: boolean }>(`/api/drivers/availability?available=${!availability}`, token, { method: "PATCH" }); setAvailability(result.available); }}>{availability ? "● Available" : "○ Offline"}</button></div><p>Keep location enabled to share live position while online.</p>{driverRides.map((item) => <article className="driver-ride" key={item.id}><strong>{item.pickup} → {item.destination}</strong><small>#{item.id} · {item.ride_type} · {item.status} · {fmt(item.fare_paise)}</small>{item.status === "requested" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "accepted" })}>Accept ride</button>}{item.status === "accepted" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "arriving" })}>On the way</button>}{item.status === "arriving" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "arrived" })}>I’ve arrived</button>}{item.status === "arrived" && <form className="search-form" onSubmit={(e) => { e.preventDefault(); void verifyOtp(item.id); }}><input required pattern="[0-9]{4}" maxLength={4} value={otpInput} onChange={(e) => setOtpInput(e.target.value)} placeholder="Rider OTP" /><button disabled={busy}>Verify & start</button></form>}{item.status === "in_progress" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "completed" })}>Complete ride</button>}</article>)}{!driverRides.length && <p>No matching rides yet.</p>}</section>}
    <footer className="footer">Cabby · Routes via OSRM · OpenStreetMap</footer>
    {mapPickerOpen && <MapPicker initialPoint={step === "pickup" ? pickup : destination} onCancel={() => setMapPickerOpen(false)} onConfirm={(point) => void confirmMapPoint(point)} />}
  </main>;
}
