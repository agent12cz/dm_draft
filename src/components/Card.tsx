import { ReactNode } from "react";

type CardProps = {
  children: ReactNode;
  className?: string;
};

export function Card({ children, className = "" }: CardProps) {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/70 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_20px_80px_rgba(2,6,23,0.5)] backdrop-blur-xl ${className}`}>
      {children}
    </div>
  );
}
