import math

from .schemas import BinIn, Coord, TravelMatrix

EARTH_RADIUS_M = 6_371_000.0
DEFAULT_SPEED_KMH = 25.0  # assumption for the straight-line fallback only


class InputError(ValueError):
    """Invalid optimizer input that passed schema validation (e.g., inconsistent matrix shape)."""


def haversine_m(a: Coord, b: Coord) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dphi = p2 - p1
    dlmb = math.radians(b.lng - a.lng)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def approximate_matrices(depot: Coord, bins: list[BinIn], speed_kmh: float = DEFAULT_SPEED_KMH):
    """Straight-line (great-circle) distances. NOT road distances; callers must label the result as approximate."""
    pts: list[Coord] = [depot, *bins]
    n = len(pts)
    ms = speed_kmh * 1000 / 3600
    dist = [[0] * n for _ in range(n)]
    dur = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                d = round(haversine_m(pts[i], pts[j]))
                dist[i][j] = d
                dur[i][j] = round(d / ms)
    return dist, dur


def validate_matrix(m: TravelMatrix, n: int) -> None:
    for name, mat in (("distance_m", m.distance_m), ("duration_s", m.duration_s)):
        if len(mat) != n or any(len(row) != n for row in mat):
            raise InputError(f"{name} must be {n}x{n} (depot + {n - 1} bins); got a different shape")
