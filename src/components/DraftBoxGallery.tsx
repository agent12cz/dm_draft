import type { BoxSelection } from "@/lib/rankings";

type DraftBoxGalleryProps = {
  draft: {
    title: string;
    boxes?: BoxSelection[];
    productName?: string;
    productSeason?: string;
    productImageUrl?: string;
    boxCount?: number;
  };
};

export function DraftBoxGallery({ draft }: DraftBoxGalleryProps) {
  const composition = draft.boxes?.length
    ? draft.boxes
    : [{
        productName: draft.productName || draft.title,
        productSeason: draft.productSeason || "",
        productImageUrl: draft.productImageUrl,
        boxCount: draft.boxCount && draft.boxCount > 0 ? draft.boxCount : 1,
      }];
  const boxes = composition.flatMap((box, selectionIndex) =>
    Array.from({ length: box.boxCount }, (_, copyIndex) => ({
      ...box,
      key: `${selectionIndex}-${copyIndex}`,
    })),
  );

  if (boxes.length === 0) {
    return null;
  }

  const gridClass = boxes.length === 1
    ? "grid-cols-1"
    : boxes.length === 2
      ? "grid-cols-2"
      : "grid-cols-[repeat(auto-fit,minmax(min(100%,100px),1fr))]";
  const sizeClass = boxes.length === 1
    ? "h-60 sm:h-72 p-3"
    : boxes.length === 2
      ? "h-40 sm:h-44 p-2"
      : "h-28 p-2";

  return (
    <div
      role="group"
      aria-label={`Boxy v draftu: ${boxes.length}`}
      className={`grid min-w-0 gap-2 ${gridClass}`}
    >
      {boxes.map((box) => (
        <div
          key={box.key}
          title={`${box.productName} ${box.productSeason}`.trim()}
          className={`flex min-w-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 ${sizeClass}`}
        >
          {box.productImageUrl ? (
            <img
              src={box.productImageUrl}
              alt={`${box.productName} ${box.productSeason}`.trim()}
              loading="lazy"
              className="h-full w-full object-contain"
            />
          ) : (
            <p className="break-words text-center text-xs text-slate-400">
              {box.productName || draft.title}
              <span className="mt-1 block text-slate-500">Fotografie není k dispozici</span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
