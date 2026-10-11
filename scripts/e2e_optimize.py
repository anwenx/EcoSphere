#!/usr/bin/env python3
"""Live end-to-end check: API -> real optimizer (OR-Tools). Needs the DB seeded, the API running, and the optimizer
running with the SAME OPTIMIZER_SERVICE_TOKEN as the API.

  ECO_PASSWORD=<demo password> python3 scripts/e2e_optimize.py [--vehicles 3] [--time-limit 10] [--save]

Without --save nothing is stored except the job and its result. With --save the plan is saved and every route published
(real routes for the chosen date, visible to the assigned drivers).
"""
import argparse
import datetime
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("ECO_API", "http://127.0.0.1:4000/api/v1")


class Api:
    def __init__(self):
        self.csrf = None
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None):
        headers = {"Content-Type": "application/json"}
        if self.csrf:
            headers["x-csrf-token"] = self.csrf
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")
        except urllib.error.URLError as e:
            sys.exit(f"Cannot reach the API at {BASE}: {e.reason}. Is `npm run dev` running?")


def need(status, body, ok=(200, 201, 202), what=""):
    if status not in ok:
        sys.exit(f"{what} failed (HTTP {status}): {json.dumps(body.get('error', body), indent=2)}")
    return body["data"]


def km(m):
    return f"{m / 1000:.2f} km"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vehicles", type=int, default=3)
    ap.add_argument("--time-limit", type=int, default=10)
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--date", default=(datetime.date.today() + datetime.timedelta(days=1)).isoformat())
    args = ap.parse_args()

    password = os.environ.get("ECO_PASSWORD") or sys.exit("Set ECO_PASSWORD to the demo password printed by the seed.")
    api = Api()
    login = need(*api.call("POST", "/auth/login", {"email": "manager@ecosphere.demo", "password": password}), what="Login")
    api.csrf = login["csrfToken"]
    print(f"Logged in as {login['user']['email']} ({login['user']['role']})")

    depots = need(*api.call("GET", "/depots"), what="Depots")
    vehicles = [v for v in need(*api.call("GET", "/vehicles"), what="Vehicles") if v["status"] == "AVAILABLE"][: args.vehicles]
    if not depots or not vehicles:
        sys.exit("Need at least one depot and one AVAILABLE vehicle. Re-run the seed.")

    body = {
        "plannedDate": args.date, "depotId": depots[0]["id"], "vehicleIds": [v["id"] for v in vehicles],
        "objective": "MIN_DISTANCE", "timeLimitS": args.time_limit,
    }
    job = need(*api.call("POST", "/optimization/jobs", body), what="Create job")
    print(f"Job {job['id']}: {job['binCount']} bins, {job['vehicleCount']} vehicles, date {job['plannedDate']}")

    deadline = time.time() + args.time_limit + 120
    while True:
        job = need(*api.call("GET", f"/optimization/jobs/{job['id']}"), what="Poll job")
        if job["status"] not in ("QUEUED", "RUNNING"):
            break
        if time.time() > deadline:
            sys.exit("Timed out waiting for the job.")
        time.sleep(1)
    print(f"Job status: {job['status']}" + (f" - {job['error']}" if job["error"] else ""))
    if job["status"] != "SUCCEEDED":
        sys.exit(1)

    r = need(*api.call("GET", f"/optimization/jobs/{job['id']}/result"), what="Result")
    print(f"\nSolver status: {r['solverStatus']}   validated: {r['validated']}   cost source: {r['costSource']}")
    for w in r["warnings"]:
        print(f"WARNING: {w}")
    if r["costSource"] == "STRAIGHT_LINE_APPROX":
        print("NOTE: distances are straight-line approximations, not road distances.")

    vcode = {v["id"]: v["code"] for v in vehicles}
    print("\nRoutes:")
    for route in r["routes"]:
        if route["stops"]:
            print(f"  {vcode.get(route['vehicle_id'], route['vehicle_id'])}: {len(route['stops'])} stops, {km(route['distance_m'])}, "
                  f"{route['duration_s'] // 60} min, load {route['load_l']} L ({route['utilization_percent']}% of capacity)")
    print(f"\nUnassigned bins: {len(r['unassigned'])}")
    for u in r["unassigned"][:10]:
        print(f"  {r['bins'].get(u['bin_id'], {}).get('code', u['bin_id'])}: {u['reason']} - {u['detail']}")

    c = r["comparison"]
    print("\nBaseline comparison (nearest-neighbor, same bins/constraints):")
    if c["comparable"]:
        print(f"  baseline {km(c['baseline_distance_m'])}  optimized {km(c['optimized_distance_m'])}  "
              f"reduction {c['distance_reduction_percent']}%")
    else:
        print(f"  not available: {c['note']}")

    if args.save:
        routes = need(*api.call("POST", f"/optimization/jobs/{job['id']}/plan", {}), what="Save plan")
        for route in routes:
            st, resp = api.call("POST", f"/routes/{route['id']}/publish", {"version": 1})
            if st == 200:
                print(f"Published {route['code']}")
            else:
                print(f"Could not publish {route['code']}: {resp.get('error', {}).get('message')}")


if __name__ == "__main__":
    main()
