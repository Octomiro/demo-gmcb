/**
 * =============================================================================
 * ClientLayout — Layout générique pour tous les espaces clients
 * =============================================================================
 *
 * Composant unique qui remplace les 8+ layouts identiques (GMCBLayout,
 * PhytealLayout, etc.) qui étaient dupliqués dans le projet.
 *
 * Utilisation :
 *   <Route element={<ClientLayout sidebar={<PhytealSidebar />} />}>
 *     <Route path="/clients/phyteal" element={<PhytealOverview />} />
 *   </Route>
 *
 * Structure rendue :
 *   ┌──────────┬──────────────────────────────┐
 *   │          │  ClientTopBar (sticky)        │
 *   │ Sidebar  ├──────────────────────────────┤
 *   │ (injecté)│  <Outlet /> (page courante)  │
 *   │          │                              │
 *   └──────────┴──────────────────────────────┘
 *
 * @param sidebar — Le composant Sidebar spécifique au client
 * =============================================================================
 */

import { Outlet } from "react-router-dom";
import { ReactNode } from "react";
import { SidebarProvider as ShadcnSidebarProvider } from "@/components/ui/sidebar";
import { ClientTopBar } from "./ClientTopBar";

interface ClientLayoutProps {
  /** Sidebar spécifique au client (ex: <GMCBSidebar />, <PhytealSidebar />) */
  sidebar: ReactNode;
}

export const ClientLayout = ({ sidebar }: ClientLayoutProps) => (
  <ShadcnSidebarProvider>
    <div className="flex min-h-screen bg-background w-full">
      {sidebar}
      <main className="flex-1 overflow-auto">
        <ClientTopBar />
        <Outlet />
      </main>
    </div>
  </ShadcnSidebarProvider>
);
