import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { backendApi } from "@/core/backendApi";

interface AuthUser {
  email: string;
  role: string;
}

interface GMCBAuthContextType {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => void;
}

const GMCBAuthContext = createContext<GMCBAuthContextType>({
  user: null,
  loading: true,
  signOut: () => {},
});

export const useGMCBAuth = () => useContext(GMCBAuthContext);

export const GMCBAuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Check if user is an admin via sessionStorage (admin portal bypass)
    const userType = sessionStorage.getItem("userType");
    if (userType === "admin") {
      setUser({ email: "admin@octomiro.ai", role: "admin" });
      setLoading(false);
      return;
    }

    // Verify JWT token stored in localStorage
    const token = localStorage.getItem("auth_token");
    if (!token) {
      setLoading(false);
      if (location.pathname.startsWith("/clients/gmcb")) {
        navigate("/app/gmcb");
      }
      return;
    }

    backendApi.authMe().then((result) => {
      if (result) {
        setUser(result);
      } else {
        localStorage.removeItem("auth_token");
        if (location.pathname.startsWith("/clients/gmcb")) {
          navigate("/app/gmcb");
        }
      }
      setLoading(false);
    });
  }, []);

  const signOut = () => {
    const userType = sessionStorage.getItem("userType");
    if (userType === "admin") {
      navigate("/clients");
      return;
    }
    localStorage.removeItem("auth_token");
    setUser(null);
    navigate("/app/gmcb");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <GMCBAuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </GMCBAuthContext.Provider>
  );
};
