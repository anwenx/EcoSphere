
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { api, setCsrfToken } from "./api";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuthResponse {
  success: boolean;
  data: {
    user: User;
    csrfToken: string | null;
  };
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Restore the existing cookie-based session when the app starts.
   * The backend validates the eco_session cookie.
   */
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const response = await api<AuthResponse>("/auth/me");

        if (cancelled) return;

        setUser(response.data.user);
        setCsrfToken(response.data.csrfToken);
      } catch {
        if (cancelled) return;

        setUser(null);
        setCsrfToken(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Log in using the backend's cookie-based authentication.
   * The backend sets eco_session and returns the CSRF token.
   */
  const login = async (
    email: string,
    password: string
  ): Promise<void> => {
    const response = await api<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
      }),
    });

    setCsrfToken(response.data.csrfToken);
    setUser(response.data.user);
  };

  /**
   * End the server-side browser session and clear local auth state.
   */
  const logout = async (): Promise<void> => {
    try {
      await api("/auth/logout", {
        method: "POST",
      });
    } finally {
      setUser(null);
      setCsrfToken(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        logout,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return context;
}
