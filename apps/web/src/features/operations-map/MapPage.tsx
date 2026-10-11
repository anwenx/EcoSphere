
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Layers3,
  MapPin,
  Navigation,
  RefreshCw,
  Route as RouteIcon,
  Truck,
  X,
} from "lucide-react";
import { api } from "../../lib/api";

interface Bin {
  id: string;
  code: string;
  type?: string;
  lat: number | string | null;
  lng: number | string | null;
  fillPercent: number | string | null;
  capacityLiters?: number | string | null;
  status?: string;
  zoneCode?: string | null;
  zone?: { name?: string } | null;
  lastCollectedAt?: string | null;
}

interface Vehicle {
  id: string;
  code: string;
  type: string;
  capacityLiters: number;
  status: string;
  driverName: string | null;
  locationAt: string | Date | null;
  locationOrigin: string;
  origin: string;
  lat: number | string | null;
  lng: number | string | null;
}

interface RouteSummary {
  id: string;
  code: string;
  plannedDate: string;
  status: string;
  vehicle: { id: string; code: string } | null;
  driver: { id: string; name: string } | null;
  stopCount: number;
  totalDistanceM?: number | null;
}

interface RouteStop {
  id: string;
  stopOrder: number;
  status: string;
  binId: string;
  binCode: string;
  lat: number | string;
  lng: number | string;
  fillPercent: number | string;
  estimatedArrival: string | null;
  collectedAt: string | null;
}

interface RouteDetail extends RouteSummary {
  depot: {
    id: string;
    name: string;
    lat: number | string;
    lng: number | string;
  } | null;
  stops: RouteStop[];
  progress: {
    total: number;
    completed: number;
    remaining: number;
  };
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: { total?: number; count?: number };
}

type Selection =
  | { type: "bin"; id: string }
  | { type: "vehicle"; id: string }
  | { type: "route"; id: string }
  | null;

const COLORS = {
  green: "#a3e635",
  blue: "#38bdf8",
  red: "#fb5252",
  amber: "#f59e0b",
  yellow: "#eab308",
  muted: "#737b73",
  black: "#050605",
  panel: "#0d0f0d",
  border: "#292e29",
};

const ROUTE_SOURCE = "ecosphere-route-lines";
const ROUTE_CASING = "ecosphere-route-casing";
const ROUTE_LAYER = "ecosphere-route-line";

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCoordinates(
  latValue: unknown,
  lngValue: unknown,
): [number, number] | null {
  const lat = numberValue(latValue);
  const lng = numberValue(lngValue);

  if (
    lat === null ||
    lng === null ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }

  return [lng, lat];
}

function fillValue(bin: Bin): number | null {
  const value = numberValue(bin.fillPercent);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function binColor(fill: number | null): string {
  if (fill === null) return "#929992";
  if (fill >= 81) return COLORS.red;
  if (fill >= 61) return COLORS.amber;
  if (fill >= 31) return COLORS.yellow;
  return COLORS.green;
}

function priorityLabel(fill: number | null): string {
  if (fill === null) return "Unknown";
  if (fill >= 81) return "Critical";
  if (fill >= 61) return "High";
  if (fill >= 31) return "Medium";
  return "Low";
}

function vehicleColor(status: string): string {
  switch (status.toUpperCase()) {
    case "ON_ROUTE":
      return COLORS.blue;
    case "AVAILABLE":
      return COLORS.green;
    case "MAINTENANCE":
      return COLORS.amber;
    case "UNAVAILABLE":
      return COLORS.red;
    default:
      return "#a78bfa";
  }
}

function sourceLabel(source: string): string {
  switch ((source || "").toUpperCase()) {
    case "REAL":
      return "Real location";
    case "DEMO":
      return "Demo location";
    case "SIMULATED":
      return "Simulated location";
    default:
      return `Location source: ${source || "unknown"}`;
  }
}

function readableStatus(status: string): string {
  return (status || "UNKNOWN").replaceAll("_", " ").toLowerCase();
}

function safeDate(value: string | Date | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function formatDistance(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(Number(meters))) return "—";
  const distance = Number(meters);
  return distance >= 1000
    ? `${(distance / 1000).toFixed(1)} km`
    : `${Math.round(distance)} m`;
}

function routeCoordinates(route: RouteDetail): [number, number][] {
  const points: [number, number][] = [];

  if (route.depot) {
    const depot = validCoordinates(route.depot.lat, route.depot.lng);
    if (depot) points.push(depot);
  }

  [...(route.stops ?? [])]
    .sort((a, b) => a.stopOrder - b.stopOrder)
    .forEach((stop) => {
      const point = validCoordinates(stop.lat, stop.lng);
      if (point) points.push(point);
    });

  return points;
}

function ensureRouteLayers(map: MapLibreMap): void {
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }

  if (!map.getLayer(ROUTE_CASING)) {
    map.addLayer({
      id: ROUTE_CASING,
      type: "line",
      source: ROUTE_SOURCE,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#000000",
        "line-width": 10,
        "line-opacity": 0.95,
      },
    });
  }

  if (!map.getLayer(ROUTE_LAYER)) {
    map.addLayer({
      id: ROUTE_LAYER,
      type: "line",
      source: ROUTE_SOURCE,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["get", "width"],
        "line-opacity": 1,
      },
    });
  }
}

function setRouteFeatures(
  map: MapLibreMap,
  routes: RouteDetail[],
  selectedRouteId: string | null,
  showRoutes: boolean,
): void {
  ensureRouteLayers(map);

  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  if (showRoutes) {
    routes.forEach((route) => {
      const coordinates = routeCoordinates(route);
      if (coordinates.length < 2) return;

      const selected = route.id === selectedRouteId;

      features.push({
        type: "Feature",
        properties: {
          routeId: route.id,
          routeCode: route.code,
          color: selected ? COLORS.green : COLORS.blue,
          width: selected ? 6 : 3.5,
        },
        geometry: {
          type: "LineString",
          coordinates,
        },
      });
    });
  }

  const source = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;

  source?.setData({
    type: "FeatureCollection",
    features,
  });

  // Keep route lines above basemap labels and below HTML markers.
  if (map.getLayer(ROUTE_CASING)) {
    map.moveLayer(ROUTE_CASING);
  }
  if (map.getLayer(ROUTE_LAYER)) {
    map.moveLayer(ROUTE_LAYER);
  }
}

function applyDarkMapStyle(map: MapLibreMap): void {
  const layers = map.getStyle().layers ?? [];

  for (const layer of layers) {
    try {
      if (layer.type === "background") {
        map.setPaintProperty(layer.id, "background-color", "#050505");
      }

      if (layer.type === "symbol" && layer.layout?.["text-field"]) {
        map.setPaintProperty(layer.id, "text-color", "#a4aaa4");
        map.setPaintProperty(layer.id, "text-halo-color", "#050505");
        map.setPaintProperty(layer.id, "text-halo-width", 1.4);
      }

      if (layer.type === "line") {
        const id = layer.id.toLowerCase();

        if (id.includes("road") || id.includes("transport")) {
          map.setPaintProperty(layer.id, "line-color", "#292d29");
        }

        if (id.includes("boundary")) {
          map.setPaintProperty(layer.id, "line-color", "#303530");
        }
      }

      if (layer.type === "fill") {
        const id = layer.id.toLowerCase();

        if (
          id.includes("water") ||
          id.includes("waterway")
        ) {
          map.setPaintProperty(layer.id, "fill-color", "#080d0b");
        } else if (
          id.includes("building") ||
          id.includes("landcover") ||
          id.includes("landuse")
        ) {
          map.setPaintProperty(layer.id, "fill-color", "#090b09");
        }
      }
    } catch {
      // Some third-party style layers don't support these paint properties.
    }
  }
}

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const binMarkersRef = useRef<maplibregl.Marker[]>([]);
  const vehicleMarkersRef = useRef<maplibregl.Marker[]>([]);
  const stopMarkersRef = useRef<maplibregl.Marker[]>([]);
  const hasFittedInitialView = useRef(false);

  const [selection, setSelection] = useState<Selection>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [showBins, setShowBins] = useState(true);
  const [showVehicles, setShowVehicles] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);

  const binsQuery = useQuery<ApiResponse<Bin[]>>({
    queryKey: ["bins-map"],
    queryFn: () => api<ApiResponse<Bin[]>>("/bins?limit=120"),
    retry: 1,
  });

  const vehiclesQuery = useQuery<ApiResponse<Vehicle[]>>({
    queryKey: ["vehicles-map"],
    queryFn: () => api<ApiResponse<Vehicle[]>>("/vehicles"),
    retry: 1,
  });

  const routesQuery = useQuery<ApiResponse<RouteSummary[]>>({
    queryKey: ["routes-map"],
    queryFn: () =>
      api<ApiResponse<RouteSummary[]>>("/routes?page=1&pageSize=50"),
    retry: 1,
  });

  const bins = Array.isArray(binsQuery.data?.data) ? binsQuery.data.data : [];
  const vehicles = Array.isArray(vehiclesQuery.data?.data)
    ? vehiclesQuery.data.data
    : [];
  const routes = Array.isArray(routesQuery.data?.data)
    ? routesQuery.data.data
    : [];

  const routeDetailsQuery = useQuery<RouteDetail[]>({
    queryKey: ["routes-map-details", routes.map((route) => route.id)],
    enabled: routes.length > 0,
    queryFn: async () => {
      const results = await Promise.allSettled(
        routes.map(async (route) => {
          const response = await api<ApiResponse<RouteDetail>>(
            `/routes/${route.id}`,
          );
          return response.data;
        }),
      );

      const details: RouteDetail[] = [];
      const failed: string[] = [];

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          details.push(result.value);
        } else {
          failed.push(routes[index].code);
        }
      });

      if (failed.length > 0) {
        console.warn("Could not load route details:", failed);
      }

      return details;
    },
    retry: 1,
  });

  const routeDetails = routeDetailsQuery.data ?? [];

  const locatedBins = useMemo(
    () => bins.filter((bin) => validCoordinates(bin.lat, bin.lng)),
    [bins],
  );

  const locatedVehicles = useMemo(
    () =>
      vehicles.filter((vehicle) =>
        validCoordinates(vehicle.lat, vehicle.lng),
      ),
    [vehicles],
  );

  const selectedBin =
    selection?.type === "bin"
      ? bins.find((bin) => bin.id === selection.id)
      : undefined;

  const selectedVehicle =
    selection?.type === "vehicle"
      ? vehicles.find((vehicle) => vehicle.id === selection.id)
      : undefined;

  const selectedRoute =
    selection?.type === "route"
      ? routeDetails.find((route) => route.id === selection.id)
      : undefined;

  const counts = useMemo(() => {
    const result = { critical: 0, high: 0, medium: 0, low: 0 };

    bins.forEach((bin) => {
      const fill = fillValue(bin);
      if (fill === null) return;
      if (fill >= 81) result.critical += 1;
      else if (fill >= 61) result.high += 1;
      else if (fill >= 31) result.medium += 1;
      else result.low += 1;
    });

    return result;
  }, [bins]);

  const activeVehicles = vehicles.filter(
    (vehicle) => vehicle.status.toUpperCase() === "ON_ROUTE",
  ).length;

  const criticalBins = counts.critical;

  const totalStops = routeDetails.reduce(
    (sum, route) => sum + (route.stops?.length ?? 0),
    0,
  );

  const completedStops = routeDetails.reduce(
    (sum, route) => sum + (route.progress?.completed ?? 0),
    0,
  );

  const routesWithCoordinates = routeDetails.filter(
    (route) => routeCoordinates(route).length >= 2,
  ).length;

  const isRefreshing =
    binsQuery.isFetching ||
    vehiclesQuery.isFetching ||
    routesQuery.isFetching ||
    routeDetailsQuery.isFetching;

  const refreshAll = useCallback(() => {
    void binsQuery.refetch();
    void vehiclesQuery.refetch();
    void routesQuery.refetch();
    void routeDetailsQuery.refetch();
  }, [binsQuery, vehiclesQuery, routesQuery, routeDetailsQuery]);

  const flyToCoordinates = useCallback(
    (coordinates: [number, number], zoom = 14) => {
      mapRef.current?.flyTo({
        center: coordinates,
        zoom,
        duration: 700,
        essential: true,
      });
    },
    [],
  );

  const fitRoute = useCallback(
    (route: RouteDetail) => {
      const points = routeCoordinates(route);
      const map = mapRef.current;

      if (!map || points.length === 0) return;

      if (points.length === 1) {
        flyToCoordinates(points[0], 14);
        return;
      }

      const bounds = new maplibregl.LngLatBounds();
      points.forEach((point) => bounds.extend(point));

      map.fitBounds(bounds, {
        padding: 100,
        maxZoom: 15,
        duration: 700,
      });
    },
    [flyToCoordinates],
  );

  // Initialize the map once.
  useEffect(() => {
    const container = mapContainer.current;
    if (!container || mapRef.current) return;

    let map: MapLibreMap;

    try {
      map = new maplibregl.Map({
        container,
        style: "https://tiles.openfreemap.org/styles/dark",
        center: [77.5946, 12.9716],
        zoom: 11,
        attributionControl: { compact: true },
        renderWorldCopies: false,
      });

      mapRef.current = map;

      map.addControl(new maplibregl.NavigationControl(), "top-right");
      map.addControl(
        new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }),
        "bottom-right",
      );

      map.on("load", () => {
        applyDarkMapStyle(map);

        try {
          ensureRouteLayers(map);
        } catch (error) {
          console.error("Could not initialize route layers:", error);
        }

        setMapError(null);
      });

      map.on("error", (event) => {
        if (event.error) {
          console.error("MapLibre error:", event.error);
          setMapError(
            "Map tiles or map data could not be loaded. Check your internet connection.",
          );
        }
      });
    } catch (error) {
      console.error("Map initialization failed:", error);
      setMapError("The map could not be initialized in this browser.");
    }

    return () => {
      binMarkersRef.current.forEach((marker) => marker.remove());
      vehicleMarkersRef.current.forEach((marker) => marker.remove());
      stopMarkersRef.current.forEach((marker) => marker.remove());

      binMarkersRef.current = [];
      vehicleMarkersRef.current = [];
      stopMarkersRef.current = [];

      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Redraw route lines whenever the routes, selection, or layer visibility changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const draw = () => {
      try {
        setRouteFeatures(
          map,
          routeDetails,
          selection?.type === "route" ? selection.id : null,
          showRoutes,
        );
      } catch (error) {
        console.error("Route drawing failed:", error);
      }

      stopMarkersRef.current.forEach((marker) => marker.remove());
      stopMarkersRef.current = [];

      if (!showRoutes) return;

      routeDetails.forEach((route) => {
        const selected = selection?.type === "route" && selection.id === route.id;

        [...(route.stops ?? [])]
          .sort((a, b) => a.stopOrder - b.stopOrder)
          .forEach((stop) => {
            const coordinates = validCoordinates(stop.lat, stop.lng);
            if (!coordinates) return;

            const completed = stop.status.toUpperCase() === "COMPLETED";
            const element = document.createElement("button");

            element.type = "button";
            element.textContent = String(stop.stopOrder);
            element.title = `${route.code} · Stop ${stop.stopOrder} · ${stop.binCode} · ${readableStatus(stop.status)}`;
            element.setAttribute("aria-label", element.title);

            element.style.cssText = `
              width:26px;height:26px;border-radius:50%;
              border:2px solid ${selected ? "#f4f5f4" : "#242924"};
              background:${completed ? "#a3e635" : selected ? "#d9f99d" : "#38bdf8"};
              color:#050505;font:800 11px/1 system-ui,sans-serif;
              cursor:pointer;display:flex;align-items:center;justify-content:center;
              box-shadow:0 0 ${selected ? 14 : 7}px ${selected ? "#a3e63599" : "#000c"};
            `;

            element.addEventListener("click", () => {
              setSelection({ type: "route", id: route.id });
              flyToCoordinates(coordinates, 15);
            });

            stopMarkersRef.current.push(
              new maplibregl.Marker({ element, anchor: "center" })
                .setLngLat(coordinates)
                .addTo(map),
            );
          });
      });
    };

    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);

    return () => {
      map.off("load", draw);
      stopMarkersRef.current.forEach((marker) => marker.remove());
      stopMarkersRef.current = [];
    };
  }, [routeDetails, showRoutes, selection, flyToCoordinates]);

  // Draw bin markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const draw = () => {
      binMarkersRef.current.forEach((marker) => marker.remove());
      binMarkersRef.current = [];

      if (!showBins) return;

      locatedBins.forEach((bin) => {
        const coordinates = validCoordinates(bin.lat, bin.lng);
        if (!coordinates) return;

        const fill = fillValue(bin);
        const color = binColor(fill);
        const wrapper = document.createElement("div");
        wrapper.style.cssText =
          "display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;";

        const button = document.createElement("button");
        button.type = "button";
        button.title = `${bin.code} · ${priorityLabel(fill)} · ${fill === null ? "Fill unknown" : `${fill}% full`}`;
        button.setAttribute("aria-label", button.title);
        button.style.cssText = `
          width:31px;height:31px;border:2px solid #f4f5f4;
          border-radius:9px;background:${color};color:#080908;
          box-shadow:0 3px 12px #000b;cursor:pointer;
          font-size:18px;font-weight:800;line-height:1;
        `;
        button.textContent = "▤";

        if (fill !== null && fill >= 81) {
          button.style.animation =
            "ecosphere-critical-pulse 1.6s ease-in-out infinite";
        }

        const label = document.createElement("span");
        label.textContent = bin.code || bin.id;
        label.style.cssText = `
          max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          padding:3px 5px;border-radius:5px;color:#f4f5f4;
          background:rgba(5,6,5,.94);border:1px solid #303630;
          font:600 10px/1.2 system-ui,sans-serif;box-shadow:0 2px 6px #0009;
          pointer-events:none;
        `;

        button.addEventListener("click", () => {
          setSelection({ type: "bin", id: bin.id });
          flyToCoordinates(coordinates, 14);
        });

        wrapper.append(button, label);
        binMarkersRef.current.push(
          new maplibregl.Marker({ element: wrapper, anchor: "bottom" })
            .setLngLat(coordinates)
            .addTo(map),
        );
      });
    };

    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);

    return () => {
      map.off("load", draw);
      binMarkersRef.current.forEach((marker) => marker.remove());
      binMarkersRef.current = [];
    };
  }, [locatedBins, showBins, flyToCoordinates]);

  // Draw vehicle markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const draw = () => {
      vehicleMarkersRef.current.forEach((marker) => marker.remove());
      vehicleMarkersRef.current = [];

      if (!showVehicles) return;

      locatedVehicles.forEach((vehicle) => {
        const coordinates = validCoordinates(vehicle.lat, vehicle.lng);
        if (!coordinates) return;

        const color = vehicleColor(vehicle.status);
        const wrapper = document.createElement("div");
        wrapper.style.cssText =
          "display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;";

        const button = document.createElement("button");
        button.type = "button";
        button.title = `${vehicle.code} · ${vehicle.status} · ${sourceLabel(vehicle.locationOrigin)}`;
        button.setAttribute("aria-label", button.title);
        button.style.cssText = `
          width:39px;height:39px;border-radius:12px;
          border:1px solid ${color};background:#080a08;color:${color};
          box-shadow:0 0 0 3px ${color}20,0 4px 14px #000c;
          display:flex;align-items:center;justify-content:center;cursor:pointer;
        `;

        const icon = document.createElement("span");
        icon.textContent = "🚛";
        icon.style.cssText = "font-size:21px;line-height:1;";
        button.appendChild(icon);

        const label = document.createElement("span");
        label.textContent = vehicle.code;
        label.style.cssText = `
          padding:3px 5px;border-radius:5px;background:#080a08;
          border:1px solid ${color}99;color:#f4f5f4;
          font:700 10px/1.2 system-ui,sans-serif;white-space:nowrap;
          box-shadow:0 2px 8px #000b;
        `;

        button.addEventListener("click", () => {
          setSelection({ type: "vehicle", id: vehicle.id });
          flyToCoordinates(coordinates, 14);
        });

        wrapper.append(button, label);

        vehicleMarkersRef.current.push(
          new maplibregl.Marker({ element: wrapper, anchor: "bottom" })
            .setLngLat(coordinates)
            .addTo(map),
        );
      });
    };

    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);

    return () => {
      map.off("load", draw);
      vehicleMarkersRef.current.forEach((marker) => marker.remove());
      vehicleMarkersRef.current = [];
    };
  }, [locatedVehicles, showVehicles, flyToCoordinates]);

  // Fit the initial map view once after real API coordinates arrive.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasFittedInitialView.current) return;

    const points: [number, number][] = [
      ...locatedBins.map((bin) => validCoordinates(bin.lat, bin.lng)),
      ...locatedVehicles.map((vehicle) =>
        validCoordinates(vehicle.lat, vehicle.lng),
      ),
    ].filter((point): point is [number, number] => point !== null);

    if (points.length === 0) return;

    const fit = () => {
      if (hasFittedInitialView.current) return;

      const bounds = new maplibregl.LngLatBounds();
      points.forEach((point) => bounds.extend(point));

      map.fitBounds(bounds, {
        padding: 75,
        maxZoom: 13,
        duration: 650,
      });

      hasFittedInitialView.current = true;
    };

    if (map.isStyleLoaded()) fit();
    else map.once("load", fit);

    return () => {
      map.off("load", fit);
    };
  }, [locatedBins, locatedVehicles]);

  const layerItems = [
    {
      label: "Waste bins",
      detail: `${locatedBins.length} mapped`,
      color: COLORS.green,
      checked: showBins,
      toggle: () => setShowBins((value) => !value),
    },
    {
      label: "Fleet vehicles",
      detail: `${locatedVehicles.length} located`,
      color: COLORS.blue,
      checked: showVehicles,
      toggle: () => setShowVehicles((value) => !value),
    },
    {
      label: "Route lines and stops",
      detail: `${routesWithCoordinates} drawable routes`,
      color: COLORS.green,
      checked: showRoutes,
      toggle: () => setShowRoutes((value) => !value),
    },
  ];

  return (
    <div className="flex h-full min-h-[600px] flex-col overflow-hidden rounded-2xl border border-[#252925] bg-[#050505] text-[#f4f5f4]">
      <style>{`
        @keyframes ecosphere-critical-pulse {
          0%,100% { box-shadow:0 2px 8px #0009; transform:scale(1); }
          50% { box-shadow:0 0 0 6px #fb525226,0 3px 12px #fb525266; transform:scale(1.05); }
        }
        .maplibregl-map { background:#050505!important; }
        .maplibregl-ctrl-group {
          overflow:hidden!important;
          border:1px solid #303630!important;
          border-radius:10px!important;
          background:#0b0d0b!important;
          box-shadow:0 5px 20px #0009!important;
        }
        .maplibregl-ctrl-group button { background-color:#0b0d0b!important; }
        .maplibregl-ctrl-group button:hover { background-color:#1a201a!important; }
        .maplibregl-ctrl-group button span { filter:invert(1); }
        .maplibregl-ctrl-attrib {
          background:rgba(5,6,5,.88)!important;color:#a1a8a1!important;
        }
        .maplibregl-ctrl-attrib a { color:#a3e635!important; }
        .maplibregl-ctrl-scale {
          color:#c5ccc5!important;
          background:#080a08!important;
          border:1px solid #353b35!important;
        }
      `}</style>

      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#252925] bg-[#080908] px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#a3e635]/20 bg-[#a3e635]/[0.07]">
            <Navigation className="h-5 w-5 text-[#a3e635]" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-[#f4f5f4]">
                Operations Command Center
              </h1>
              <span className="rounded-full border border-[#a3e635]/25 bg-[#a3e635]/[0.07] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#a3e635]">
                Map online
              </span>
            </div>
            <p className="mt-1 text-xs text-[#929992]">
              Bengaluru · Fleet, collection routes and waste-bin monitoring
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={refreshAll}
          disabled={isRefreshing}
          className="flex items-center gap-2 rounded-xl border border-[#303630] bg-[#101210] px-4 py-2.5 text-sm font-semibold text-[#e6e9e6] transition hover:border-[#a3e635]/50 hover:bg-[#171b17] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 text-[#a3e635] ${isRefreshing ? "animate-spin" : ""}`}
          />
          Refresh data
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 border-b border-[#252925] bg-[#050505] p-4 lg:grid-cols-4">
        <StatCard
          label="Mapped bins"
          value={String(locatedBins.length)}
          suffix={`/ ${bins.length}`}
          detail={`${criticalBins} critical fill levels`}
          icon={<MapPin className="h-4 w-4 text-[#a3e635]" />}
        />
        <StatCard
          label="Fleet vehicles"
          value={String(vehicles.length)}
          detail={`${locatedVehicles.length} located · ${activeVehicles} on route`}
          icon={<Truck className="h-4 w-4 text-[#38bdf8]" />}
        />
        <StatCard
          label="Planned routes"
          value={String(routes.length)}
          detail={
            routeDetailsQuery.isFetching
              ? "Loading route stops…"
              : `${totalStops} stops · ${routesWithCoordinates} drawable routes`
          }
          icon={<RouteIcon className="h-4 w-4 text-[#a3e635]" />}
        />
        <StatCard
          label="Collections completed"
          value={String(completedStops)}
          detail={`From ${routeDetails.length} loaded routes`}
          icon={<CheckCircle2 className="h-4 w-4 text-[#a3e635]" />}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="z-10 w-full shrink-0 overflow-y-auto border-b border-[#252925] bg-[#080908] md:w-[350px] md:border-b-0 md:border-r">
          <div className="border-b border-[#252925] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#e9ece9]">Map layers</h2>
              <Layers3 className="h-4 w-4 text-[#929992]" />
            </div>

            <div className="space-y-2">
              {layerItems.map((layer) => (
                <label
                  key={layer.label}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-[#252925] bg-[#0d0f0d] px-3 py-2.5 transition hover:border-[#414941]"
                >
                  <input
                    type="checkbox"
                    checked={layer.checked}
                    onChange={layer.toggle}
                    className="h-4 w-4 accent-[#a3e635]"
                  />
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: layer.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-[#e2e6e2]">
                      {layer.label}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-[#929992]">
                      {layer.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="border-b border-[#252925] p-4">
            <h2 className="mb-3 text-sm font-semibold text-[#e9ece9]">Bin priority</h2>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["Critical", counts.critical, COLORS.red, "81–100%"],
                ["High", counts.high, COLORS.amber, "61–80%"],
                ["Medium", counts.medium, COLORS.yellow, "31–60%"],
                ["Low", counts.low, COLORS.green, "0–30%"],
              ].map(([label, count, color, range]) => (
                <div
                  key={String(label)}
                  className="rounded-lg border border-[#252925] bg-[#0d0f0d] p-3"
                >
                  <div className="flex items-center gap-2 text-xs text-[#929992]">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: String(color) }}
                    />
                    {label}
                  </div>
                  <div className="mt-1 text-xl font-bold text-[#f4f5f4]">{count}</div>
                  <div className="mt-1 text-[10px] text-[#737b73]">{range} full</div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-b border-[#252925] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#e9ece9]">Fleet</h2>
              <span className="text-[10px] text-[#737b73]">{vehicles.length} total</span>
            </div>

            {vehiclesQuery.isLoading && (
              <p className="text-xs text-[#929992]">Loading vehicles…</p>
            )}
            {vehiclesQuery.isError && (
              <p role="alert" className="text-xs text-[#ff9292]">
                Could not load fleet. Check API access and permissions.
              </p>
            )}
            {!vehiclesQuery.isLoading && !vehiclesQuery.isError && vehicles.length === 0 && (
              <p className="text-xs text-[#737b73]">No vehicles were returned by the API.</p>
            )}

            <div className="space-y-2">
              {vehicles.map((vehicle) => {
                const coordinates = validCoordinates(vehicle.lat, vehicle.lng);
                const color = vehicleColor(vehicle.status);
                const active =
                  selection?.type === "vehicle" && selection.id === vehicle.id;

                return (
                  <button
                    key={vehicle.id}
                    type="button"
                    onClick={() => {
                      setSelection({ type: "vehicle", id: vehicle.id });
                      if (coordinates) flyToCoordinates(coordinates, 14);
                    }}
                    className={`w-full rounded-xl border p-3 text-left transition ${active
                        ? "border-[#38bdf8]/60 bg-[#38bdf8]/[0.06]"
                        : "border-[#252925] bg-[#0d0f0d] hover:border-[#414941]"
                      }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-9 w-9 items-center justify-center rounded-lg"
                        style={{ background: `${color}14`, color }}
                      >
                        <Truck className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#f4f5f4]">
                          {vehicle.code}
                        </span>
                        <span className="mt-1 block text-[11px] text-[#929992]">
                          {vehicle.driverName || "No driver assigned"}
                        </span>
                      </span>
                      <span
                        className="rounded-full px-2 py-1 text-[9px] font-semibold uppercase"
                        style={{ color, background: `${color}14` }}
                      >
                        {readableStatus(vehicle.status)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[#737b73]">
                      <span>{coordinates ? sourceLabel(vehicle.locationOrigin) : "No coordinates"}</span>
                      <span>{vehicle.type}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#e9ece9]">Routes</h2>
              <span className="text-[10px] text-[#737b73]">{routes.length} loaded</span>
            </div>

            {routesQuery.isLoading && <p className="text-xs text-[#929992]">Loading routes…</p>}
            {routesQuery.isError && (
              <p role="alert" className="text-xs text-[#ff9292]">
                Could not load routes. Check API access and permissions.
              </p>
            )}
            {routeDetailsQuery.isError && (
              <p role="alert" className="mb-2 text-xs text-[#fbc76b]">
                Route details could not be loaded.
              </p>
            )}
            {!routesQuery.isLoading && !routesQuery.isError && routes.length === 0 && (
              <p className="text-xs text-[#929992]">
                No routes were returned by the API. Create or publish a route before expecting route lines.
              </p>
            )}

            <div className="space-y-2">
              {routes.map((route) => {
                const detail = routeDetails.find((item) => item.id === route.id);
                const active = selection?.type === "route" && selection.id === route.id;
                const canDraw = detail ? routeCoordinates(detail).length >= 2 : false;
                const progress = detail?.progress;
                const progressPercent = progress?.total
                  ? Math.min(100, (progress.completed / progress.total) * 100)
                  : 0;

                return (
                  <button
                    key={route.id}
                    type="button"
                    onClick={() => {
                      setSelection({ type: "route", id: route.id });
                      if (detail) fitRoute(detail);
                    }}
                    className={`w-full rounded-xl border p-3 text-left transition ${active
                        ? "border-[#a3e635]/60 bg-[#a3e635]/[0.06]"
                        : "border-[#252925] bg-[#0d0f0d] hover:border-[#414941]"
                      }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: active ? COLORS.green : COLORS.blue }}
                      />
                      <span className="flex-1 text-sm font-semibold text-[#f4f5f4]">
                        {route.code}
                      </span>
                      <span className="text-[9px] uppercase text-[#929992]">
                        {readableStatus(route.status)}
                      </span>
                    </div>
                    <div className="mt-2 text-[11px] text-[#929992]">
                      {route.vehicle?.code || "Unassigned vehicle"} · {route.stopCount} stops
                    </div>
                    {detail && (
                      <>
                        <div className="mt-2 flex items-center justify-between text-[10px] text-[#737b73]">
                          <span>{progress?.completed ?? 0}/{progress?.total ?? 0} completed</span>
                          <span>{formatDistance(route.totalDistanceM)}</span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#242924]">
                          <div
                            className="h-full rounded-full bg-[#a3e635]"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                        <div className={`mt-2 text-[10px] ${canDraw ? "text-[#a3e635]" : "text-[#fbc76b]"}`}>
                          {canDraw
                            ? "Coordinates available · Select to view"
                            : "Missing valid route coordinates"}
                        </div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="relative min-h-[450px] flex-1 bg-[#050505]">
          <div ref={mapContainer} className="absolute inset-0" />

          <div className="pointer-events-none absolute left-3 top-3 z-10">
            <div className="rounded-lg border border-[#303630] bg-[#080908]/95 px-3 py-2 shadow-xl backdrop-blur">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#e9ece9]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#a3e635]" />
                OPERATIONS VIEW
              </div>
              <div className="mt-1 text-[10px] text-[#929992]">Connected API data</div>
            </div>
          </div>

          <div className="pointer-events-none absolute bottom-4 left-3 z-10 max-w-[calc(100%-24px)] rounded-xl border border-[#303630] bg-[#080908]/95 p-3 shadow-xl backdrop-blur">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#c6cbc6]">
              Map legend
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-[#c6cbc6]">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.red }} />
                Critical bin
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.amber }} />
                High bin
              </span>
              <span className="flex items-center gap-1.5">
                <Truck className="h-3.5 w-3.5 text-[#38bdf8]" />
                Vehicle
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-4 rounded-full bg-[#a3e635]" />
                Selected route
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#38bdf8]" />
                Route stop
              </span>
            </div>
          </div>

          {mapError && (
            <div
              role="alert"
              className="absolute inset-x-3 bottom-24 z-20 rounded-xl border border-[#f59e0b]/30 bg-[#0b0d0b]/95 p-3 text-xs text-[#fbc76b] shadow-xl"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {mapError}
              </div>
            </div>
          )}

          {routes.length > 0 && routeDetails.length > 0 && routesWithCoordinates === 0 && (
            <div className="absolute inset-x-4 top-1/2 z-20 -translate-y-1/2 rounded-xl border border-[#f59e0b]/25 bg-[#0b0d0b]/95 p-4 text-center shadow-xl md:inset-x-auto md:left-1/2 md:w-[min(440px,calc(100%-32px))] md:-translate-x-1/2">
              <AlertTriangle className="mx-auto h-6 w-6 text-[#f59e0b]" />
              <h2 className="mt-2 text-sm font-semibold text-[#f4f5f4]">Routes have no drawable coordinates</h2>
              <p className="mt-2 text-xs leading-5 text-[#929992]">
                The route records loaded, but fewer than two valid depot/stop coordinates were found for every route. Check the route detail API and the coordinates stored for its stops.
              </p>
            </div>
          )}

          {binsQuery.isError && vehiclesQuery.isError && routesQuery.isError && (
            <div className="absolute inset-x-4 top-1/2 z-20 -translate-y-1/2 rounded-xl border border-[#fb5252]/30 bg-[#0b0d0b]/95 p-5 text-center shadow-xl">
              <AlertTriangle className="mx-auto h-6 w-6 text-[#fb5252]" />
              <h2 className="mt-2 font-semibold text-[#f4f5f4]">Unable to load operations data</h2>
              <p className="mt-2 text-sm text-[#929992]">
                Check that the API is running and your account has the required permissions.
              </p>
              <button
                type="button"
                onClick={refreshAll}
                className="mt-4 rounded-lg border border-[#303630] bg-[#141714] px-4 py-2 text-sm hover:bg-[#202520]"
              >
                Try again
              </button>
            </div>
          )}

          {selection && (
            <div className="absolute right-3 top-3 z-10 w-[min(340px,calc(100%-24px))] rounded-2xl border border-[#303630] bg-[#080908]/95 p-4 shadow-2xl backdrop-blur-xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  {selection.type === "bin" && <MapPin className="h-4 w-4 text-[#a3e635]" />}
                  {selection.type === "vehicle" && <Truck className="h-4 w-4 text-[#38bdf8]" />}
                  {selection.type === "route" && <RouteIcon className="h-4 w-4 text-[#a3e635]" />}
                  <div>
                    <div className="text-sm font-bold text-[#f4f5f4]">
                      {selectedBin?.code || selectedVehicle?.code || selectedRoute?.code || "Map item"}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wider text-[#929992]">
                      {selection.type} details
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close details"
                  onClick={() => setSelection(null)}
                  className="rounded-lg p-1.5 text-[#929992] hover:bg-[#202520] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {selectedBin && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-[#252925] bg-[#0d0f0d] p-3">
                    <div className="flex items-end justify-between">
                      <span className="text-xs text-[#929992]">Fill level</span>
                      <span className="text-2xl font-bold" style={{ color: binColor(fillValue(selectedBin)) }}>
                        {fillValue(selectedBin) === null ? "—" : `${fillValue(selectedBin)}%`}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#242924]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${fillValue(selectedBin) ?? 0}%`, background: binColor(fillValue(selectedBin)) }}
                      />
                    </div>
                  </div>
                  <DetailRow label="Priority" value={priorityLabel(fillValue(selectedBin))} />
                  <DetailRow label="Status" value={selectedBin.status || "Unknown"} />
                  <DetailRow label="Zone" value={selectedBin.zone?.name || selectedBin.zoneCode || "Unknown"} />
                  <DetailRow label="Type" value={selectedBin.type || "Unknown"} />
                  <DetailRow label="Capacity" value={selectedBin.capacityLiters == null ? "—" : `${selectedBin.capacityLiters} L`} />
                  <DetailRow label="Last collected" value={safeDate(selectedBin.lastCollectedAt)} />
                </div>
              )}

              {selectedVehicle && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-[#252925] bg-[#0d0f0d] p-3">
                    <div className="flex items-center gap-3">
                      <Truck className="h-8 w-8" style={{ color: vehicleColor(selectedVehicle.status) }} />
                      <div>
                        <div className="text-sm font-semibold text-[#f4f5f4]">{selectedVehicle.type}</div>
                        <div className="mt-1 text-xs text-[#929992]">{readableStatus(selectedVehicle.status)}</div>
                      </div>
                    </div>
                  </div>
                  <DetailRow label="Driver" value={selectedVehicle.driverName || "Not assigned"} />
                  <DetailRow label="Location source" value={sourceLabel(selectedVehicle.locationOrigin)} />
                  <DetailRow label="Location timestamp" value={safeDate(selectedVehicle.locationAt)} />
                  <DetailRow label="Capacity" value={`${selectedVehicle.capacityLiters} L`} />
                  <DetailRow
                    label="Coordinates"
                    value={
                      validCoordinates(selectedVehicle.lat, selectedVehicle.lng)
                        ? `${Number(selectedVehicle.lat).toFixed(5)}, ${Number(selectedVehicle.lng).toFixed(5)}`
                        : "Not available"
                    }
                  />
                </div>
              )}

              {selection.type === "route" && !selectedRoute && (
                <p className="text-xs text-[#929992]">
                  Loading route details, or the route detail request failed.
                </p>
              )}

              {selectedRoute && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-[#252925] bg-[#0d0f0d] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#929992]">Route progress</span>
                      <span className="text-sm font-bold text-[#a3e635]">
                        {selectedRoute.progress.completed}/{selectedRoute.progress.total}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#242924]">
                      <div
                        className="h-full rounded-full bg-[#a3e635]"
                        style={{
                          width: `${selectedRoute.progress.total
                            ? (selectedRoute.progress.completed / selectedRoute.progress.total) * 100
                            : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                  <DetailRow label="Status" value={readableStatus(selectedRoute.status)} />
                  <DetailRow label="Planned date" value={safeDate(selectedRoute.plannedDate)} />
                  <DetailRow label="Vehicle" value={selectedRoute.vehicle?.code || "Not assigned"} />
                  <DetailRow label="Driver" value={selectedRoute.driver?.name || "Not assigned"} />
                  <DetailRow label="Remaining stops" value={String(selectedRoute.progress.remaining)} />
                  <DetailRow label="Distance" value={formatDistance(selectedRoute.totalDistanceM)} />

                  <div className="border-t border-[#252925] pt-3">
                    <div className="mb-2 text-xs font-semibold text-[#d9ded9]">Stop sequence</div>
                    <div className="max-h-40 space-y-2 overflow-y-auto">
                      {[...selectedRoute.stops]
                        .sort((a, b) => a.stopOrder - b.stopOrder)
                        .map((stop) => (
                          <div key={stop.id} className="flex items-center gap-2 rounded-lg bg-[#0d0f0d] p-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#202520] text-[10px] font-bold text-[#a3e635]">
                              {stop.stopOrder}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-[#f4f5f4]">{stop.binCode}</span>
                              <span className="mt-0.5 block text-[10px] text-[#929992]">{readableStatus(stop.status)}</span>
                            </span>
                            {stop.status === "COMPLETED" && <CheckCircle2 className="h-4 w-4 text-[#a3e635]" />}
                            {stop.estimatedArrival && (
                              <span className="text-[10px] text-[#737b73]">
                                {new Date(stop.estimatedArrival).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>

                  <p className="text-[10px] leading-4 text-[#737b73]">
                    Route preview connects the depot and stops in order with straight lines. It is not road-snapped navigation.
                  </p>

                  <button
                    type="button"
                    onClick={() => fitRoute(selectedRoute)}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#303630] bg-[#141714] px-3 py-2 text-xs font-semibold text-[#e9ece9] hover:border-[#a3e635]/40 hover:bg-[#1b201b]"
                  >
                    <Navigation className="h-3.5 w-3.5 text-[#a3e635]" />
                    Fit route on map
                  </button>
                </div>
              )}
            </div>
          )}

          {!selection && (
            <div className="absolute right-3 top-3 z-10 rounded-xl border border-[#303630] bg-[#080908]/95 px-3 py-2.5 text-xs text-[#c6cbc6] shadow-lg backdrop-blur">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-[#a3e635]" />
                Select a marker for details
              </div>
            </div>
          )}

          <div className="absolute bottom-4 right-3 z-10 flex items-center gap-1.5 rounded-lg border border-[#303630] bg-[#080908]/95 px-3 py-2 text-[10px] text-[#929992] shadow-lg">
            <Clock3 className="h-3.5 w-3.5" />
            Refresh to retrieve the latest API data
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
  detail,
  icon,
}: {
  label: string;
  value: string;
  suffix?: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#252925] bg-[#0d0f0d] p-4 transition hover:border-[#3a443a] hover:bg-[#101310]">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#929992]">{label}</span>
        {icon}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight text-[#f4f5f4]">{value}</span>
        {suffix && <span className="text-xs text-[#737b73]">{suffix}</span>}
      </div>
      <div className="mt-2 text-[11px] text-[#737b73]">{detail}</div>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="shrink-0 text-[#929992]">{label}</span>
      <span className="text-right font-medium text-[#e2e6e2]">{value}</span>
    </div>
  );
}
