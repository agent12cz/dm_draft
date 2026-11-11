export const productSports = ["NHL", "NBA", "NFL", "MLB"] as const;

export type ProductSport = (typeof productSports)[number];

export function isProductSport(sport: unknown): sport is ProductSport {
  return typeof sport === "string" && productSports.some((supportedSport) => supportedSport === sport);
}

export function getProductSport(sport: unknown): ProductSport | null {
  if (sport === undefined || sport === null) return "NHL";
  return isProductSport(sport) ? sport : null;
}

export function filterProductsBySport<T extends { sport?: unknown }>(
  products: T[],
  sport: ProductSport,
): T[] {
  return products.filter((product) => getProductSport(product.sport) === sport);
}
