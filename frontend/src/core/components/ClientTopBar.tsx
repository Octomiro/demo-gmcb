/**
 * =============================================================================
 * ClientTopBar — Barre supérieure commune à tous les espaces clients
 * =============================================================================
 *
 * Affiche le bouton toggle sidebar, le sélecteur de langue et le menu utilisateur.
 * Sticky en haut de page avec effet backdrop-blur.
 * =============================================================================
 */

import { LanguageSelector } from "@/components/LanguageSelector";
import { UserMenu } from "@/components/UserMenu";
import { SidebarTrigger } from "@/components/ui/sidebar";

export const ClientTopBar = () => (
  <div className="sticky top-0 z-40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 border-b border-border/50">
    <div className="flex justify-between items-center px-6 py-3">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground transition-colors" />
      <div className="flex items-center gap-4">
        <LanguageSelector />
        <UserMenu />
      </div>
    </div>
  </div>
);
