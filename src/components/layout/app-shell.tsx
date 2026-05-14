"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useCommandMenu } from "@/hooks/use-command-menu";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppHeader } from "@/components/layout/app-header";
import { CommandMenu } from "@/components/layout/command-menu";

export function AppShell({ children }: { children: React.ReactNode }) {
  const isMd = useMediaQuery("(min-width: 768px)");
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const command = useCommandMenu();

  React.useEffect(() => {
    if (isMd) setMobileOpen(false);
  }, [isMd]);

  return (
    <div className="flex min-h-screen bg-background">
      <div className="hidden md:block">
        <AppSidebar onCommandOpen={() => command.setOpen(true)} />
      </div>

      {mobileOpen ? (
        <>
          <button type="button" className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm md:hidden" aria-label="Close menu" onClick={() => setMobileOpen(false)} />
          <div className={cn("fixed inset-y-0 left-0 z-50 w-[min(100%,280px)] border-r border-border bg-sidebar shadow-2xl md:hidden")}>
            <AppSidebar onNavigate={() => setMobileOpen(false)} onCommandOpen={() => command.setOpen(true)} />
          </div>
        </>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader onMenuClick={() => setMobileOpen(true)} onCommandClick={() => command.setOpen(true)} />
        <CommandMenu open={command.open} onOpenChange={command.setOpen} />
        <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain bg-mesh-gradient bg-grid-fade bg-[length:100%_100%,64px_64px] p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
