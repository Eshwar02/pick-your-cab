"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Brand } from "../components/brand";
import { readSessionToken } from "../lib/session";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
type Ride = { id: number; pickup: string; destination: string; status: string; fare_paise: number; payment_status: string };

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Request failed. Check API connection.");
  return body as T;
}

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

export default function PaymentPage() {
  const [token, setToken] = useState("");
  const [ride, setRide] = useState<Ride | null>(null);
  const [rideId, setRideId] = useState<number | null>(null);
  const [returnStatus, setReturnStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshRide = useCallback(async (authToken: string, id: number) => {
    const latest = await request<Ride>(`/api/rides/${id}`, authToken);
    setRide(latest);
    return latest;
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      const authToken = readSessionToken() || "";
      const params = new URLSearchParams(window.location.search);
      const id = Number(params.get("ride_id"));
      setToken(authToken);
      setReturnStatus(params.get("payment") || "");
      if (!Number.isInteger(id) || id < 1) { setError("Ride not found. Return to Zoomo and open a fare from your ride history."); return; }
      setRideId(id);
      if (!authToken) { setError("Sign in to view and pay for this ride."); return; }
      void refreshRide(authToken, id).catch((reason: Error) => setError(reason.message));
    });
  }, [refreshRide]);

  useEffect(() => {
    if (returnStatus !== "success" || !token || !rideId || ride?.payment_status === "paid") return;
    const timer = window.setInterval(() => {
      void refreshRide(token, rideId).catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [returnStatus, token, rideId, ride?.payment_status, refreshRide]);

  async function startPayment() {
    if (!token || !rideId) return;
    setBusy(true); setError("");
    try {
      const result = await request<{ url?: string; payment_status?: string; mode: string }>(`/api/rides/${rideId}/payment-intent`, token, { method: "POST" });
      if (result.url) { window.location.assign(result.url); return; }
      await refreshRide(token, rideId);
      if (result.mode === "demo") setReturnStatus("demo");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start payment"); }
    finally { setBusy(false); }
  }

  async function checkStatus() {
    if (!token || !rideId) return;
    setBusy(true); setError("");
    try { await refreshRide(token, rideId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh payment status"); }
    finally { setBusy(false); }
  }

  const paid = ride?.payment_status === "paid" || ride?.payment_status === "demo_paid";
  return (
    <main className="auth-gate">
      <section className="payment-card">
        <Brand />
        <span className="section-kicker">SECURE FARE PAYMENT</span>
        <h1>{paid ? "Payment complete" : returnStatus === "cancelled" ? "Payment cancelled" : returnStatus === "success" ? "Confirming payment" : "Ride payment"}</h1>
        {ride && <div className="payment-summary">
          <span>Ride #{ride.id}</span>
          <strong>{ride.pickup} → {ride.destination}</strong>
          <small>Ride status: {ride.status.replaceAll("_", " ")}</small>
          <b>{money(ride.fare_paise)}</b>
          <small>Payment status: {ride.payment_status.replaceAll("_", " ")}</small>
        </div>}
        {paid && <p className="payment-success-copy">Your payment is confirmed. You can return to Zoomo ride history.</p>}
        {returnStatus === "success" && !paid && <p className="payment-help">Stripe returned successfully. Waiting for signed payment confirmation; this page checks status automatically.</p>}
        {returnStatus === "cancelled" && !paid && <p className="payment-help">No charge completed. Retry payment when ready.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {ride?.status !== "completed" && ride && <p className="payment-help">Payment opens after driver marks ride completed.</p>}
        {!paid && ride?.status === "completed" && returnStatus !== "success" && <button className="book-button" disabled={busy} onClick={() => void startPayment()}>{busy ? "Opening secure checkout…" : `Continue to Stripe · ${money(ride.fare_paise)}`}</button>}
        {returnStatus === "success" && !paid && <button className="next-button" disabled={busy} onClick={() => void checkStatus()}>{busy ? "Checking…" : "Check payment status"}</button>}
        <Link className="payment-back" href="/?view=history">Return to Zoomo</Link>
        <p className="payment-secure-note">Card details handled securely by Stripe Checkout.</p>
      </section>
    </main>
  );
}
