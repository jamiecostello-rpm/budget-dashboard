#!/usr/bin/env python3
"""
Retell AI Data Fetch Tool
Fetches voice agent call data from Retell AI API and transforms it
into Dashboard Payload JSON for client dashboards.

Usage:
  python fetch_retell_data.py                    # Fetch all agents
  python fetch_retell_data.py --agent_id=abc123  # Fetch specific agent
  python fetch_retell_data.py --demo             # Generate demo data
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta

# Config
RETELL_API_BASE = "https://api.retellai.com"
API_KEY = os.environ.get("RETELL_API_KEY", "")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
TMP_DIR = os.path.join(os.path.dirname(__file__), "..", ".tmp")


def retell_request(method, endpoint, body=None, retries=3):
    """Make an authenticated request to the Retell API."""
    url = f"{RETELL_API_BASE}{endpoint}"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    data = json.dumps(body).encode("utf-8") if body else None

    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print(f"ERROR: Invalid API key. Check RETELL_API_KEY.")
                sys.exit(1)
            elif e.code == 429:
                wait = 2 ** attempt
                print(f"Rate limited. Waiting {wait}s before retry...")
                time.sleep(wait)
            else:
                print(f"HTTP {e.code}: {e.read().decode()}")
                if attempt == retries - 1:
                    return None
        except Exception as e:
            print(f"Request error: {e}")
            if attempt == retries - 1:
                return None

    return None


def list_agents():
    """Fetch all voice agents."""
    return retell_request("GET", "/list-agents") or []


def list_calls(agent_ids, days_back=30):
    """Fetch calls for one or more agents within the last N days (with pagination)."""
    if isinstance(agent_ids, str):
        agent_ids = [agent_ids]

    now = int(time.time() * 1000)
    start = int((datetime.now() - timedelta(days=days_back)).timestamp() * 1000)

    all_calls = []
    pagination_key = None

    while True:
        body = {
            "filter_criteria": {
                "agent_id": agent_ids,
                "after_start_timestamp": start,
                "before_start_timestamp": now,
            },
            "limit": 1000,
            "sort_order": "descending",
        }
        if pagination_key:
            body["pagination_key"] = pagination_key

        result = retell_request("POST", "/v2/list-calls", body)
        if not result or not isinstance(result, list) or len(result) == 0:
            break

        all_calls.extend(result)
        print(f"  Fetched {len(result)} calls (total: {len(all_calls)})")

        if len(result) < 1000:
            break  # No more pages

        # Use last call_id as pagination key
        pagination_key = result[-1].get("call_id")
        if not pagination_key:
            break

    return all_calls


def compute_stats(calls):
    """Compute comprehensive analytics from call data."""
    if not calls:
        return _empty_stats()

    total = len(calls)
    durations = [c.get("duration_ms", 0) / 1000 for c in calls]
    avg_duration = sum(durations) / total
    total_talk_time = sum(durations)

    # Success
    successful = sum(1 for c in calls if c.get("call_analysis", {}).get("call_successful", False))
    success_rate = (successful / total * 100)

    # Sentiment breakdown
    sentiments = {"Positive": 0, "Neutral": 0, "Negative": 0, "Unknown": 0}
    for c in calls:
        s = c.get("call_analysis", {}).get("user_sentiment", "Unknown")
        sentiments[s] = sentiments.get(s, 0) + 1

    # Disconnection reasons
    disconnection_counts = {}
    for c in calls:
        reason = c.get("disconnection_reason", "unknown")
        disconnection_counts[reason] = disconnection_counts.get(reason, 0) + 1

    # Call direction
    inbound = sum(1 for c in calls if c.get("direction") == "inbound")
    outbound = sum(1 for c in calls if c.get("direction") == "outbound")

    # Cost breakdown
    total_cost_cents = sum(c.get("call_cost", {}).get("combined_cost", 0) for c in calls)
    total_cost = total_cost_cents / 100
    avg_cost = total_cost / total if total else 0

    product_costs = {}
    for c in calls:
        for pc in c.get("call_cost", {}).get("product_costs", []):
            product = pc.get("product", "unknown")
            cost = pc.get("cost", 0) / 100
            product_costs[product] = round(product_costs.get(product, 0) + cost, 2)

    # Voicemail
    voicemail_count = sum(1 for c in calls if c.get("call_analysis", {}).get("in_voicemail", False))

    # Custom analysis data aggregation
    custom_analysis = {}
    for c in calls:
        cad = c.get("call_analysis", {}).get("custom_analysis_data", {})
        for key, val in cad.items():
            if key not in custom_analysis:
                custom_analysis[key] = {}
            val_str = str(val) if val else "unknown"
            custom_analysis[key][val_str] = custom_analysis[key].get(val_str, 0) + 1

    # Daily call volume (calls per day)
    daily_volume = {}
    for c in calls:
        ts = c.get("start_timestamp")
        if ts:
            day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
            daily_volume[day] = daily_volume.get(day, 0) + 1
    # Sort by date
    daily_volume = dict(sorted(daily_volume.items()))

    return {
        "total_calls": total,
        "avg_duration_seconds": round(avg_duration, 1),
        "total_talk_time_seconds": round(total_talk_time),
        "min_duration_seconds": round(min(durations), 1) if durations else 0,
        "max_duration_seconds": round(max(durations), 1) if durations else 0,
        "success_rate_pct": round(success_rate, 1),
        "successful_calls": successful,
        "failed_calls": total - successful,
        "sentiment": {
            "positive": sentiments.get("Positive", 0),
            "neutral": sentiments.get("Neutral", 0),
            "negative": sentiments.get("Negative", 0),
            "unknown": sentiments.get("Unknown", 0),
            "positive_pct": round(sentiments.get("Positive", 0) / total * 100, 1),
            "neutral_pct": round(sentiments.get("Neutral", 0) / total * 100, 1),
            "negative_pct": round(sentiments.get("Negative", 0) / total * 100, 1),
        },
        "disconnection_reasons": disconnection_counts,
        "direction": {
            "inbound": inbound,
            "outbound": outbound,
            "inbound_pct": round(inbound / total * 100, 1) if total else 0,
            "outbound_pct": round(outbound / total * 100, 1) if total else 0,
        },
        "cost": {
            "total": round(total_cost, 2),
            "avg_per_call": round(avg_cost, 2),
            "by_product": product_costs,
        },
        "voicemail": {
            "count": voicemail_count,
            "pct": round(voicemail_count / total * 100, 1) if total else 0,
        },
        "custom_analysis": custom_analysis,
        "daily_volume": daily_volume,
    }


def _empty_stats():
    return {
        "total_calls": 0, "avg_duration_seconds": 0,
        "total_talk_time_seconds": 0, "min_duration_seconds": 0,
        "max_duration_seconds": 0, "success_rate_pct": 0,
        "successful_calls": 0, "failed_calls": 0,
        "sentiment": {"positive": 0, "neutral": 0, "negative": 0, "unknown": 0,
                       "positive_pct": 0, "neutral_pct": 0, "negative_pct": 0},
        "disconnection_reasons": {}, "direction": {"inbound": 0, "outbound": 0,
        "inbound_pct": 0, "outbound_pct": 0},
        "cost": {"total": 0, "avg_per_call": 0, "by_product": {}},
        "voicemail": {"count": 0, "pct": 0},
        "custom_analysis": {}, "daily_volume": {},
    }


def format_duration(ms):
    """Format milliseconds to human-readable duration."""
    if not ms:
        return "0s"
    seconds = int(ms / 1000)
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    remaining = seconds % 60
    return f"{minutes}m {remaining}s"


def build_recent_calls(calls, limit=50):
    """Build the recent calls list for display (expanded)."""
    recent = []
    for c in calls[:limit]:
        analysis = c.get("call_analysis", {})
        start_ts = c.get("start_timestamp")
        timestamp = ""
        if start_ts:
            timestamp = datetime.fromtimestamp(start_ts / 1000).isoformat()

        cost = c.get("call_cost", {}).get("combined_cost", 0) / 100

        recent.append({
            "call_id": c.get("call_id", ""),
            "timestamp": timestamp,
            "duration": format_duration(c.get("duration_ms", 0)),
            "duration_seconds": round(c.get("duration_ms", 0) / 1000),
            "sentiment": analysis.get("user_sentiment", "Unknown"),
            "successful": analysis.get("call_successful", False),
            "summary": analysis.get("call_summary", ""),
            "disconnection_reason": c.get("disconnection_reason", ""),
            "direction": c.get("direction", "unknown"),
            "from_number": c.get("from_number", ""),
            "to_number": c.get("to_number", ""),
            "cost": round(cost, 2),
            "in_voicemail": analysis.get("in_voicemail", False),
        })

    return recent


def build_dashboard_payload(agent_name, calls, client_name=""):
    """Build the full dashboard payload with per-period stats."""
    now = datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    seven_days_ago = now - timedelta(days=7)
    thirty_days_ago = now - timedelta(days=30)

    # Filter calls by period
    def filter_period(calls_list, cutoff):
        return [c for c in calls_list if c.get("start_timestamp") and
                datetime.fromtimestamp(c["start_timestamp"] / 1000) >= cutoff]

    today_calls = filter_period(calls, today_start)
    week_calls = filter_period(calls, seven_days_ago)
    month_calls = filter_period(calls, thirty_days_ago)

    return {
        "client_name": client_name,
        "agent_name": agent_name,
        "generated_at": now.isoformat(),
        "stats": compute_stats(month_calls),
        "stats_today": compute_stats(today_calls),
        "stats_7d": compute_stats(week_calls),
        "recent_calls": build_recent_calls(month_calls),
    }


def generate_demo_data():
    """Generate realistic demo data for testing."""
    import random

    sentiments = ["Positive", "Positive", "Positive", "Neutral", "Negative"]
    reasons = ["agent_hangup", "user_hangup", "agent_hangup", "user_hangup"]
    summaries = [
        "Customer enquired about appointment availability. Booked for next Tuesday at 10am.",
        "Follow-up call regarding service quote. Customer confirmed they'd like to proceed.",
        "New lead enquiry about pricing. Agent provided package details and booked a consultation.",
        "Customer called to reschedule appointment. Moved to Thursday 2pm.",
        "Voicemail left. No response from customer.",
        "Customer had billing query. Issue resolved, payment confirmed.",
        "New enquiry from website. Agent qualified lead and booked discovery call.",
        "Customer called to cancel. Agent offered alternative package, customer agreed to stay.",
        "Follow-up on missed appointment. Rescheduled for Monday morning.",
        "Cold outreach call. Customer interested, booked demo for Friday.",
    ]

    now = time.time() * 1000
    calls = []
    for i in range(47):
        ts = now - (i * random.randint(1800000, 7200000))  # 30min to 2hr apart
        duration = random.randint(30000, 600000)  # 30s to 10min
        sentiment = random.choice(sentiments)
        successful = sentiment != "Negative" and random.random() > 0.15

        calls.append({
            "call_id": f"demo_{i:03d}",
            "agent_id": "demo_agent_001",
            "agent_name": "Reception Agent",
            "call_status": "ended",
            "start_timestamp": int(ts),
            "end_timestamp": int(ts + duration),
            "duration_ms": duration,
            "disconnection_reason": random.choice(reasons),
            "call_analysis": {
                "call_summary": random.choice(summaries),
                "in_voicemail": random.random() < 0.1,
                "user_sentiment": sentiment,
                "call_successful": successful,
            },
            "call_cost": {
                "combined_cost": random.randint(5, 80),
                "total_duration_seconds": duration // 1000,
            },
        })

    return calls


def save_json(data, filepath):
    """Save data as formatted JSON."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Saved: {filepath}")


def main():
    args = sys.argv[1:]
    demo_mode = "--demo" in args
    agent_id = None
    client_name = None

    for arg in args:
        if arg.startswith("--agent_id="):
            agent_id = arg.split("=", 1)[1]
        if arg.startswith("--client="):
            client_name = arg.split("=", 1)[1]

    if demo_mode:
        print("=== DEMO MODE ===")
        calls = generate_demo_data()
        payload = build_dashboard_payload("Reception Agent", calls, "Demo Client")
        save_json(payload, os.path.join(OUTPUT_DIR, "demo.json"))
        print(f"Stats: {payload['stats']}")
        return

    if not API_KEY:
        print("ERROR: RETELL_API_KEY not set. Add it to .env")
        print("Falling back to demo mode...")
        calls = generate_demo_data()
        payload = build_dashboard_payload("Reception Agent", calls, "Demo Client")
        save_json(payload, os.path.join(OUTPUT_DIR, "demo.json"))
        return

    # Fetch agents
    agents = list_agents()
    print(f"Found {len(agents)} agents")

    if client_name:
        # Auto-discover ALL agents matching the client name
        matching = [a for a in agents if client_name.lower() in a.get("agent_name", "").lower()]
        # Deduplicate agent IDs
        seen = set()
        matching_ids = []
        for a in matching:
            aid = a.get("agent_id")
            if aid and aid not in seen:
                seen.add(aid)
                matching_ids.append(aid)
        print(f"\nFound {len(matching_ids)} unique agents matching '{client_name}':")
        # Build a name map from unique IDs
        name_map = {}
        for a in matching:
            aid = a.get("agent_id")
            if aid in seen:
                name_map[aid] = a.get("agent_name", "Unknown")
        for aid in matching_ids:
            print(f"  - {name_map.get(aid, 'Unknown')} ({aid})")

        if not matching_ids:
            print(f"ERROR: No agents found matching '{client_name}'")
            return

        print(f"\nFetching calls across all {len(matching_ids)} agents...")
        calls = list_calls(matching_ids)
        label = f"{client_name} ({len(matching_ids)} agents)"
        payload = build_dashboard_payload(label, calls, client_name)
        save_json(payload, os.path.join(OUTPUT_DIR, "demo.json"))
        print(f"\nTotal calls: {payload['stats']['total_calls']}")
        print(f"Stats: {json.dumps(payload['stats'], indent=2)[:500]}")

    elif agent_id:
        # Fetch specific agent
        agent = next((a for a in agents if a.get("agent_id") == agent_id), None)
        name = agent.get("agent_name", "Unknown") if agent else "Unknown"
        print(f"Fetching calls for agent: {name} ({agent_id})")
        calls = list_calls(agent_id)
        payload = build_dashboard_payload(name, calls)
        save_json(payload, os.path.join(OUTPUT_DIR, f"{agent_id}.json"))
        print(f"Stats: {payload['stats']}")
    else:
        # Fetch all agents
        for agent in agents:
            aid = agent.get("agent_id")
            name = agent.get("agent_name", "Unknown")
            print(f"\nFetching calls for: {name} ({aid})")
            calls = list_calls(aid)
            payload = build_dashboard_payload(name, calls)
            save_json(payload, os.path.join(OUTPUT_DIR, f"{aid}.json"))
            print(f"Stats: {payload['stats']}")


if __name__ == "__main__":
    main()
