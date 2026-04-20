import { Link, useLocation, useNavigate } from "react-router-dom";
import { useSidebar } from "@/components/ui/sidebar";
import { useEffect, useRef, useState } from "react";
import { backendApi } from "@/core/backendApi";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  ScanSearch,
  History,
  Settings,
  ShieldCheck,
  MessageSquare,
  LogOut,
  ArrowLeft,
  Inbox,
} from "lucide-react";
import logoOctomiro from "@/assets/logo-octomiro.webp";
import logoOctoNorm from "@/assets/logo-octonorm.webp";
import logoKhomsa from "@/assets/logo-khomsa-nobg.webp";
import { useGMCBAuth } from "@/contexts/GMCBAuthContext";
import { useGMCBFeedback } from "@/contexts/GMCBFeedbackContext";

const mainItems = [
  { title: "Vue d'ensemble", url: "/clients/gmcb", icon: LayoutDashboard },
];

const octoNormItems = [
  { title: "Live Session", url: "/clients/gmcb/qualite", icon: ScanSearch },
];

const additionalItems = [
  { title: "Historique", url: "/clients/gmcb/historique", icon: History },
  { title: "Admin Dashboard", url: "/clients/gmcb/admin", icon: ShieldCheck },
  { title: "Paramètres", url: "/clients/gmcb/settings", icon: Settings },
];

export function GMCBSidebar() {
  const { open } = useSidebar();
  const location = useLocation();
  const currentPath = location.pathname;
  const { signOut, user } = useGMCBAuth();
  const { openFeedbackModal } = useGMCBFeedback();
  const navigate = useNavigate();

  // ── Session-ended detection (always mounted, fires regardless of active page) ──
  const wasRecordingRef = useRef(false);
  const [isLive, setIsLive] = useState(false);
  useEffect(() => {
    const check = async () => {
      try {
        const s = await backendApi.sessionStatus();
        setIsLive(!!s.any_recording);

        // Shift preemption: show toast when scheduler interrupts a manual session
        if (s.preemption) {
          toast.warning(
            `Le shift « ${s.preemption.shift_label} » est programmé maintenant`,
            {
              description: "La session manuelle en cours a été interrompue et le shift planifié a pris le relais.",
              duration: 8000,
            }
          );
        }

        if (s.any_recording) {
          wasRecordingRef.current = true;
        } else if (wasRecordingRef.current) {
          wasRecordingRef.current = false;
          toast.info("Session terminée.", {
            description: "Redirection vers l'historique…",
            duration: 5000,
          });
          setTimeout(() => navigate("/clients/gmcb/historique", { state: { openLatestSession: true } }), 2500);
        }
      } catch { /* backend unreachable, ignore */ }
    };
    check();
    const id = setInterval(check, 3000);
    return () => clearInterval(id);
  }, [navigate]);

  // ── Feedback notification badge ──
  const [feedbackBadge, setFeedbackBadge] = useState(0);

  useEffect(() => {
    if (!user) return;

    async function pollNotifs() {
      try {
        if (user!.role === "super_admin") {
          // Badge = count of feedbacks without a response (pending)
          const res = await backendApi.listFeedbacks();
          const pending = (res.feedbacks ?? []).filter((f: any) => !f.admin_response).length;
          setFeedbackBadge(pending);
        } else {
          // Badge = count of responded feedbacks whose ID is NOT in the seen-IDs set
          const seenKey = `gmcb_seen_fb_ids_${user!.email}`;
          const seenIds: number[] = JSON.parse(localStorage.getItem(seenKey) ?? "[]");
          const res = await backendApi.listMyFeedbacks();
          const unread = (res.feedbacks ?? []).filter(
            (f: any) => f.admin_response && !seenIds.includes(f.id)
          ).length;
          setFeedbackBadge(unread);
        }
      } catch { /* silent */ }
    }

    pollNotifs();
    const id = setInterval(pollNotifs, 60_000);
    return () => clearInterval(id);
  }, [user]);

  // Instantly clear badge when user navigates to the feedbacks page
  useEffect(() => {
    if (!user) return;
    if (user.role !== "super_admin" && currentPath === "/clients/gmcb/feedbacks") {
      setFeedbackBadge(0);
    }
  }, [user, currentPath]);

  const renderItems = (items: typeof mainItems) =>
    items.map((item) => (
      <SidebarMenuItem key={item.title}>
        <SidebarMenuButton asChild>
          <Link
            to={item.url}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
              currentPath === item.url
                ? "bg-primary text-primary-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <item.icon className="w-4 h-4" />
            {open && <span className="text-sm flex-1">{item.title}</span>}
            {open && item.url === "/clients/gmcb/qualite" && isLive && (
              <span className="flex items-center gap-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
                <span className="text-[10px] font-bold text-red-500 tracking-wide">LIVE</span>
              </span>
            )}
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ));

  return (
    <Sidebar className={`border-r border-border/50 bg-card ${open ? 'w-64' : 'w-16'} transition-all duration-200`}>
      <SidebarHeader className="p-4 border-b border-border/50">
        <Link
          to="/"
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          onClick={(e) => {
            // If user is inside the client app, scroll to top instead of navigating to the login/connect page
            if (currentPath.startsWith("/clients")) {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }
          }}
        >
          <img src={logoOctomiro} alt="Octomiro" className="h-8 w-auto" />
          {open && (
            <span className="font-display font-semibold text-base text-foreground tracking-tight">Octomiro</span>
          )}
        </Link>
      </SidebarHeader>


      {open && (
        <div className="px-4 py-3 border-b border-border/50">
          <div className="flex items-center gap-3">
            <div className="w-20 h-10 flex items-center justify-center">
              <img src={logoKhomsa} alt="Khomsa" className="w-full h-full object-contain" />
            </div>
            <div className="flex flex-col">
              <span className="font-medium text-sm text-foreground">GMCB</span>
              <span className="text-xs text-muted-foreground">Agroalimentaire</span>
            </div>
          </div>
        </div>
      )}

      <SidebarContent className="px-2 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
            {open ? "Principal" : ""}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(mainItems)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-4">
          <SidebarGroupLabel className="px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
            {open && (
              <>
                <img src={logoOctoNorm} alt="OctoNorm" className="w-3.5 h-3.5" />
                <span>OctoNorm</span>
              </>
            )}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(octoNormItems)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-4">
          <SidebarGroupLabel className="px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
            {open ? "Fonctionnalités" : ""}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(additionalItems)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2 border-t border-border/50">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <button
                onClick={() => {
                  if (user?.role === "super_admin") {
                    navigate("/clients/gmcb/admin_superadmin");
                  } else {
                    openFeedbackModal({ scope: "global" });
                  }
                }}
                className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors w-full ${
                  currentPath === "/clients/gmcb/admin_superadmin"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <span className="relative flex-shrink-0">
                  <MessageSquare className="w-4 h-4" />
                  {user?.role === "super_admin" && feedbackBadge > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
                      {feedbackBadge > 99 ? "99+" : feedbackBadge}
                    </span>
                  )}
                </span>
                {open && <span className="text-sm">Feedback</span>}
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {user?.role !== "super_admin" && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link
                  to="/clients/gmcb/feedbacks"
                  className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                    currentPath === "/clients/gmcb/feedbacks"
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <span className="relative flex-shrink-0">
                    <Inbox className="w-4 h-4" />
                    {feedbackBadge > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
                        {feedbackBadge > 99 ? "99+" : feedbackBadge}
                      </span>
                    )}
                  </span>
                  {open && <span className="text-sm">Mes feedbacks</span>}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <button
                onClick={signOut}
                className="flex items-center gap-3 px-3 py-2 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors w-full"
              >
                <LogOut className="w-4 h-4" />
                {open && <span className="text-sm">Se déconnecter</span>}
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
