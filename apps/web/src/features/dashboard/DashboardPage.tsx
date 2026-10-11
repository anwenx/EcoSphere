import { useQuery } from "@tanstack/react-query";
import {
  Trash2,
  AlertTriangle,
  Truck,
  Route,
  Bell,
  Leaf,
} from "lucide-react";
import { api } from "../../lib/api";

interface DashboardSummary {
  period?: { from: string; to: string };
  bins: {
    total: number;
    needsCollection: number;
    overflowing: number;
    critical: number;
    outOfService: number;
  };
  vehicles: {
    available: number;
    onRoute: number;
    maintenance: number;
    unavailable: number;
  };
  routesInProgress: number;
  openAlertsBySeverity: {
    CRITICAL: number;
    WARNING: number;
  };
  dataOrigin?: Record<string, number>;
}

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () =>
      api<{ success: boolean; data: DashboardSummary }>(
        "/dashboard/summary"
      ),
  });

  const summary = data?.data;
  const totalAlerts = summary
    ? summary.openAlertsBySeverity.CRITICAL +
      summary.openAlertsBySeverity.WARNING
    : 0;

  const isDemo = Boolean(
    summary?.dataOrigin &&
      Object.keys(summary.dataOrigin).some((key) => key === "DEMO")
  );

  const cards = [
    {
      label: "Bins Monitored",
      value: summary?.bins.total,
      icon: Trash2,
      color: "text-emerald-400",
    },
    {
      label: "Critical Bins",
      value: summary?.bins.critical,
      icon: AlertTriangle,
      color: "text-red-400",
    },
    {
      label: "Needs Collection",
      value: summary?.bins.needsCollection,
      icon: Trash2,
      color: "text-amber-400",
    },
    {
      label: "Available Vehicles",
      value: summary?.vehicles.available,
      icon: Truck,
      color: "text-blue-400",
    },
    {
      label: "Routes In Progress",
      value: summary?.routesInProgress,
      icon: Route,
      color: "text-cyan-400",
    },
    {
      label: "Open Alerts",
      value: totalAlerts,
      icon: Bell,
      color: "text-orange-400",
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Operations Dashboard
          </h1>
          <p className="text-sm text-ecosphere-muted mt-1">
            Waste collection operations overview
          </p>
          {summary?.period && (
            <p className="text-xs text-ecosphere-muted mt-1">
              Period: {summary.period.from} – {summary.period.to}
            </p>
          )}
        </div>

        {isDemo && <span className="badge-info">Demo Data</span>}
      </header>

      {error && (
        <div className="card p-4 text-sm text-red-400">
          Failed to load dashboard data. Check that the API is running and
          your session is valid.
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-ecosphere-muted">
          Loading dashboard data…
        </p>
      )}

      {summary && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {cards.map((card) => (
              <div key={card.label} className="card p-4">
                <div className="flex items-center justify-between mb-3">
                  <card.icon className={`w-4 h-4 ${card.color}`} />
                </div>
                <div className="text-2xl font-semibold tracking-tight">
                  {card.value ?? "—"}
                </div>
                <div className="text-xs text-ecosphere-muted mt-1">
                  {card.label}
                </div>
              </div>
            ))}
          </section>

          <section className="grid lg:grid-cols-2 gap-4">
            <div className="card p-5">
              <h2 className="text-sm font-medium mb-4 flex items-center gap-2">
                <Leaf className="w-4 h-4 text-ecosphere-accent" />
                Operations Status
              </h2>
              <ul className="space-y-3 text-sm text-slate-400">
                <li className="flex justify-between gap-4">
                  <span>Vehicles on route</span>
                  <strong className="text-slate-200">
                    {summary.vehicles.onRoute}
                  </strong>
                </li>
                <li className="flex justify-between gap-4">
                  <span>Vehicles in maintenance</span>
                  <strong className="text-slate-200">
                    {summary.vehicles.maintenance}
                  </strong>
                </li>
                <li className="flex justify-between gap-4">
                  <span>Bins out of service</span>
                  <strong className="text-slate-200">
                    {summary.bins.outOfService}
                  </strong>
                </li>
                <li className="flex justify-between gap-4">
                  <span>Critical alerts</span>
                  <strong className="text-red-400">
                    {summary.openAlertsBySeverity.CRITICAL}
                  </strong>
                </li>
              </ul>
            </div>

            <div className="card p-5">
              <h2 className="text-sm font-medium mb-3">Next Steps</h2>
              <ul className="space-y-2 text-sm text-slate-400">
                <li>Open Live Map to inspect bin locations.</li>
                <li>Open Bins to review fill levels and collection status.</li>
                <li>
                  Treat demo records as sample data, not live sensor readings.
                </li>
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}