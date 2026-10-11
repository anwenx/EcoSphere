"""Deterministic nearest-neighbor baseline using the SAME eligible bins, vehicles, matrices and constraints
(capacity, max stops, max duration, time windows) as the optimizer. Vehicles are filled one after another
(largest capacity first, ties by id); each repeatedly drives to the nearest feasible unserved bin (ties by index)."""
from .problem import Problem


def nearest_neighbor(p: Problem) -> list[list[int]]:
    unserved = set(range(1, p.n))
    routes: list[list[int]] = [[] for _ in p.vehicles]
    order = sorted(range(len(p.vehicles)), key=lambda k: (-p.vehicles[k].capacity, p.vehicles[k].id))

    for k in order:
        v = p.vehicles[k]
        cur, t, load = 0, 0, 0
        while unserved and len(routes[k]) < v.max_stops:
            best = None
            for j in sorted(unserved):
                if load + p.demand[j] > v.capacity:
                    continue
                start = t + p.dur[cur][j]
                w = p.window[j]
                if w is not None:
                    start = max(start, w[0])
                    if start > w[1]:
                        continue
                finish = start + p.service[j]
                if finish + p.dur[j][0] > v.max_duration_s:
                    continue
                key = (p.dist[cur][j], j)
                if best is None or key < best[0]:
                    best = (key, j, finish)
            if best is None:
                break
            _, j, finish = best
            routes[k].append(j)
            unserved.discard(j)
            load += p.demand[j]
            t, cur = finish, j
    return routes
