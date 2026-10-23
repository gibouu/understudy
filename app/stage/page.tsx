"use client";

import dynamic from "next/dynamic";

const StageView = dynamic(() => import("./stage-view").then((m) => m.StageView), {
  ssr: false,
  loading: () => <div className="aspect-[4/3] w-full animate-pulse rounded-xl border bg-neutral-100" />,
});

export default function StagePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Rehearsal stage</h1>
        <p className="text-sm text-neutral-600">
          Day-one spike: the SO-101 loads from MuJoCo Menagerie into MuJoCo WebAssembly, steps in a
          worker, and renders here. Via-points, perturbations and the program interpreter come next.
        </p>
      </header>
      <StageView />
    </main>
  );
}
