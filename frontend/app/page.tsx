"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Brand } from "./components/brand";
import { LoadingScreen } from "./components/loading-screen";
import { clearSession, readSessionToken, readSessionUser, saveSession } from "./lib/session";

const LocationSelectionMap = dynamic(() => import("./components/location-selection-map"), { ssr: false });
const RideMap = dynamic(() => import("./components/ride-map"), { ssr: false });
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const EMPTY_MAP_PATH: [number, number][] = [];
type Place = { label: string; latitude: number; longitude: number; address?: Record<string, string | number>; geocoding_source?: string };
type User = { id: number; name: string; email: string; role: "rider" | "driver" };
type Mode = { id: string; name: string; description: string; icon: string; seats: number; fare_paise: number };
type Ride = { id: number; pickup: string; destination: string; ride_type: string; status: string; distance_km: number; duration_min: number; fare_paise: number; discount_paise?: number; promo_code?: string | null; payment_status: string; reviewed: boolean; created_at?: string; pickup_latitude?: number | null; pickup_longitude?: number | null; destination_latitude?: number | null; destination_longitude?: number | null; otp?: string | null; driver: null | { name: string; car: string; plate: string; rating: number | null; rating_count: number; latitude: number | null; longitude: number | null } };
type Route = { distance_km: number; duration_min: number; path: [number, number][]; modes?: Mode[] };

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api<T>(path: string, token?: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.detail || "Request failed. Check API connection.", response.status);
  return body as T;
}
const fmt = (paise: number) => `₹${Math.round(paise / 100)}`;
function placeDetails(place: Place | null | undefined) {
  if (!place?.address) return "";
  const address = place.address;
  const street = [address.house_number, address.road].filter(Boolean).join(" ");
  const parts = [street, address.neighbourhood, address.suburb, address.city_district, address.village, address.town, address.city, address.county, address.state_district, address.state, address.postcode, address.country]
    .filter((part): part is string | number => Boolean(part))
    .map(String);
  return [...new Set(parts)].join(" · ");
}

export default function Home() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
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
  const [mapPreview, setMapPreview] = useState<Place | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [approachPath, setApproachPath] = useState<[number, number][] | null>(null);
  const lastApproachFetch = useRef(0);
  const [selectedMode, setSelectedMode] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promoMessage, setPromoMessage] = useState("");
  const [promoOffer, setPromoOffer] = useState<{ percent_off: number; max_discount_paise: number } | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletTransactions, setWalletTransactions] = useState<{ id: number; ride_id: number | null; amount_paise: number; kind: string; created_at: string }[]>([]);
  const [walletAmount, setWalletAmount] = useState("500");
  const [ride, setRide] = useState<Ride | null>(null);
  const [history, setHistory] = useState<Ride[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState<"all" | "completed" | "cancelled">("all");
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState<number[]>([]);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState("");
  const [driverRides, setDriverRides] = useState<Ride[]>([]);
  const [availability, setAvailability] = useState(true);
  const [driverRating, setDriverRating] = useState<{ rating: number | null; rating_count: number }>({ rating: null, rating_count: 0 });
  const [otpInput, setOtpInput] = useState("");
  const [error, setError] = useState("");
  const [paymentNotice, setPaymentNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"ride" | "history" | "driver" | "wallet">("ride");

  const loadAccountDetails = useCallback(async (account: User, authToken: string): Promise<boolean> => {
    if (account.role === "rider") {
      const [rides] = await Promise.allSettled([api<Ride[]>("/api/rides", authToken)]);
      if (rides.status === "fulfilled") setHistory(rides.value);
      return rides.status === "rejected";
    }
    const [rides, profile] = await Promise.allSettled([
      api<Ride[]>("/api/drivers/rides", authToken),
      api<{ available: boolean; rating: number | null; rating_count: number }>("/api/drivers/me", authToken),
    ]);
    if (rides.status === "fulfilled") setDriverRides(rides.value);
    if (profile.status === "fulfilled") {
      setAvailability(profile.value.available);
      setDriverRating({ rating: profile.value.rating, rating_count: profile.value.rating_count });
    }
    return rides.status === "rejected" || profile.status === "rejected";
  }, []);

  useEffect(() => {
    const saved = readSessionToken();
    if (!saved) return;
    const cachedUser = readSessionUser();
    let active = true;
    queueMicrotask(() => { if (active) setSessionLoading(true); });
    void (async () => {
      try {
        const current = await api<User>("/api/auth/me", saved);
        const detailsFailed = await loadAccountDetails(current, saved);
        if (!active) return;
        saveSession(saved, current);
        setToken(saved); setUser(current); setView(current.role === "driver" ? "driver" : "ride");
        if (detailsFailed) setError("Some account details could not load. Refresh to try again.");
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 401) {
          clearSession(); setAuthError("Your saved session ended. Sign in to continue.");
        } else if (cachedUser) {
          setToken(saved); setUser(cachedUser);
          setError("Connection unavailable. Showing your saved account.");
        } else {
          setAuthError(reason instanceof Error ? reason.message : "Could not load your account.");
        }
      } finally {
        if (active) setSessionLoading(false);
      }
    })();
    return () => { active = false; };
  }, [loadAccountDetails]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    queueMicrotask(() => {
      if (params.get("view") === "history") setView("history");
      if (payment === "success") setPaymentNotice("Payment submitted. Ride history will update after Stripe confirms it.");
      if (payment === "cancelled") setPaymentNotice("Payment cancelled. You can retry from ride history.");
    });
    if (payment || params.has("view")) {
      params.delete("payment"); params.delete("session_id"); params.delete("ride_id"); params.delete("view");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }, []);

  const loadCurrentLocation = useCallback(() => {
    setError("");
    if (!navigator.geolocation) { setError("Location unavailable. Search pickup manually."); return; }
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try { const place = await api<Place>(`/api/locations/reverse?latitude=${coords.latitude}&longitude=${coords.longitude}`, token); setPickup(place); setMapPreview(place); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Could not find location"); }
    }, () => setError("Location permission denied. Search pickup manually."), { enableHighAccuracy: true, timeout: 12000 });
  }, [token]);

  useEffect(() => {
    let stale = false;
    if (!token || !["pickup", "destination"].includes(step) || query.trim().length < 3) {
      queueMicrotask(() => { if (!stale) { setResults([]); setSuggestionsLoading(false); } });
      return;
    }
    queueMicrotask(() => { if (!stale) setSuggestionsLoading(true); });
    const timer = window.setTimeout(() => {
      void api<Place[]>(`/api/locations/suggest?q=${encodeURIComponent(query.trim())}`, token)
      .then((places) => { if (!stale) { setResults(places); setMapPreview(places[0] ?? null); } })
      .catch(() => { if (!stale) { setResults([]); setMapPreview(null); } })
        .finally(() => { if (!stale) setSuggestionsLoading(false); });
    }, 400);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [query, step, token]);

  async function choosePlace(place: Place) {
    setError(""); setResults([]); setQuery(""); setMapPreview(place);
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
    setBusy(true); setError("");
    try {
      const place = await api<Place>(`/api/locations/reverse?latitude=${point.latitude}&longitude=${point.longitude}`, token);
      await choosePlace(place);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not resolve this map location"); }
    finally { setBusy(false); }
  }

  function placeSearch(placeholder: string) {
    return <div className="location-search"><div className="search-input-wrap"><span aria-hidden="true">⌕</span><input role="combobox" aria-autocomplete="list" aria-expanded={query.trim().length >= 3} aria-controls="location-suggestions" value={query} onChange={(event) => { setQuery(event.target.value); setMapPreview(null); }} placeholder={placeholder} autoComplete="off" />{query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); setMapPreview(null); }}>×</button>}</div>{query.trim().length >= 3 && <div className="suggestion-list" id="location-suggestions" role="listbox">{suggestionsLoading ? <p className="suggestion-hint">Searching nearby places…</p> : results.length ? results.map((place) => <button role="option" aria-selected="false" className="place-result" key={`${place.latitude}-${place.longitude}`} onClick={() => void choosePlace(place)}><span className="suggestion-pin">⌖</span><span>{place.label}</span><b>↗</b></button>) : <p className="suggestion-hint">No matches. Try a nearby landmark or street.</p>}</div>}</div>;
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault(); setAuthBusy(true); setAuthError("");
    try {
      const result = await api<{ token: string; user: User }>(`/api/auth/${register ? "register" : "login"}`, undefined, { method: "POST", body: JSON.stringify({ name, email, password, role, vehicle, plate, ride_type: driverMode }) });
      saveSession(result.token, result.user);
      if (await loadAccountDetails(result.user, result.token)) {
        setError("Signed in. Some account details could not load; refresh to try again.");
      }
      setToken(result.token); setUser(result.user); setView(result.user.role === "driver" ? "driver" : "ride");
    } catch (reason) { setAuthError(reason instanceof Error ? reason.message : "Authentication failed"); }
    finally { setAuthBusy(false); }
  }

  async function requestRide(mode = selectedMode) {
    if (!pickup || !destination) return;
    setBusy(true); setError("");
    try {
      const created = await api<Ride>("/api/rides", token, { method: "POST", body: JSON.stringify({ pickup: pickup.label, destination: destination.label, ride_type: mode, pickup_latitude: pickup.latitude, pickup_longitude: pickup.longitude, destination_latitude: destination.latitude, destination_longitude: destination.longitude, promo_code: promoCode.trim() || null }) });
      setRide(created); setSelectedMode(mode); setStep("tracking");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Booking failed"); }
    finally { setBusy(false); }
  }

  async function checkPromo() {
    if (!promoCode.trim()) { setPromoMessage("Enter promo code first."); return; }
    try {
      const promo = await api<{ percent_off: number; max_discount_paise: number }>(`/api/promos/${encodeURIComponent(promoCode.trim())}`, token);
      setPromoOffer(promo);
      setPromoMessage(`${promo.percent_off}% off, up to ${fmt(promo.max_discount_paise)}. Discount applies at booking.`);
    } catch (reason) { setPromoOffer(null); setPromoMessage(reason instanceof Error ? reason.message : "Promo code unavailable"); }
  }

  const refreshWallet = useCallback(async () => {
    const wallet = await api<{ balance_paise: number; transactions: typeof walletTransactions }>("/api/wallet", token);
    setWalletBalance(wallet.balance_paise); setWalletTransactions(wallet.transactions);
  }, [token]);

  async function topupWallet() {
    setBusy(true); setError("");
    try {
      const result = await api<{ url: string }>("/api/wallet/topups", token, { method: "POST", body: JSON.stringify({ amount_paise: Math.round(Number(walletAmount) * 100) }) });
      window.location.assign(result.url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Wallet top-up failed"); }
    finally { setBusy(false); }
  }

  async function downloadReceipt(rideId: number) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await fetch(`${API}/api/rides/${rideId}/receipt`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 202) { await new Promise((resolve) => window.setTimeout(resolve, 1000)); continue; }
      if (!response.ok) throw new Error("Receipt unavailable. Try again shortly.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `zoomo-ride-${rideId}-receipt.pdf`; link.click();
      URL.revokeObjectURL(url);
      return;
    }
    throw new Error("Receipt still generating. Try again shortly.");
  }

  const refreshRide = useCallback(async () => {
    const rideId = ride?.id;
    if (rideId && token) { try { setRide(await api<Ride>(`/api/rides/${rideId}`, token)); } catch { /* transient polling error */ } }
  }, [ride?.id, token]);

  useEffect(() => {
    if (!ride?.id || !token) return;
    const timer = window.setInterval(() => { void refreshRide(); }, 4000);
    return () => window.clearInterval(timer);
  }, [ride?.id, token, refreshRide]);

  useEffect(() => {
    const rideId = ride?.id;
    const rideStatus = ride?.status;
    const driverLatitude = ride?.driver?.latitude;
    const driverLongitude = ride?.driver?.longitude;
    if (!rideId || !pickup || driverLatitude == null || driverLongitude == null || !["accepted", "arriving"].includes(rideStatus ?? "")) return;
    if (Date.now() - lastApproachFetch.current < 12000) return;
    lastApproachFetch.current = Date.now();
    const params = new URLSearchParams({ origin_latitude: String(driverLatitude), origin_longitude: String(driverLongitude), destination_latitude: String(pickup.latitude), destination_longitude: String(pickup.longitude) });
    void api<Route>(`/api/route?${params}`, token).then((result) => setApproachPath(result.path)).catch(() => {});
  }, [ride?.id, ride?.status, ride?.driver?.latitude, ride?.driver?.longitude, pickup, token]);

  useEffect(() => {
    if (!token || !user) return;
    if (view === "history") {
      let stale = false;
      queueMicrotask(() => { if (!stale) setHistoryLoading(true); });
      void api<Ride[]>("/api/rides", token).then((items) => { if (!stale) setHistory(items); }).catch((reason: Error) => { if (!stale) setError(reason.message); }).finally(() => { if (!stale) setHistoryLoading(false); });
      return () => { stale = true; };
    }
    if (view === "driver") {
      const load = () => void api<Ride[]>("/api/drivers/rides", token).then(setDriverRides).catch((reason: Error) => setError(reason.message));
      load(); const timer = window.setInterval(load, 4000);
      void api<{ available: boolean; rating: number | null; rating_count: number }>("/api/drivers/me", token).then((data) => { setAvailability(data.available); setDriverRating({ rating: data.rating, rating_count: data.rating_count }); }).catch(() => {});
      return () => window.clearInterval(timer);
    }
  }, [token, user, view]);

  useEffect(() => {
    if (view !== "wallet" || !token) return;
    let active = true;
    queueMicrotask(() => { if (active) void refreshWallet().catch((reason: Error) => setError(reason.message)); });
    return () => { active = false; };
  }, [view, token, refreshWallet]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("wallet") === "success" && token) queueMicrotask(() => { void refreshWallet().catch(() => {}); });
  }, [token, refreshWallet]);

  useEffect(() => {
    if (!ride?.id || !token) return;
    let active = true;
    let socket: WebSocket | null = null;
    void api<{ ticket: string }>(`/api/rides/${ride.id}/ws-ticket`, token, { method: "POST" }).then(({ ticket }) => {
      if (!active) return;
      socket = new WebSocket(API.replace(/^http/, "ws") + `/ws/rides/${ride.id}?ticket=${encodeURIComponent(ticket)}`);
      socket.onmessage = () => { void refreshRide(); };
    }).catch(() => {});
    return () => { active = false; socket?.close(); };
  }, [ride?.id, token, refreshRide]);

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

  function payRide(rideId: number) {
    router.push(`/payment?ride_id=${rideId}`);
  }

  async function repeatRide(item: Ride) {
    if (item.pickup_latitude == null || item.pickup_longitude == null || item.destination_latitude == null || item.destination_longitude == null) {
      setError("This older trip has no saved map points. Search locations to book it again.");
      return;
    }
    setBusy(true); setError("");
    const nextPickup = { label: item.pickup, latitude: item.pickup_latitude, longitude: item.pickup_longitude };
    const nextDestination = { label: item.destination, latitude: item.destination_latitude, longitude: item.destination_longitude };
    const params = new URLSearchParams({ origin_latitude: String(nextPickup.latitude), origin_longitude: String(nextPickup.longitude), destination_latitude: String(nextDestination.latitude), destination_longitude: String(nextDestination.longitude) });
    try {
      const estimate = await api<Route>(`/api/rides/estimate?${params}`, token);
      setPickup(nextPickup); setDestination(nextDestination); setRoute(estimate);
      setSelectedMode(estimate.modes?.some((mode) => mode.id === item.ride_type) ? item.ride_type : estimate.modes?.[0]?.id ?? "");
      setStep("modes"); setView("ride");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not estimate this trip"); }
    finally { setBusy(false); }
  }

  async function cancelRide() {
    if (!ride) return;
    setBusy(true);
    try {
      setRide(await api<Ride>(`/api/rides/${ride.id}/cancel`, token, { method: "POST" }));
      setApproachPath(null);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not cancel ride"); }
    finally { setBusy(false); }
  }

  async function submitReview(rideId: number) {
    try {
      await api(`/api/rides/${rideId}/review`, token, { method: "POST", body: JSON.stringify({ rating: reviewRating, comment: reviewComment }) });
      setReviewed((items) => [...items, rideId]); setReviewing(null); setReviewComment("");
      setRide((item) => item?.id === rideId ? { ...item, reviewed: true } : item);
      setHistory((items) => items.map((item) => item.id === rideId ? { ...item, reviewed: true } : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review failed"); }
  }

  function logout() {
    if (token) void api("/api/auth/logout", token, { method: "POST" }).catch(() => {});
    clearSession();
    setToken(""); setUser(null); setRide(null); setHistory([]); setDriverRides([]); setHistoryQuery(""); setHistoryFilter("all"); setPickup(null); setDestination(null); setStep("pickup"); setView("ride");
  }

  if (!user) return <main className="auth-gate">
    <div className="auth-card" aria-hidden={authBusy || sessionLoading} inert={authBusy || sessionLoading}>
      <Brand /><span className="section-kicker">YOUR CITY, YOUR RIDE</span><h1>{register ? "Create your account" : "Welcome back"}</h1><p>Sign in to book rides. No guest access.</p>
      <form onSubmit={submitAuth}>
        {register && <><label>Name<input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></label><label>Account type<select value={role} onChange={(e) => setRole(e.target.value as "rider" | "driver")}><option value="rider">Rider</option><option value="driver">Driver</option></select></label>{role === "driver" && <><label>Vehicle<input required value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Vehicle model" /></label><label>Plate number<input required value={plate} onChange={(e) => setPlate(e.target.value)} /></label><label>Ride category<select value={driverMode} onChange={(e) => setDriverMode(e.target.value)}>{["auto", "bike", "cab", "maxi_cab"].map((mode) => <option key={mode} value={mode}>{mode.replace("_", " ")}</option>)}</select></label></>}</>}
        <label>Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Password<input required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>{authError && <p className="form-error" role="alert">{authError}</p>}<button className="book-button" disabled={authBusy || sessionLoading}>{authBusy || sessionLoading ? "Loading your account…" : register ? "Create account" : "Sign in"}</button>
      </form>
      <button className="text-button" disabled={authBusy || sessionLoading} onClick={() => { setRegister(!register); setAuthError(""); }}>{register ? "Have account? Sign in" : "New here? Create account"}</button>
    </div>
    {(authBusy || sessionLoading) && <LoadingScreen message={sessionLoading ? "Loading your account…" : register ? "Creating your account…" : "Signing you in…"} />}
  </main>;

  const modes = route?.modes ?? [];
  const statuses: Record<string, string> = { requested: "Finding a nearby driver", accepted: "Driver accepted your ride", arriving: "Driver is on the way", arrived: "Driver arrived · share OTP", in_progress: "Ride in progress", completed: "Ride completed", cancelled: "Ride cancelled" };
  const visibleHistory = history.filter((item) => (historyFilter === "all" || item.status === historyFilter) && `${item.pickup} ${item.destination} ${item.ride_type}`.toLowerCase().includes(historyQuery.trim().toLowerCase()));
  return <main className={`app-shell ${view === "ride" && user.role === "rider" && ["pickup", "destination", "modes", "tracking"].includes(step) ? "booking-screen" : ""}`}>
    <header className="topbar"><Brand /><nav><button className={view === "ride" ? "active" : ""} onClick={() => setView("ride")}>Book ride</button>{user.role === "rider" ? <><button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>History</button><button className={view === "wallet" ? "active" : ""} onClick={() => setView("wallet")}>Wallet</button></> : <button onClick={() => setView("driver")}>Driver</button>}</nav><div className="profile-button">{user.name}<button onClick={logout}>Sign out</button></div></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {paymentNotice && <p className="payment-notice" role="status">{paymentNotice}</p>}
    {view === "ride" && user.role === "rider" && <>
      {step !== "tracking" && <section className="hero"><div><span className="eyebrow">YOUR CITY, YOUR RIDE</span><h1>Good trips start <em>here.</em></h1><p>Clear routes. Real drivers. Upfront fares.</p></div></section>}
      {(["pickup", "destination"].includes(step) || (step === "modes" && Boolean(route))) && <section className="location-layout">
        <div key={step} className={`flow-card location-flow location-step-panel ${step === "modes" ? "mode-flow" : ""}`}>
          {step === "pickup" && <><span className="section-kicker">STEP 1 OF 3 · PICKUP</span><h2>Where should we pick you up?</h2><p>Search an address or click the map to place your pickup pin.</p><button className="location-current-button" onClick={loadCurrentLocation}>◎ Use my current location</button>{pickup && <div className="selected-place">✓ <span>{pickup.label}{placeDetails(pickup) && <small className="address-detail">{placeDetails(pickup)}</small>}</span></div>}{placeSearch("Search pickup, street, or landmark")}{pickup && <button className="book-button location-continue" onClick={() => { setStep("destination"); setQuery(""); setResults([]); setMapPreview(null); }}>Continue to drop-off →</button>}</>}
          {step === "destination" && <><span className="section-kicker">STEP 2 OF 3 · DROP-OFF</span><h2>Where are you going?</h2><p>Search a destination or click the map to move the drop-off pin.</p><div className="selected-place pickup-summary">● <span>{pickup?.label}{placeDetails(pickup) && <small className="address-detail">{placeDetails(pickup)}</small>}</span><button onClick={() => { setStep("pickup"); setQuery(""); setResults([]); setMapPreview(pickup); }}>Change pickup</button></div>{destination && <div className="selected-place">◆ <span>{destination.label}{placeDetails(destination) && <small className="address-detail">{placeDetails(destination)}</small>}</span></div>}{placeSearch("Search destination, street, or landmark")}{destination && <button className="book-button location-continue" disabled={busy} onClick={() => void choosePlace(destination)}>{busy ? "Checking route…" : "Confirm drop-off →"}</button>}</>}
          {step === "modes" && route && <><span className="section-kicker">STEP 3 OF 3 · CHOOSE RIDE</span><h2>Pick your ride</h2><p>{route.distance_km} km · about {route.duration_min} min</p><div className="selected-place pickup-summary">● <span>{pickup?.label}{placeDetails(pickup) && <small className="address-detail">{placeDetails(pickup)}</small>}</span><span>→</span>◆ <span>{destination?.label}{placeDetails(destination) && <small className="address-detail">{placeDetails(destination)}</small>}</span></div><div className="mode-list">{modes.map((mode) => { const due = promoOffer && promoCode.trim() ? mode.fare_paise - Math.min(Math.floor(mode.fare_paise * promoOffer.percent_off / 100), promoOffer.max_discount_paise) : mode.fare_paise; return <button key={mode.id} className={`mode-option ${selectedMode === mode.id ? "selected" : ""}`} onClick={() => setSelectedMode(mode.id)}><span className="mode-icon">{mode.icon}</span><span><strong>{mode.name}</strong><small>{mode.description} · {mode.seats} seats</small></span><b>{fmt(due)}</b></button>; })}</div><label className="wallet-promo">Promo code<input value={promoCode} onChange={(event) => { setPromoCode(event.target.value.toUpperCase()); setPromoMessage(""); setPromoOffer(null); }} placeholder="WELCOME10" maxLength={40} /></label><button className="text-button" onClick={() => void checkPromo()}>Check code</button>{promoMessage && <p role="status">{promoMessage}</p>}{selectedMode && <button className="book-button" disabled={busy} onClick={() => void requestRide()}>{busy ? "Requesting…" : `Request ${modes.find((mode) => mode.id === selectedMode)?.name}`}</button>}<button className="text-button" onClick={() => { setStep("destination"); setRoute(null); }}>← Change destination</button></>}
        </div>
        <section className="selection-map-panel" aria-label={step === "modes" ? "Route preview" : `Select ${step === "pickup" ? "pickup" : "drop-off"} location`}>
          <div key={step} className="selection-map-heading"><div><span className="section-kicker">{step === "modes" ? "ROUTE PREVIEW" : "LIVE MAP"}</span><strong>{step === "modes" ? "Pickup to drop-off" : `Choose ${step === "pickup" ? "pickup" : "drop-off"} point`}</strong></div><span className="map-picker-pin" aria-hidden="true">⌖</span></div>
          <LocationSelectionMap activeStep={step === "pickup" ? "pickup" : "destination"} pickup={pickup} destination={destination} preview={step === "modes" ? null : mapPreview} path={step === "modes" ? route?.path : undefined} interactive={step !== "modes"} onSelect={(point) => void confirmMapPoint(point)} />
        </section>
      </section>}
      {step === "tracking" && ride && pickup && destination && <section className="tracking"><div className="track-info"><span className="section-kicker">RIDE #{ride.id} · {ride.ride_type.replace("_", " ").toUpperCase()}</span><h2>{statuses[ride.status] ?? ride.status}</h2><p>{pickup.label} → {destination.label}</p>{ride.driver && <><p><strong>{ride.driver.name}</strong> · {ride.driver.car} · {ride.driver.plate}{ride.driver.rating_count > 0 && <> · ★ {ride.driver.rating?.toFixed(1)} ({ride.driver.rating_count})</>}</p>{ride.driver.latitude == null && <p className="gps-hint">Waiting for driver’s GPS signal…</p>}</>}{ride.status === "arrived" && <div className="otp-display"><small>Share this 4-digit OTP with driver</small><strong>{ride.otp ?? "····"}</strong></div>}{ride.status === "requested" && <p className="gps-hint">Vehicle appears on map when a driver accepts.</p>}<p>{fmt(ride.fare_paise)} · {ride.distance_km} km · {ride.duration_min} min</p>{ride.status === "completed" && <><div className="ride-review"><h3>Rate your driver</h3>{ride.reviewed || reviewed.includes(ride.id) ? <p>Thanks for rating this ride.</p> : reviewing === ride.id ? <div className="review-inline"><select aria-label="Driver rating" value={reviewRating} onChange={(e) => setReviewRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={rating}>{"★".repeat(rating)} ({rating})</option>)}</select><input aria-label="Review comment" placeholder="Share a few words" value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} /><button onClick={() => void submitReview(ride.id)}>Submit review</button></div> : <button className="next-button" onClick={() => setReviewing(ride.id)}>Leave a review</button>}</div>{ride.payment_status !== 'paid' ? <button className="book-button" onClick={() => payRide(ride.id)}>Pay fare · {fmt(ride.fare_paise)}</button> : <p className="payment-success-copy">Payment status: {ride.payment_status.replaceAll("_", " ")}</p>}</>}{["requested", "accepted", "arriving"].includes(ride.status) && <button className="text-button" disabled={busy} onClick={() => void cancelRide()}>Cancel ride</button>}{["completed", "cancelled"].includes(ride.status) && <button className="next-button" onClick={() => { setRide(null); setStep("pickup"); setDestination(null); setRoute(null); setApproachPath(null); }}>Book another ride</button>}</div><RideMap pickup={pickup} destination={destination} path={ride.status === "cancelled" ? EMPTY_MAP_PATH : ((["accepted", "arriving"].includes(ride.status) && approachPath) || route?.path || [[pickup.latitude, pickup.longitude], [destination.latitude, destination.longitude]])} token={token} driver={ride.driver} mode={ride.ride_type} searching={ride.status === "requested"} cancelled={ride.status === "cancelled"} /><small className="map-credit">© OpenStreetMap contributors</small></section>}
    </>}
    {view === "history" && <section className="data-panel history-panel">
      <div className="history-title"><div><span className="section-kicker">YOUR JOURNEYS</span><h2>Ride history</h2><p>Find a past trip, review it, or book the route again.</p></div><button className="history-refresh" disabled={historyLoading} onClick={() => { setHistoryLoading(true); void api<Ride[]>("/api/rides", token).then(setHistory).catch((reason: Error) => setError(reason.message)).finally(() => setHistoryLoading(false)); }}>{historyLoading ? "Refreshing…" : "↻ Refresh"}</button></div>
      <div className="history-stats"><article><small>Total trips</small><strong>{history.length}</strong></article><article><small>Completed</small><strong>{history.filter((item) => item.status === "completed").length}</strong></article><article><small>Paid</small><strong>{fmt(history.filter((item) => item.payment_status === "paid").reduce((sum, item) => sum + item.fare_paise, 0))}</strong></article></div>
      <div className="history-tools"><label className="history-search"><span aria-hidden="true">⌕</span><input aria-label="Search ride history" placeholder="Search pickup or destination" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} />{historyQuery && <button aria-label="Clear history search" onClick={() => setHistoryQuery("")}>×</button>}</label><div className="history-filters" aria-label="Filter ride history">{(["all", "completed", "cancelled"] as const).map((filter) => <button key={filter} className={historyFilter === filter ? "selected" : ""} aria-pressed={historyFilter === filter} onClick={() => setHistoryFilter(filter)}>{filter === "all" ? "All trips" : filter === "completed" ? "Completed" : "Cancelled"}</button>)}</div></div>
      {historyLoading && !history.length ? <div className="history-empty" aria-live="polite"><span className="history-loader" aria-hidden="true" />Loading your trips…</div> : visibleHistory.length ? <div className="history-list">{visibleHistory.map((item) => <article className="history-card" key={item.id}>
        <div className="history-route-icon" aria-hidden="true">↗</div><div className="history-route"><strong>{item.pickup}<span>→</span>{item.destination}</strong><small>{item.created_at ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at)) : `Ride #${item.id}`} · {item.ride_type.replaceAll("_", " ")}</small></div><span className={`history-status status-${item.status}`}>{item.status.replaceAll("_", " ")}</span><strong className="history-fare">{fmt(item.fare_paise)}</strong>
        <div className="history-actions">{item.status === "completed" && item.payment_status !== "paid" && <><button onClick={() => payRide(item.id)}>Pay by card</button><button onClick={async () => { try { await api(`/api/wallet/pay/${item.id}`, token, { method: "POST" }); await refreshWallet(); setHistory(await api<Ride[]>("/api/rides", token)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Wallet payment failed"); } }}>Pay by wallet</button></>}{item.status === "completed" && item.payment_status === "paid" && <button onClick={() => { void downloadReceipt(item.id).catch((reason: Error) => setError(reason.message)); }}>Receipt PDF</button>}{item.status === "completed" && !item.reviewed && !reviewed.includes(item.id) && (reviewing === item.id ? <span className="review-inline"><select aria-label="Driver rating" value={reviewRating} onChange={(e) => setReviewRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={rating}>{rating} stars</option>)}</select><input aria-label="Review comment" placeholder="Review" value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} /><button onClick={() => void submitReview(item.id)}>Send</button></span> : <button onClick={() => setReviewing(item.id)}>Rate ride</button>)}{item.pickup_latitude != null && item.pickup_longitude != null && item.destination_latitude != null && item.destination_longitude != null ? <button className="repeat-ride" disabled={busy} onClick={() => void repeatRide(item)}>Book again <span aria-hidden="true">↗</span></button> : <span className="history-no-map">Map points unavailable</span>}</div>
      </article>)}</div> : <div className="history-empty"><span aria-hidden="true">⌕</span><strong>{history.length ? "No matching trips" : "Your next ride starts here"}</strong><p>{history.length ? "Try another place or filter." : "Your completed and upcoming trips will appear here."}</p>{history.length > 0 && (historyQuery || historyFilter !== "all") && <button onClick={() => { setHistoryQuery(""); setHistoryFilter("all"); }}>Clear filters</button>}</div>}
    </section>}
    {view === "wallet" && user.role === "rider" && <section className="data-panel"><span className="section-kicker">ZOOMO WALLET</span><h2>Wallet balance</h2><p className="wallet-balance">{walletBalance == null ? "Loading…" : fmt(walletBalance)}</p><label className="wallet-promo">Add funds (₹)<input type="number" min="100" max="50000" step="1" value={walletAmount} onChange={(event) => setWalletAmount(event.target.value)} /></label><button className="book-button" disabled={busy || !walletAmount || Number(walletAmount) < 100} onClick={() => void topupWallet()}>{busy ? "Opening Stripe…" : "Add funds with Stripe"}</button><p>Wallet top-ups confirm through Stripe webhook. Ride payments debit balance and create receipt.</p><h3>Recent activity</h3>{walletTransactions.length ? walletTransactions.map((transaction) => <article className="history-row" key={transaction.id}><div><strong>{transaction.kind === "topup" ? "Wallet top-up" : `Ride #${transaction.ride_id} payment`}</strong><small>{new Date(transaction.created_at).toLocaleString()}</small></div><b>{fmt(Math.abs(transaction.amount_paise))}{transaction.amount_paise < 0 ? " debited" : " added"}</b></article>) : <p>No wallet activity yet.</p>}</section>}
    {view === "driver" && user.role === "driver" && <section className="flow-card"><span className="section-kicker">DRIVER SPACE</span><div className="driver-heading"><h2>Ride requests</h2><button className="next-button" onClick={async () => { const result = await api<{ available: boolean }>(`/api/drivers/availability?available=${!availability}`, token, { method: "PATCH" }); setAvailability(result.available); }}>{availability ? "● Available" : "○ Offline"}</button></div><p className="driver-rating">{driverRating.rating_count ? <>Your rating: <strong>★ {driverRating.rating?.toFixed(1)}</strong> from {driverRating.rating_count} ride{driverRating.rating_count === 1 ? "" : "s"}</> : "No ratings yet. Your rider reviews will appear here."}</p><p>Keep location enabled to share live position while online.</p>{driverRides.map((item) => <article className="driver-ride" key={item.id}><strong>{item.pickup} → {item.destination}</strong><small>#{item.id} · {item.ride_type} · {item.status} · {fmt(item.fare_paise)}</small>{item.status === "requested" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "accepted" })}>Accept ride</button>}{item.status === "accepted" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "arriving" })}>On the way</button>}{item.status === "arriving" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "arrived" })}>I’ve arrived</button>}{item.status === "arrived" && <form className="search-form" onSubmit={(e) => { e.preventDefault(); void verifyOtp(item.id); }}><input required pattern="[0-9]{4}" maxLength={4} value={otpInput} onChange={(e) => setOtpInput(e.target.value)} placeholder="Rider OTP" /><button disabled={busy}>Verify & start</button></form>}{item.status === "in_progress" && <button onClick={() => void driverAction(`/api/rides/${item.id}/status`, { status: "completed" })}>Complete ride</button>}</article>)}{!driverRides.length && <p>No matching rides yet.</p>}</section>}
    <footer className="footer">Zoomo · Routes via OSRM · OpenStreetMap</footer>
  </main>;
}
