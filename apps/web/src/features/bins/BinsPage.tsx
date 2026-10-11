import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface Bin {
  id: string;
  code: string;
  type: string;
  fillPercentage: number | string | null;
  capacityLiters: number | string | null;
  status: string;
  latitude: number | null;
  longitude: number | null;
  zone?: {
    name: string;
    code: string;
  } | null;
}

interface BinsResponse {
  success: boolean;
  data: Bin[];
  meta?: {
    total?: number;
  };
}

function getNumericValue(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;

  return Number.isFinite(parsed) ? parsed : fallback;
}

function getStatusClass(status: string): string {
  switch (status.toUpperCase()) {
    case "OVERFLOWING":
      return "badge-critical";
    case "NEEDS_COLLECTION":
      return "badge-warning";
    default:
      return "badge-success";
  }
}

export default function BinsPage() {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<BinsResponse>({
    queryKey: ["bins"],
    queryFn: () => api<BinsResponse>("/bins?limit=100"),
    retry: 1,
  });

  const bins = Array.isArray(data?.data) ? data.data : [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Bin Management
          </h1>

          <p className="mt-0.5 text-sm text-ecosphere-muted">
            {isLoading
              ? "Loading bins..."
              : `${data?.meta?.total ?? bins.length} registered bins`}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-lg border border-ecosphere-border px-4 py-2 text-sm transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {isError && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400"
        >
          <p className="font-medium">Failed to load bins.</p>

          <p className="mt-1">
            {error instanceof Error
              ? error.message
              : "An unexpected error occurred while requesting bins."}
          </p>

          <p className="mt-2 text-red-300/80">
            Check that the API is running, you are signed in, and your account
            has permission to access bins.
          </p>

          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-3 rounded-md border border-red-400/30 px-3 py-1.5 hover:bg-red-500/10"
          >
            Try again
          </button>
        </div>
      )}

      {!isLoading && !isError && bins.length === 0 && (
        <div className="card p-8 text-center">
          <h2 className="font-medium">No bins found</h2>
          <p className="mt-2 text-sm text-ecosphere-muted">
            No bins were returned by the API. Check your dataset or register
            bins if none exist yet.
          </p>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ecosphere-border text-left text-xs text-ecosphere-muted">
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Zone</th>
                <th className="px-4 py-3 font-medium">Fill</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Capacity</th>
              </tr>
            </thead>

            <tbody>
              {isLoading &&
                Array.from({ length: 5 }, (_, index) => (
                  <tr
                    key={`loading-${index}`}
                    className="border-b border-ecosphere-border/40"
                  >
                    <td colSpan={6} className="px-4 py-4 text-ecosphere-muted">
                      {index === 0 ? "Loading bins..." : "\u00A0"}
                    </td>
                  </tr>
                ))}

              {!isLoading &&
                !isError &&
                bins.map((bin) => {
                  const fill = Math.min(
                    100,
                    Math.max(0, getNumericValue(bin.fillPercentage))
                  );

                  const capacity = getNumericValue(bin.capacityLiters);
                  const status =
                    typeof bin.status === "string" ? bin.status : "UNKNOWN";

                  const fillColor =
                    fill >= 81
                      ? "bg-red-500"
                      : fill >= 61
                        ? "bg-amber-500"
                        : "bg-emerald-500";

                  return (
                    <tr
                      key={bin.id}
                      className="border-b border-ecosphere-border/40 transition hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-3 font-medium">
                        {bin.code || "—"}
                      </td>

                      <td className="px-4 py-3 text-slate-400">
                        {bin.type || "—"}
                      </td>

                      <td className="px-4 py-3 text-slate-400">
                        {bin.zone?.name || "—"}
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ecosphere-border">
                            <div
                              className={`h-full rounded-full ${fillColor}`}
                              style={{ width: `${fill}%` }}
                            />
                          </div>

                          <span className="text-xs tabular-nums">
                            {fill.toFixed(0)}%
                          </span>
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <span className={getStatusClass(status)}>
                          {status.replace(/_/g, " ")}
                        </span>
                      </td>

                      <td className="px-4 py-3 text-slate-400">
                        {capacity.toLocaleString()} L
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}