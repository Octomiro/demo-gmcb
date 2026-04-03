import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2, ScanSearch } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { backendApi } from "@/core/backendApi";
import logoOctomiro from "@/assets/logo-octomiro.webp";

const GMCBLogin = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const result = await backendApi.login(email, password);
      localStorage.setItem("auth_token", result.token);

      toast({ title: "Bienvenue", description: "Connexion à l'espace GMCB réussie" });
      navigate("/clients/gmcb");
    } catch {
      toast({ title: "Erreur de connexion", description: "Email ou mot de passe incorrect", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-teal-950 flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 opacity-5" style={{ backgroundImage: "radial-gradient(circle at 30% 40%, rgba(20,184,166,0.15) 1px, transparent 1px)", backgroundSize: "50px 50px" }} />

      <div className="w-full max-w-sm mx-4 relative z-10">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-2xl bg-teal-500/10 border border-teal-500/20">
              <img src={logoOctomiro} alt="Octomiro" className="h-12 w-auto" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-white mt-4">Espace Client GMCB</h1>
          <p className="text-sm text-slate-400 mt-1">Contrôle Qualité Emballages</p>
        </div>

        <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-6">
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-slate-300 text-sm">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="votre@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                className="bg-slate-800/60 border-slate-600/50 text-white placeholder:text-slate-500 focus:border-teal-500"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-300 text-sm">Mot de passe</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  className="bg-slate-800/60 border-slate-600/50 text-white placeholder:text-slate-500 focus:border-teal-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-teal-400"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" disabled={loading} className="w-full py-5 text-base bg-teal-600 hover:bg-teal-700 text-white">
              {loading ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <ScanSearch className="h-5 w-5 mr-2" />}
              {loading ? "Connexion..." : "Se connecter"}
            </Button>
          </form>
        </div>

        <div className="mt-6 text-center">
          <p className="text-xs text-slate-500">GMCB · Propulsé par Octomiro</p>
        </div>
      </div>
    </div>
  );
};

export default GMCBLogin;
