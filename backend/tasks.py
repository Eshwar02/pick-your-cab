"""Redis-backed receipt jobs. No email delivery is configured."""
import io
import os

from celery import Celery
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

broker = os.getenv("REDIS_URL", "redis://localhost:6379/0")
celery = Celery("zoomo", broker=broker, backend=broker)
celery.conf.update(task_serializer="json", accept_content=["json"], result_serializer="json", task_track_started=True)


def make_receipt_pdf(ride_id: int, pickup: str, destination: str, ride_type: str, distance_km: float, fare_paise: int, created_at: str) -> bytes:
    output = io.BytesIO()
    page = canvas.Canvas(output, pagesize=letter)
    page.setTitle(f"Zoomo ride receipt #{ride_id}")
    page.setFont("Helvetica-Bold", 22)
    page.drawString(72, 730, "Zoomo ride receipt")
    page.setFont("Helvetica", 12)
    rows = [f"Ride: #{ride_id}", f"Date: {created_at}", f"Ride type: {ride_type}", f"Pickup: {pickup}", f"Destination: {destination}", f"Distance: {distance_km:.1f} km", f"Fare paid: INR {fare_paise / 100:.2f}"]
    for index, row in enumerate(rows):
        page.drawString(72, 680 - index * 28, row[:110])
    page.setFont("Helvetica-Oblique", 9)
    page.drawString(72, 430, "Payment receipt. Keep this document for your records.")
    page.save()
    return output.getvalue()


def store_receipt(ride_id: int) -> None:
    from main import DATABASE_URL, Ride, RideReceipt
    url = DATABASE_URL
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(url)
    with Session(engine) as db:
        ride = db.get(Ride, ride_id)
        if not ride or ride.status != "completed" or ride.payment_status != "paid":
            return
        pdf = make_receipt_pdf(ride.id, ride.pickup, ride.destination, ride.ride_type, ride.distance_km, ride.fare_paise, ride.created_at.isoformat())
        db.merge(RideReceipt(ride_id=ride.id, pdf=pdf))
        db.commit()
    engine.dispose()


@celery.task(name="zoomo.generate_ride_receipt", autoretry_for=(Exception,), retry_backoff=True, retry_kwargs={"max_retries": 5})
def generate_ride_receipt(ride_id: int) -> None:
    store_receipt(ride_id)
