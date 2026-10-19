from __future__ import annotations

import hashlib
import hmac
import asyncio
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlencode

import httpx
import stripe
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


load_dotenv()

DATABASE_URL = os.getenv("SUPABASE_DATABASE_URL") or os.getenv("DATABASE_URL", "sqlite:///./zoomo.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
TOKEN_SECRET = os.getenv("TOKEN_SECRET", "local-development-secret-change-before-deploy")
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY")
NOMINATIM_URL = os.getenv("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
PHOTON_URL = os.getenv("PHOTON_URL", "https://photon.komoot.io/api/")
PHOTON_REVERSE_URL = os.getenv("PHOTON_REVERSE_URL", "https://photon.komoot.io/reverse")
OSRM_URL = os.getenv("OSRM_URL", "https://router.project-osrm.org")
MAPS_USER_AGENT = os.getenv("MAPS_USER_AGENT", "ZoomoRideApp/0.2 (contact: support@zoomo.example)")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
stripe.api_key = STRIPE_SECRET_KEY

engine_options = {"connect_args": {"check_same_thread": False}} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="rider")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    nonce: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Driver(Base):
    __tablename__ = "drivers"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(100))
    car: Mapped[str] = mapped_column(String(100))
    plate: Mapped[str] = mapped_column(String(20))
    ride_type: Mapped[str] = mapped_column(String(20))
    rating: Mapped[float] = mapped_column(Float, default=4.9)
    available: Mapped[bool] = mapped_column(default=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)


class Ride(Base):
    __tablename__ = "rides"
    id: Mapped[int] = mapped_column(primary_key=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"), nullable=True)
    pickup: Mapped[str] = mapped_column(String(300))
    destination: Mapped[str] = mapped_column(String(300))
    ride_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(30), default="requested", index=True)
    distance_km: Mapped[float] = mapped_column(Float)
    duration_min: Mapped[int] = mapped_column(Integer)
    fare_paise: Mapped[int] = mapped_column(Integer)
    payment_status: Mapped[str] = mapped_column(String(30), default="unpaid")
    stripe_payment_intent_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stripe_checkout_session_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    pickup_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    pickup_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    destination_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    destination_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    otp: Mapped[str | None] = mapped_column(String(4), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)


class Review(Base):
    __tablename__ = "reviews"
    id: Mapped[int] = mapped_column(primary_key=True)
    ride_id: Mapped[int] = mapped_column(ForeignKey("rides.id"), unique=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    rating: Mapped[int] = mapped_column(Integer)
    comment: Mapped[str] = mapped_column(Text, default="")


class RideMode(Base):
    __tablename__ = "ride_modes"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(40))
    description: Mapped[str] = mapped_column(String(120))
    icon: Mapped[str] = mapped_column(String(8))
    seats: Mapped[int] = mapped_column(Integer)
    base_fare_paise: Mapped[int] = mapped_column(Integer)
    per_km_paise: Mapped[int] = mapped_column(Integer)
    per_minute_paise: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(default=True)


class UserIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Literal["rider", "driver"] = "rider"
    vehicle: str = Field(default="Vehicle details pending", max_length=100)
    plate: str = Field(default="PENDING", max_length=20)
    ride_type: Literal["auto", "bike", "cab", "maxi_cab"] = "cab"


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RideIn(BaseModel):
    pickup: str = Field(min_length=2, max_length=300)
    destination: str = Field(min_length=2, max_length=300)
    ride_type: Literal["auto", "bike", "cab", "maxi_cab"]
    pickup_latitude: float = Field(ge=-90, le=90)
    pickup_longitude: float = Field(ge=-180, le=180)
    destination_latitude: float = Field(ge=-90, le=90)
    destination_longitude: float = Field(ge=-180, le=180)


class CoordinatesIn(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class OtpIn(BaseModel):
    otp: str = Field(pattern=r"^\d{4}$")


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=1000)


class RideOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    pickup: str
    destination: str
    ride_type: str
    status: str
    distance_km: float
    duration_min: int
    fare_paise: int
    payment_status: str
    created_at: datetime
    driver: dict | None = None


class DriverStatusIn(BaseModel):
    status: Literal["accepted", "arriving", "arrived", "completed"]


app = FastAPI(title="Zoomo API", version="0.1.0", description="Ride booking platform API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type", "Stripe-Signature"],
)

RIDE_MODE_DEFAULTS = [
    {"id": "bike", "name": "Bike", "description": "Quick solo rides", "icon": "🏍️", "seats": 1, "base_fare_paise": 2000, "per_km_paise": 800, "per_minute_paise": 100},
    {"id": "auto", "name": "Auto", "description": "Easy city rides", "icon": "🛺", "seats": 3, "base_fare_paise": 3000, "per_km_paise": 1500, "per_minute_paise": 100},
    {"id": "cab", "name": "Cab", "description": "Comfortable private ride", "icon": "🚕", "seats": 4, "base_fare_paise": 5000, "per_km_paise": 1500, "per_minute_paise": 150},
    {"id": "maxi_cab", "name": "Maxi-cab", "description": "Room for up to 6", "icon": "🚐", "seats": 6, "base_fare_paise": 10000, "per_km_paise": 2200, "per_minute_paise": 200},
]


def get_db():
    with SessionLocal() as session:
        yield session


def encode_token(user_id: int, db: Session) -> str:
    nonce = secrets.token_urlsafe(8)
    # Remember-me sessions persist until explicitly revoked by /api/auth/logout.
    payload = f"{nonce}.{user_id}.0"
    signature = hmac.new(TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    db.add(AuthSession(nonce=nonce, user_id=user_id))
    db.commit()
    return f"{payload}.{signature}"


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in required")
    try:
        token = authorization.removeprefix("Bearer ")
        nonce, user_id, expiry, signature = token.split(".", 3)
        payload = f"{nonce}.{user_id}.{expiry}"
        expected = hmac.new(TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected) or (int(expiry) != 0 and int(expiry) < int(time.time())):
            raise ValueError
        session = db.get(AuthSession, nonce)
        if session is None or session.user_id != int(user_id):
            raise ValueError
        user = db.get(User, int(user_id))
    except (ValueError, TypeError):
        raise HTTPException(401, "Invalid or expired session") from None
    if user is None:
        raise HTTPException(401, "Account not found")
    return user


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt_hex, digest_hex = stored.split("$", 1)
    return hmac.compare_digest(hash_password(password, bytes.fromhex(salt_hex)).split("$", 1)[1], digest_hex)


def create_default_data(db: Session) -> None:
    if db.scalar(select(RideMode.id).limit(1)) is None:
        db.add_all([RideMode(**mode) for mode in RIDE_MODE_DEFAULTS])
        db.commit()


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        create_default_data(db)


@app.get("/api/health")
def health():
    return {"status": "ok", "payments": "stripe" if STRIPE_SECRET_KEY else "unconfigured", "maps": "openstreetmap/osrm"}


@app.post("/api/auth/register")
def register(data: UserIn, db: Session = Depends(get_db)):
    email = data.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Email already registered")
    user = User(name=data.name.strip(), email=email, password_hash=hash_password(data.password), role=data.role)
    db.add(user)
    db.commit()
    db.refresh(user)
    if user.role == "driver":
        db.add(Driver(user_id=user.id, name=user.name, car=data.vehicle, plate=data.plate.upper(), ride_type=data.ride_type, available=True))
        db.commit()
    return {"token": encode_token(user.id, db), "user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role}}


@app.post("/api/auth/login")
def login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == data.email.lower()))
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Email or password is incorrect")
    return {"token": encode_token(user.id, db), "user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role}}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}


@app.post("/api/auth/logout")
def logout(authorization: str = Header(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    nonce = authorization.removeprefix("Bearer ").split(".", 1)[0]
    session = db.get(AuthSession, nonce)
    if session is not None and session.user_id == user.id:
        db.delete(session)
        db.commit()
    return {"ok": True}


location_cache: dict[str, object] = {}
last_geocoder_request = 0.0
geocoder_lock = asyncio.Lock()


async def nominatim(path: str, params: dict[str, str]):
    global last_geocoder_request
    cache_key = f"{path}?{urlencode(params)}"
    if cache_key in location_cache:
        return location_cache[cache_key]
    async with geocoder_lock:
        if cache_key in location_cache:
            return location_cache[cache_key]
        wait_for = 1.05 - (time.monotonic() - last_geocoder_request)
        if wait_for > 0:
            await asyncio.sleep(wait_for)
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": MAPS_USER_AGENT}) as client:
            response = await client.get(f"{NOMINATIM_URL.rstrip('/')}/{path}", params=params)
            response.raise_for_status()
            result = response.json()
        last_geocoder_request = time.monotonic()
        location_cache[cache_key] = result
        return result


@app.get("/api/locations/search")
async def search_locations(q: str, _: User = Depends(current_user)):
    query = q.strip()
    if len(query) < 3:
        raise HTTPException(422, "Enter at least 3 characters")
    try:
        results = await nominatim("search", {"q": query, "format": "jsonv2", "addressdetails": "1", "limit": "5"})
    except httpx.HTTPError:
        raise HTTPException(502, "Location search is unavailable. Try again shortly.") from None
    return [{"label": item["display_name"], "latitude": float(item["lat"]), "longitude": float(item["lon"]), "address": item.get("address", {})} for item in results]


suggestion_cache: dict[str, list[dict]] = {}
suggestion_lock = asyncio.Lock()


@app.get("/api/locations/suggest")
async def suggest_locations(q: str, _: User = Depends(current_user)):
    query = q.strip()
    if len(query) < 3:
        return []
    cache_key = query.casefold()
    if cache_key in suggestion_cache:
        return suggestion_cache[cache_key]
    async with suggestion_lock:
        if cache_key in suggestion_cache:
            return suggestion_cache[cache_key]
        try:
            async with httpx.AsyncClient(timeout=8, headers={"User-Agent": MAPS_USER_AGENT}) as client:
                response = await client.get(PHOTON_URL, params={"q": query, "limit": 6, "lang": "en"})
                response.raise_for_status()
                features = response.json().get("features", [])
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, "Location suggestions unavailable. Keep typing or try again.") from None
        results = []
        for feature in features:
            properties = feature.get("properties", {})
            coordinates = feature.get("geometry", {}).get("coordinates", [])
            if len(coordinates) < 2:
                continue
            parts = []
            for key in ("name", "housenumber", "street", "city", "district", "state", "country"):
                value = properties.get(key)
                if value and value not in parts:
                    parts.append(value)
            address = {"house_number" if key == "housenumber" else key: properties[key] for key in (
                "housenumber", "street", "neighbourhood", "locality", "district",
                "city", "county", "state", "postcode", "country",
            ) if properties.get(key)}
            results.append({"label": ", ".join(parts) or query, "longitude": coordinates[0], "latitude": coordinates[1], "address": address})
        if len(suggestion_cache) >= 1000:
            suggestion_cache.pop(next(iter(suggestion_cache)))
        suggestion_cache[cache_key] = results
        return results


@app.get("/api/locations/reverse")
async def reverse_location(latitude: float, longitude: float, _: User = Depends(current_user)):
    address: dict[str, object] = {}
    label = ""
    source = "coordinates"
    try:
        result = await nominatim("reverse", {
            "lat": str(latitude), "lon": str(longitude), "format": "jsonv2",
            "addressdetails": "1", "namedetails": "1", "zoom": "18",
        })
        raw_address = result.get("address") or {}
        address = raw_address if isinstance(raw_address, dict) else {}
        label = result.get("display_name", "")
        if not label:
            raise ValueError("No address found for map point")
        source = "nominatim"
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        # Public Nominatim can throttle or time out. Photon is an independent
        # OSM geocoder, so try it before accepting the raw map coordinates.
        try:
            async with httpx.AsyncClient(timeout=7, headers={"User-Agent": MAPS_USER_AGENT}) as client:
                response = await client.get(PHOTON_REVERSE_URL, params={"lat": latitude, "lon": longitude, "lang": "en"})
                response.raise_for_status()
                features = response.json().get("features", [])
            if features:
                properties = features[0].get("properties", {})
                address = {
                    ("house_number" if key == "housenumber" else key): properties[key] for key in (
                        "name", "housenumber", "street", "locality", "district",
                        "city", "county", "state", "postcode", "country",
                    ) if properties.get(key)
                }
                label = ", ".join(dict.fromkeys(str(address[key]) for key in (
                    "name", "housenumber", "street", "locality", "district",
                    "city", "county", "state", "postcode", "country",
                ) if address.get(key)))
                source = "photon"
        except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
            pass

    # Keep map selection usable during geocoder outages. The exact pin
    # coordinates still work for route estimates and ride requests.
    if not label:
        label = f"Map pin near {latitude:.5f}, {longitude:.5f}"
    return {
        "label": label,
        "latitude": latitude,
        "longitude": longitude,
        "address": address,
        "geocoding_source": source,
    }


async def fetch_route(origin_latitude: float, origin_longitude: float, destination_latitude: float, destination_longitude: float) -> dict:
    coordinates = f"{origin_longitude},{origin_latitude};{destination_longitude},{destination_latitude}"
    try:
        async with httpx.AsyncClient(timeout=12, headers={"User-Agent": MAPS_USER_AGENT}) as client:
            response = await client.get(f"{OSRM_URL.rstrip('/')}/route/v1/driving/{coordinates}", params={"overview": "full", "geometries": "geojson"})
            response.raise_for_status()
            result = response.json()
        route = result["routes"][0]
        return {
            "distance_km": round(route["distance"] / 1000, 1),
            "duration_min": max(1, round(route["duration"] / 60)),
            "path": [[latitude, longitude] for longitude, latitude in route["geometry"]["coordinates"]],
        }
    except (httpx.HTTPError, KeyError, IndexError, TypeError):
        raise HTTPException(502, "Could not route between these locations. Choose nearby map results.") from None


def calculate_fare(mode: RideMode, distance_km: float, duration_min: int) -> int:
    return round(mode.base_fare_paise + distance_km * mode.per_km_paise + duration_min * mode.per_minute_paise)


def mode_response(mode: RideMode, distance_km: float | None = None, duration_min: int | None = None) -> dict:
    return {
        "id": mode.id, "name": mode.name, "description": mode.description,
        "icon": mode.icon, "seats": mode.seats,
        "fare_paise": calculate_fare(mode, distance_km, duration_min) if distance_km is not None and duration_min is not None else None,
    }


@app.get("/api/rides/modes")
def ride_modes(db: Session = Depends(get_db), _: User = Depends(current_user)):
    return [mode_response(mode) for mode in db.scalars(select(RideMode).where(RideMode.active.is_(True))).all()]


@app.get("/api/rides/estimate")
async def estimate(origin_latitude: float, origin_longitude: float, destination_latitude: float, destination_longitude: float, db: Session = Depends(get_db), _: User = Depends(current_user)):
    route = await fetch_route(origin_latitude, origin_longitude, destination_latitude, destination_longitude)
    modes = db.scalars(select(RideMode).where(RideMode.active.is_(True))).all()
    return {**route, "modes": [mode_response(mode, route["distance_km"], route["duration_min"]) for mode in modes]}


@app.get("/api/route")
async def get_route(origin_latitude: float, origin_longitude: float, destination_latitude: float, destination_longitude: float, _: User = Depends(current_user)):
    return await fetch_route(origin_latitude, origin_longitude, destination_latitude, destination_longitude)


def ride_response(ride: Ride, db: Session, viewer: User | None = None) -> dict:
    driver = db.get(Driver, ride.driver_id) if ride.driver_id else None
    review = db.scalar(select(Review.id).where(Review.ride_id == ride.id))
    rating_count = db.scalar(select(func.count(Review.id)).join(Ride, Review.ride_id == Ride.id).where(Ride.driver_id == driver.id)) if driver else 0
    return {
        "id": ride.id, "pickup": ride.pickup, "destination": ride.destination,
        "ride_type": ride.ride_type, "status": ride.status,
        "distance_km": ride.distance_km, "duration_min": ride.duration_min,
        "fare_paise": ride.fare_paise, "payment_status": ride.payment_status,
        "reviewed": review is not None,
        "created_at": ride.created_at.isoformat(),
        "pickup_latitude": ride.pickup_latitude,
        "pickup_longitude": ride.pickup_longitude,
        "destination_latitude": ride.destination_latitude,
        "destination_longitude": ride.destination_longitude,
        "otp": ride.otp if viewer and viewer.id == ride.rider_id and ride.status == "arrived" else None,
        "driver": ({"name": driver.name, "car": driver.car, "plate": driver.plate, "rating": driver.rating if rating_count else None, "rating_count": rating_count, "latitude": driver.latitude, "longitude": driver.longitude} if driver else None),
    }


@app.post("/api/rides")
async def request_ride(data: RideIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "rider":
        raise HTTPException(403, "Rider account required")
    route = await fetch_route(data.pickup_latitude, data.pickup_longitude, data.destination_latitude, data.destination_longitude)
    mode = db.get(RideMode, data.ride_type)
    if mode is None or not mode.active:
        raise HTTPException(422, "This ride mode is unavailable")
    ride = Ride(
        rider_id=user.id, pickup=data.pickup.strip(), destination=data.destination.strip(),
        ride_type=data.ride_type, distance_km=route["distance_km"], duration_min=route["duration_min"],
        fare_paise=calculate_fare(mode, route["distance_km"], route["duration_min"]), status="requested",
        pickup_latitude=data.pickup_latitude, pickup_longitude=data.pickup_longitude,
        destination_latitude=data.destination_latitude, destination_longitude=data.destination_longitude,
        otp=f"{secrets.randbelow(10000):04d}",
    )
    db.add(ride)
    db.commit()
    db.refresh(ride)
    return ride_response(ride, db, user)


@app.get("/api/rides")
def ride_history(db: Session = Depends(get_db), user: User = Depends(current_user)):
    rides = db.scalars(select(Ride).where(Ride.rider_id == user.id).order_by(Ride.created_at.desc())).all()
    return [ride_response(ride, db, user) for ride in rides]


@app.get("/api/rides/{ride_id}")
def ride_status(ride_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    ride = db.get(Ride, ride_id)
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id)) if user.role == "driver" else None
    if ride is None or (ride.rider_id != user.id and (driver is None or ride.driver_id != driver.id)):
        raise HTTPException(404, "Ride not found")
    return ride_response(ride, db, user)


@app.patch("/api/rides/{ride_id}/status")
def update_ride_status(ride_id: int, data: DriverStatusIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "driver":
        raise HTTPException(403, "Driver account required")
    ride = db.get(Ride, ride_id)
    if ride is None:
        raise HTTPException(404, "Ride not found")
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if driver is None:
        raise HTTPException(404, "Ride not found")
    if data.status == "accepted" and ride.status == "requested" and ride.driver_id is None:
        if not driver.available or driver.ride_type != ride.ride_type:
            raise HTTPException(409, "Driver is unavailable or does not serve this ride mode")
        ride.driver_id = driver.id
        ride.status = "accepted"
        db.commit()
        return ride_response(ride, db)
    elif ride.driver_id != driver.id:
        raise HTTPException(404, "Ride not found")
    allowed = {"accepted": {"arriving"}, "arriving": {"arrived"}, "in_progress": {"completed"}}
    if data.status not in allowed.get(ride.status, set()):
        raise HTTPException(409, f"Cannot move ride from {ride.status} to {data.status}")
    ride.status = data.status
    db.commit()
    return ride_response(ride, db)


@app.post("/api/rides/{ride_id}/verify-otp")
def verify_ride_otp(ride_id: int, data: OtpIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "driver":
        raise HTTPException(403, "Driver account required")
    ride = db.get(Ride, ride_id)
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if ride is None or driver is None or ride.driver_id != driver.id:
        raise HTTPException(404, "Ride not found")
    if ride.status != "arrived" or not hmac.compare_digest(ride.otp or "", data.otp):
        raise HTTPException(422, "OTP is incorrect")
    ride.status = "in_progress"
    db.commit()
    return ride_response(ride, db)


@app.post("/api/rides/{ride_id}/cancel")
def cancel_ride(ride_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    ride = db.get(Ride, ride_id)
    if ride is None or ride.rider_id != user.id:
        raise HTTPException(404, "Ride not found")
    if ride.status not in {"requested", "accepted", "arriving"}:
        raise HTTPException(409, "Ride can no longer be cancelled")
    ride.status = "cancelled"
    db.commit()
    return ride_response(ride, db, user)


@app.post("/api/rides/{ride_id}/payment-intent")
def create_payment_intent(ride_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    ride = db.get(Ride, ride_id)
    if ride is None or ride.rider_id != user.id:
        raise HTTPException(404, "Ride not found")
    if ride.status != "completed":
        raise HTTPException(409, "Payment is available after the ride completes")
    if ride.payment_status == "paid":
        return {"mode": "paid", "payment_status": "paid"}
    if not STRIPE_SECRET_KEY:
        raise HTTPException(503, "Card payments are not configured. Set STRIPE_SECRET_KEY on the backend.")
    if ride.stripe_checkout_session_id:
        try:
            existing = stripe.checkout.Session.retrieve(ride.stripe_checkout_session_id)
            if existing.status == "open" and existing.url:
                return {"mode": "stripe", "url": existing.url, "checkout_session_id": existing.id}
        except stripe.error.StripeError:
            pass
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000").rstrip("/")
    checkout = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{"price_data": {"currency": "inr", "product_data": {"name": f"Zoomo ride #{ride.id}"}, "unit_amount": ride.fare_paise}, "quantity": 1}],
        success_url=f"{frontend_url}/payment?payment=success&ride_id={ride.id}&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{frontend_url}/payment?payment=cancelled&ride_id={ride.id}",
        metadata={"ride_id": str(ride.id), "rider_id": str(user.id)},
        payment_intent_data={"metadata": {"ride_id": str(ride.id), "rider_id": str(user.id)}},
        customer_email=user.email,
    )
    ride.stripe_checkout_session_id = checkout.id
    ride.payment_status = "pending"
    db.commit()
    return {"mode": "stripe", "url": checkout.url, "checkout_session_id": checkout.id}


@app.post("/api/webhooks/stripe")
async def stripe_webhook(request: Request, stripe_signature: str | None = Header(default=None)):
    payload = await request.body()
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "Stripe webhook is not configured")
    try:
        event = stripe.Webhook.construct_event(payload, stripe_signature or "", STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "Invalid Stripe webhook signature") from None
    if event.type in {"payment_intent.succeeded", "checkout.session.completed", "checkout.session.async_payment_succeeded"}:
        paid_object = event.data.object
        with SessionLocal() as db:
            is_checkout_event = event.type.startswith("checkout.session.")
            payment_intent_id = getattr(paid_object, "payment_intent", None) if is_checkout_event else paid_object.id
            ride_id = getattr(paid_object, "metadata", {}).get("ride_id")
            session_id = getattr(paid_object, "id", None) if is_checkout_event else None
            ride = db.get(Ride, int(ride_id)) if ride_id and str(ride_id).isdigit() else None
            if ride is None and session_id:
                ride = db.scalar(select(Ride).where(Ride.stripe_checkout_session_id == session_id))
            if ride is None and payment_intent_id:
                ride = db.scalar(select(Ride).where(Ride.stripe_payment_intent_id == payment_intent_id))
            amount = getattr(paid_object, "amount_received", None) if event.type == "payment_intent.succeeded" else getattr(paid_object, "amount_total", None)
            currency = getattr(paid_object, "currency", None)
            paid = event.type == "payment_intent.succeeded" or getattr(paid_object, "payment_status", None) == "paid"
            if ride and paid and currency == "inr" and amount == ride.fare_paise:
                ride.stripe_payment_intent_id = payment_intent_id
                if session_id:
                    ride.stripe_checkout_session_id = session_id
                ride.payment_status = "paid"
                db.commit()
    elif event.type in {"checkout.session.expired", "checkout.session.async_payment_failed"}:
        session = event.data.object
        with SessionLocal() as db:
            ride = db.scalar(select(Ride).where(Ride.stripe_checkout_session_id == session.id))
            if ride and ride.payment_status == "pending":
                ride.payment_status = "unpaid"
                ride.stripe_checkout_session_id = None
                db.commit()
    return {"received": True}


@app.post("/api/rides/{ride_id}/review")
def add_review(ride_id: int, data: ReviewIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    ride = db.get(Ride, ride_id)
    if ride is None or ride.rider_id != user.id:
        raise HTTPException(404, "Ride not found")
    if ride.status != "completed":
        raise HTTPException(409, "Review is available after the ride completes")
    if db.scalar(select(Review.id).where(Review.ride_id == ride.id)):
        raise HTTPException(409, "Ride already reviewed")
    review = Review(ride_id=ride.id, rider_id=user.id, rating=data.rating, comment=data.comment)
    if ride.driver_id:
        driver = db.get(Driver, ride.driver_id)
        ratings = db.scalars(select(Review.rating).join(Ride, Review.ride_id == Ride.id).where(Ride.driver_id == ride.driver_id)).all()
        all_ratings = [*ratings, data.rating]
        driver.rating = sum(all_ratings) / len(all_ratings)
    db.add(review)
    db.commit()
    return {"id": review.id, "ride_id": ride.id, "rating": review.rating, "comment": review.comment, "driver_rating": driver.rating if ride.driver_id else None}


@app.get("/api/drivers/rides")
def driver_rides(db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "driver":
        raise HTTPException(403, "Driver account required")
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if driver is None:
        raise HTTPException(404, "Driver profile not found")
    rides = db.scalars(select(Ride).where(
        (Ride.driver_id == driver.id) | ((Ride.driver_id.is_(None)) & (Ride.status == "requested") & (Ride.ride_type == driver.ride_type))
    ).order_by(Ride.created_at.desc()).limit(50)).all()
    return [ride_response(ride, db) for ride in rides]


@app.get("/api/drivers/me")
def driver_me(db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "driver":
        raise HTTPException(403, "Driver account required")
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if driver is None:
        raise HTTPException(404, "Driver profile not found")
    rating_count = db.scalar(select(func.count(Review.id)).join(Ride, Review.ride_id == Ride.id).where(Ride.driver_id == driver.id)) or 0
    return {"available": driver.available, "name": driver.name, "car": driver.car, "plate": driver.plate,
            "rating": driver.rating if rating_count else None, "rating_count": rating_count}


@app.patch("/api/drivers/availability")
def driver_availability(available: bool, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "driver":
        raise HTTPException(403, "Driver account required")
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if driver is None:
        raise HTTPException(404, "Driver profile not found")
    driver.available = available
    db.commit()
    return {"available": driver.available}


@app.patch("/api/drivers/location")
def update_driver_location(data: CoordinatesIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role != "driver":
        raise HTTPException(403, "Driver account required")
    driver = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if driver is None:
        raise HTTPException(404, "Driver profile not found")
    driver.latitude = data.latitude
    driver.longitude = data.longitude
    db.commit()
    return {"latitude": driver.latitude, "longitude": driver.longitude}
