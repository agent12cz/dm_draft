import Link from "next/link";
import { ReactNode } from "react";

type PrimaryButtonProps = {
  children: ReactNode;
  href?: string;
  className?: string;
};

export function PrimaryButton({ children, href, className = "" }: PrimaryButtonProps) {
  const baseClasses =
    "inline-flex items-center justify-center rounded-2xl bg-[#18C964] px-5 py-3 text-sm font-semibold text-slate-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#13b15a] hover:shadow-lg hover:shadow-[#18C964]/25";

  if (href) {
    return (
      <Link href={href} className={`${baseClasses} ${className}`}>
        {children}
      </Link>
    );
  }

  return <button className={`${baseClasses} ${className}`}>{children}</button>;
}
