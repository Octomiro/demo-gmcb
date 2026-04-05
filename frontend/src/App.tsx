import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "./contexts/LanguageContext";
import { GMCBAuthProvider } from "./contexts/GMCBAuthContext";
import { GMCBFeedbackProvider } from "./contexts/GMCBFeedbackContext";
import { ClientLayout } from "./core/components/ClientLayout";

// ── GMCB Sidebar ──────────────────────────────────────────────────────────────
import { GMCBSidebar } from "./components/GMCBSidebar";

// ── Pages — GMCB ─────────────────────────────────────────────────────────────
import GMCBLogin from "./pages/gmcb/GMCBLogin";
import GMCBOverview from "./pages/gmcb/GMCBOverview.tsx";
import GMCBQualite from "./pages/gmcb/GMCBQualite";
import GMCBHistorique from "./pages/gmcb/GMCBHistorique";
import GMCBAdmin from "./pages/gmcb/GMCBAdmin";
import GMCBSettings from "./pages/gmcb/GMCBSettings";
import GMCBSuperAdmin from "./pages/gmcb/GMCBSuperAdmin";
import GMCBMyFeedbacks from "./pages/gmcb/GMCBMyFeedbacks";

// ── 404 ───────────────────────────────────────────────────────────────────────
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <LanguageProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            {/* ─── GMCB Login ────────────────────────────────────── */}
            <Route path="/" element={<GMCBLogin />} />
            <Route path="/app/gmcb" element={<GMCBLogin />} />

            {/* ─── GMCB (auth guard + client layout) ─────────────── */}
            <Route element={<GMCBAuthProvider><GMCBFeedbackProvider><ClientLayout sidebar={<GMCBSidebar />} /></GMCBFeedbackProvider></GMCBAuthProvider>}>
              <Route path="/clients/gmcb" element={<GMCBOverview />} />
              <Route path="/clients/gmcb/qualite" element={<GMCBQualite />} />
              <Route path="/clients/gmcb/historique" element={<GMCBHistorique />} />
              <Route path="/clients/gmcb/admin" element={<GMCBAdmin />} />
              <Route path="/clients/gmcb/settings" element={<GMCBSettings />} />
              <Route path="/clients/gmcb/admin_superadmin" element={<GMCBSuperAdmin />} />
              <Route path="/clients/gmcb/feedbacks" element={<GMCBMyFeedbacks />} />
            </Route>

            {/* ─── 404 ───────────────────────────────────────────── */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </LanguageProvider>
  </QueryClientProvider>
);

export default App;
