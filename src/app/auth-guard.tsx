"use client";

import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute>{children}</ProtectedRoute>;
}
