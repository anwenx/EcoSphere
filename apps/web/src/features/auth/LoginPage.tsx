import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Leaf } from "lucide-react";
import { useAuth } from "../../lib/auth";

export default function LoginPage() {
  const [email, setEmail] = useState("ops@ecosphere.demo");
  const [password, setPassword] = useState("Demo@123");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ecosphere-bg p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-ecosphere-accent/20 mb-4">
            <Leaf className="w-7 h-7 text-ecosphere-accent" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">EcoSphere</h1>
          <p className="text-sm text-ecosphere-muted mt-1">
            Intelligent Waste Collection & Route Optimization
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-ecosphere-bg border border-ecosphere-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ecosphere-accent/50"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-ecosphere-bg border border-ecosphere-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ecosphere-accent/50"
              required
            />
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 disabled:opacity-50">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-ecosphere-muted space-y-1">
          <p>Demo accounts (password: <code className="text-slate-300">Demo@123</code>)</p>
          <p>ops@ecosphere.demo · admin@ecosphere.demo · driver1@ecosphere.demo</p>
        </div>
      </div>
    </div>
  );
}
