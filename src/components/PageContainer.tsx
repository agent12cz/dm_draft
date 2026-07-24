import { ReactNode } from "react";

type PageContainerProps = {
  children: ReactNode;
  className?: string;
};

export function PageContainer({ children, className = "" }: PageContainerProps) {
  return (
    <main className={`mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 lg:px-8 ${className}`}>
      {children}
    </main>
  );
}
