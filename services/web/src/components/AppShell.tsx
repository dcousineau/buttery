import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
import { TooltipProvider } from "#/components/ui/tooltip";
import AppSidebar from "./AppSidebar";
import Footer from "./Footer";
import Header from "./Header";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <a
          href="#main-content"
          className="sr-only rounded-lg border-2 border-border bg-card px-4 py-2 font-semibold text-foreground shadow-pop focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-50"
        >
          Skip to main content
        </a>
        <AppSidebar />
        <SidebarInset>
          <Header />
          <main id="main-content" tabIndex={-1} className="flex-1 focus-visible:outline-none">
            {children}
          </main>
          <Footer />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
