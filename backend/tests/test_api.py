from __future__ import annotations

import pytest
import statistics
import time
from concurrent.futures import ThreadPoolExecutor


@pytest.fixture
def client(api_base_url):
    class LocalClient:
        def get(self, url, **kwargs):
            import requests
            return requests.get(f"{api_base_url}{url}", **kwargs)

        def post(self, url, **kwargs):
            if "content" in kwargs:
                kwargs["data"] = kwargs.pop("content")
            import requests
            return requests.post(f"{api_base_url}{url}", **kwargs)

        def patch(self, url, **kwargs):
            import requests
            return requests.patch(f"{api_base_url}{url}", **kwargs)

    return LocalClient()


def register(client, *, email, role="rider", ride_type="cab"):
    payload = {
        "name": "Test User",
        "email": email,
        "password": "correct-horse-battery",
        "role": role,
        "vehicle": "Test car",
        "plate": "TEST123",
        "ride_type": ride_type,
    }
    response = client.post("/api/auth/register", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    return result, {"Authorization": f"Bearer {result['token']}"}


def test_auth_session_survives_validation_and_revokes_on_logout(client):
    result, headers = register(client, email="rider@example.com")
    assert result["user"]["role"] == "rider"
    assert result["token"].split(".")[2] == "0"  # no time-based expiry
    assert client.get("/api/auth/me", headers=headers).json()["email"] == "rider@example.com"

    login = client.post(
        "/api/auth/login",
        json={"email": "rider@example.com", "password": "correct-horse-battery"},
    )
    assert login.status_code == 200
    login_headers = {"Authorization": f"Bearer {login.json()['token']}"}
    assert client.post("/api/auth/logout", headers=login_headers).status_code == 200
    assert client.get("/api/auth/me", headers=login_headers).status_code == 401

    assert client.get("/api/rides").status_code == 401
    assert client.post(
        "/api/auth/login",
        json={"email": "rider@example.com", "password": "wrong-password"},
    ).status_code == 401


def test_complete_ride_lifecycle_and_access_controls(client):
    _, rider_headers = register(client, email="lifecycle-rider@example.com")
    _, driver_headers = register(
        client, email="lifecycle-driver@example.com", role="driver", ride_type="cab"
    )
    coordinates = {
        "origin_latitude": 12.9716,
        "origin_longitude": 77.5946,
        "destination_latitude": 12.9816,
        "destination_longitude": 77.6046,
    }

    estimate = client.get("/api/rides/estimate", params=coordinates, headers=rider_headers)
    assert estimate.status_code == 200
    assert estimate.json()["distance_km"] == 5.0
    assert {mode["id"] for mode in estimate.json()["modes"]} == {"bike", "auto", "cab", "maxi_cab"}

    ride_response = client.post(
        "/api/rides",
        headers=rider_headers,
        json={
            "pickup": "Central Station",
            "destination": "City Park",
            "ride_type": "cab",
            "pickup_latitude": coordinates["origin_latitude"],
            "pickup_longitude": coordinates["origin_longitude"],
            "destination_latitude": coordinates["destination_latitude"],
            "destination_longitude": coordinates["destination_longitude"],
        },
    )
    assert ride_response.status_code == 200, ride_response.text
    ride_id = ride_response.json()["id"]
    assert ride_response.json()["status"] == "requested"
    assert ride_response.json()["fare_paise"] > 0

    assert client.get(f"/api/rides/{ride_id}", headers=driver_headers).status_code == 404
    assert client.get("/api/drivers/rides", headers=driver_headers).json()[0]["id"] == ride_id
    assert client.patch(
        f"/api/rides/{ride_id}/status", headers=rider_headers, json={"status": "accepted"}
    ).status_code == 403

    for status in ("accepted", "arriving", "arrived"):
        response = client.patch(
            f"/api/rides/{ride_id}/status", headers=driver_headers, json={"status": status}
        )
        assert response.status_code == 200, response.text
    rider_view = client.get(f"/api/rides/{ride_id}", headers=rider_headers).json()
    assert rider_view["otp"] and len(rider_view["otp"]) == 4
    assert client.get(f"/api/rides/{ride_id}", headers=driver_headers).json()["otp"] is None

    assert client.post(
        f"/api/rides/{ride_id}/verify-otp", headers=driver_headers, json={"otp": "9999"}
    ).status_code == 422
    started = client.post(
        f"/api/rides/{ride_id}/verify-otp",
        headers=driver_headers,
        json={"otp": rider_view["otp"]},
    )
    assert started.status_code == 200
    assert started.json()["status"] == "in_progress"
    assert client.patch(
        f"/api/rides/{ride_id}/status", headers=driver_headers, json={"status": "completed"}
    ).json()["status"] == "completed"

    review = client.post(
        f"/api/rides/{ride_id}/review",
        headers=rider_headers,
        json={"rating": 5, "comment": "Smooth ride"},
    )
    assert review.status_code == 200
    assert review.json()["driver_rating"] == 5
    assert client.post(
        f"/api/rides/{ride_id}/review", headers=rider_headers, json={"rating": 5}
    ).status_code == 409
    assert client.get("/api/drivers/me", headers=driver_headers).json()["rating_count"] == 1
    assert client.get("/api/rides", headers=rider_headers).json()[0]["reviewed"] is True


def test_cancel_flow_and_completed_ride_cannot_be_cancelled(client):
    _, rider_headers = register(client, email="cancel@example.com")
    response = client.post(
        "/api/rides",
        headers=rider_headers,
        json={
            "pickup": "One Place",
            "destination": "Another Place",
            "ride_type": "auto",
            "pickup_latitude": 12.9,
            "pickup_longitude": 77.5,
            "destination_latitude": 13.0,
            "destination_longitude": 77.6,
        },
    )
    ride_id = response.json()["id"]
    assert client.post(f"/api/rides/{ride_id}/cancel", headers=rider_headers).json()["status"] == "cancelled"
    assert client.post(f"/api/rides/{ride_id}/cancel", headers=rider_headers).status_code == 409


def test_payment_is_blocked_until_completion_and_requires_stripe_config(client):
    _, rider_headers = register(client, email="pay@example.com")
    _, driver_headers = register(
        client, email="pay-driver@example.com", role="driver", ride_type="cab"
    )
    request = {
        "pickup": "One Place",
        "destination": "Another Place",
        "ride_type": "cab",
        "pickup_latitude": 12.9,
        "pickup_longitude": 77.5,
        "destination_latitude": 13.0,
        "destination_longitude": 77.6,
    }
    ride_id = client.post("/api/rides", headers=rider_headers, json=request).json()["id"]
    assert client.post(f"/api/rides/{ride_id}/payment-intent", headers=rider_headers).status_code == 409
    for status in ("accepted", "arriving", "arrived"):
        client.patch(f"/api/rides/{ride_id}/status", headers=driver_headers, json={"status": status})
    otp = client.get(f"/api/rides/{ride_id}", headers=rider_headers).json()["otp"]
    client.post(f"/api/rides/{ride_id}/verify-otp", headers=driver_headers, json={"otp": otp})
    client.patch(f"/api/rides/{ride_id}/status", headers=driver_headers, json={"status": "completed"})

    payment = client.post(f"/api/rides/{ride_id}/payment-intent", headers=rider_headers)
    assert payment.status_code == 503
    assert client.post(
        f"/api/rides/{ride_id}/payment-intent", headers=driver_headers
    ).status_code == 404


def test_webhook_rejects_invalid_signature(client):
    assert client.post(
        "/api/webhooks/stripe",
        content=b"{}",
        headers={"Stripe-Signature": "invalid"},
    ).status_code == 400


def test_health_endpoint_parallel_load(api_base_url):
    import requests

    request_count = 1000
    concurrency = 50
    timings = []

    def request_health(_index):
        started = time.perf_counter()
        response = requests.get(f"{api_base_url}/api/health", timeout=10)
        elapsed_ms = (time.perf_counter() - started) * 1000
        return response.status_code, elapsed_ms

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = list(pool.map(request_health, range(request_count)))
    elapsed = time.perf_counter() - started
    timings.extend(duration for _, duration in results)
    failures = sum(status != 200 for status, _ in results)
    ordered = sorted(timings)
    percentile = lambda value: ordered[round((len(ordered) - 1) * value)]
    print(
        "Local API load: "
        f"requests={request_count}, concurrency={concurrency}, failures={failures}, "
        f"throughput={request_count / elapsed:.1f} req/s, "
        f"latency_ms p50={statistics.median(timings):.1f} "
        f"p95={percentile(0.95):.1f} p99={percentile(0.99):.1f}"
    )
    assert failures == 0
