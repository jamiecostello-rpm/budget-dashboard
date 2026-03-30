#!/usr/bin/env python3
"""
Google Sheets Data Fetch Tool
Fetches Budget Heating appointment data from Google Sheets CSV.
Computes totals for Appointments Booked and Revenue Generated.

Usage:
  python fetch_sheets_data.py --url="SHEETS_CSV_URL"
  python fetch_sheets_data.py --demo
"""

import os
import sys
import json
import csv
import io
import re
import urllib.request
import urllib.error

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# Default Sheet ID for Budget Heating
DEFAULT_SHEET_ID = "1quGlVT2A07mL_MFqfdQWsYPC9nBrcTdWp6zE6nGpnR0"


def sheet_id_to_csv_url(sheet_id):
    """Convert a Google Sheets ID to a CSV export URL."""
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"


def fetch_csv(url):
    """Fetch CSV data from a public Google Sheets URL."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CitaDashboard/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}")
        return None
    except Exception as e:
        print(f"Fetch error: {e}")
        return None


def parse_amount(s):
    """Parse a currency string like '$550.00' into a float. Returns 0 for '-' or empty."""
    if not s or s.strip() in ("-", ""):
        return 0.0
    cleaned = re.sub(r"[^\d.]", "", s)
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def parse_csv(csv_text):
    """Parse appointment CSV into dashboard payload."""
    reader = csv.DictReader(io.StringIO(csv_text))
    rows = []
    for row in reader:
        rows.append(dict(row))

    if not rows:
        return {"headers": [], "rows": [], "row_count": 0, "totals": {}}

    headers = list(rows[0].keys())

    # Compute totals
    total_appointments = len(rows)
    closed_appointments = sum(
        1 for r in rows if r.get("Estimate Status", "").strip().lower() == "closed"
    )
    pending_appointments = sum(
        1 for r in rows if r.get("Estimate Status", "").strip().lower() == "pending"
    )
    open_appointments = sum(
        1 for r in rows if r.get("Estimate Status", "").strip().lower() == "open"
    )

    # Revenue = sum of "Amount Closed" where status is Closed
    revenue = sum(
        parse_amount(r.get("Amount Closed", "0"))
        for r in rows
        if r.get("Estimate Status", "").strip().lower() == "closed"
    )

    return {
        "headers": headers,
        "rows": rows,
        "row_count": total_appointments,
        "totals": {
            "appointments_booked": total_appointments,
            "appointments_closed": closed_appointments,
            "appointments_pending": pending_appointments,
            "appointments_open": open_appointments,
            "revenue_generated": int(revenue),
        },
    }


def generate_demo_data():
    """Generate demo data matching the sheet structure."""
    return {
        "headers": [
            "Customer Name",
            "Appointment Date & Time",
            "Service Type",
            "Estimate Status",
            "Amount Closed",
        ],
        "rows": [
            {"Customer Name": "John Smith", "Appointment Date & Time": "Apr 2, 08:00", "Service Type": "AC Tune-up", "Estimate Status": "Closed", "Amount Closed": "$550.00"},
            {"Customer Name": "Emily Davis", "Appointment Date & Time": "Apr 2, 09:30", "Service Type": "Furnace Repair", "Estimate Status": "Pending", "Amount Closed": "-"},
            {"Customer Name": "Michael Johnson", "Appointment Date & Time": "Apr 2, 11:00", "Service Type": "Duct Cleaning", "Estimate Status": "Closed", "Amount Closed": "$850.00"},
            {"Customer Name": "Sarah Williams", "Appointment Date & Time": "Apr 2, 13:00", "Service Type": "Smart Thermostat Install", "Estimate Status": "Open", "Amount Closed": "-"},
            {"Customer Name": "David Brown", "Appointment Date & Time": "Apr 2, 14:30", "Service Type": "Heat Pump Inspection", "Estimate Status": "Pending", "Amount Closed": "-"},
        ],
        "totals": {
            "appointments_booked": 5,
            "appointments_closed": 2,
            "appointments_pending": 2,
            "appointments_open": 1,
            "revenue_generated": 1400,
        },
        "row_count": 5,
    }


def save_json(data, filepath):
    """Save data as formatted JSON."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Saved: {filepath}")


def main():
    args = sys.argv[1:]
    demo_mode = "--demo" in args
    url = None
    sheet_id = None
    output_name = "sheets_widget"

    for arg in args:
        if arg.startswith("--url="):
            url = arg.split("=", 1)[1]
        elif arg.startswith("--sheet-id="):
            sheet_id = arg.split("=", 1)[1]
        elif arg.startswith("--output="):
            output_name = arg.split("=", 1)[1]

    if demo_mode:
        print("=== DEMO MODE ===")
        data = generate_demo_data()
        save_json(data, os.path.join(OUTPUT_DIR, f"{output_name}.json"))
        print(f"Generated {data['row_count']} demo rows")
        print(f"Totals: {data['totals']}")
        return

    # Build URL from sheet ID if no URL provided
    if not url:
        sid = sheet_id or DEFAULT_SHEET_ID
        url = sheet_id_to_csv_url(sid)

    print(f"Fetching: {url}")
    csv_text = fetch_csv(url)
    if not csv_text:
        print("Failed to fetch data")
        sys.exit(1)

    data = parse_csv(csv_text)
    save_json(data, os.path.join(OUTPUT_DIR, f"{output_name}.json"))
    print(f"Parsed {data['row_count']} rows with columns: {data['headers']}")
    print(f"Totals: {data['totals']}")


if __name__ == "__main__":
    main()
