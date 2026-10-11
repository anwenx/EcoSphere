import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Map,
  Trash2,
  Truck,
  Route,
  BarChart3,
  Bell,
  Settings,
  LogOut,
  Leaf,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { ReactNode } from "react";

const nav = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/map", icon: Map, label: "Live Map" },
  { to: "/bins", icon: Trash2, label: "Bins" },
  { to: "/fleet", icon: Truck, label: "Fleet" },
  { to: "/routes", icon: Route, label: "Routes" },
  { to: "/analytics", icon: BarChart3, label: "Analytics" },
  { to: "/alerts", icon: Bell, label: "Alerts" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex h-screen overflow-hidden bg-ecosphere-bg">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 border-r border-ecosphere-border bg-ecosphere-card flex flex-col">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-ecosphere-border">
          <div className="w-8 h-8 rounded-lg bg-ecosphere-accent/20 flex items-center justify-center">
            <Leaf className="w-4 h-4 text-ecosphere-accent" />
          </div>
          <div>
            <div className="font-semibold text-sm tracking-tight">EcoSphere</div>
            <div className="text-[10px] text-ecosphere-muted">Smart Waste Ops</div>
          </div>
        </div>

        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-ecosphere-accent/15 text-ecosphere-accent font-medium"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`
              }
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-ecosphere-border">
          <div className="flex items-center gap-2 px-2 mb-2">
            <div className="w-7 h-7 rounded-full bg-ecosphere-accent/30 flex items-center justify-center text-xs font-semibold">
              {user?.name?.charAt(0) || "U"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{user?.name}</div>
              <div className="text-[10px] text-ecosphere-muted truncate">{user?.role?.replace("_", " ")}</div>
            </div>
          </div>
          <button
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
