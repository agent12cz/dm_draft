export type DraftItem = {
  id: string;
  name: string;
  sport: string;
  logo: string;
};

export const defaultDraftItems: DraftItem[] = [
  { id: "anaheim-ducks", name: "Anaheim Ducks", sport: "NHL", logo: "/logos/nhl/anaheim-ducks.png" },
  { id: "boston-bruins", name: "Boston Bruins", sport: "NHL", logo: "/logos/nhl/boston-bruins.png" },
  { id: "buffalo-sabres", name: "Buffalo Sabres", sport: "NHL", logo: "/logos/nhl/buffalo-sabres.png" },
  { id: "calgary-flames", name: "Calgary Flames", sport: "NHL", logo: "/logos/nhl/calgary-flames.png" },
  { id: "carolina-hurricanes", name: "Carolina Hurricanes", sport: "NHL", logo: "/logos/nhl/carolina-hurricanes.png" },
  { id: "chicago-blackhawks", name: "Chicago Blackhawks", sport: "NHL", logo: "/logos/nhl/chicago-blackhawks.png" },
  { id: "colorado-avalanche", name: "Colorado Avalanche", sport: "NHL", logo: "/logos/nhl/colorado-avalanche.png" },
  { id: "columbus-blue-jackets", name: "Columbus Blue Jackets", sport: "NHL", logo: "/logos/nhl/columbus-blue-jackets.png" },
  { id: "dallas-stars", name: "Dallas Stars", sport: "NHL", logo: "/logos/nhl/dallas-stars.png" },
  { id: "detroit-red-wings", name: "Detroit Red Wings", sport: "NHL", logo: "/logos/nhl/detroit-red-wings.png" },
  { id: "edmonton-oilers", name: "Edmonton Oilers", sport: "NHL", logo: "/logos/nhl/edmonton-oilers.png" },
  { id: "florida-panthers", name: "Florida Panthers", sport: "NHL", logo: "/logos/nhl/florida-panthers.png" },
  { id: "los-angeles-kings", name: "Los Angeles Kings", sport: "NHL", logo: "/logos/nhl/los-angeles-kings.png" },
  { id: "minnesota-wild", name: "Minnesota Wild", sport: "NHL", logo: "/logos/nhl/minnesota-wild.png" },
  { id: "montreal-canadiens", name: "Montreal Canadiens", sport: "NHL", logo: "/logos/nhl/montreal-canadiens.png" },
  { id: "nashville-predators", name: "Nashville Predators", sport: "NHL", logo: "/logos/nhl/nashville-predators.png" },
  { id: "new-jersey-devils", name: "New Jersey Devils", sport: "NHL", logo: "/logos/nhl/new-jersey-devils.png" },
  { id: "new-york-islanders", name: "New York Islanders", sport: "NHL", logo: "/logos/nhl/new-york-islanders.png" },
  { id: "new-york-rangers", name: "New York Rangers", sport: "NHL", logo: "/logos/nhl/new-york-rangers.png" },
  { id: "ottawa-senators", name: "Ottawa Senators", sport: "NHL", logo: "/logos/nhl/ottawa-senators.png" },
  { id: "philadelphia-flyers", name: "Philadelphia Flyers", sport: "NHL", logo: "/logos/nhl/philadelphia-flyers.png" },
  { id: "pittsburgh-penguins", name: "Pittsburgh Penguins", sport: "NHL", logo: "/logos/nhl/pittsburgh-penguins.png" },
  { id: "san-jose-sharks", name: "San Jose Sharks", sport: "NHL", logo: "/logos/nhl/san-jose-sharks.png" },
  { id: "seattle-kraken", name: "Seattle Kraken", sport: "NHL", logo: "/logos/nhl/seattle-kraken.png" },
  { id: "st-louis-blues", name: "St. Louis Blues", sport: "NHL", logo: "/logos/nhl/st-louis-blues.png" },
  { id: "tampa-bay-lightning", name: "Tampa Bay Lightning", sport: "NHL", logo: "/logos/nhl/tampa-bay-lightning.png" },
  { id: "toronto-maple-leafs", name: "Toronto Maple Leafs", sport: "NHL", logo: "/logos/nhl/toronto-maple-leafs.png" },
  { id: "utah-mammoth", name: "Utah Mammoth", sport: "NHL", logo: "/logos/nhl/utah-mammoth.png" },
  { id: "vancouver-canucks", name: "Vancouver Canucks", sport: "NHL", logo: "/logos/nhl/vancouver-canucks.png" },
  { id: "vegas-golden-knights", name: "Vegas Golden Knights", sport: "NHL", logo: "/logos/nhl/vegas-golden-knights.png" },
  { id: "washington-capitals", name: "Washington Capitals", sport: "NHL", logo: "/logos/nhl/washington-capitals.png" },
  { id: "winnipeg-jets", name: "Winnipeg Jets", sport: "NHL", logo: "/logos/nhl/winnipeg-jets.png" },
];

export function normalizeDraftItem(item: DraftItem | string | null | undefined): DraftItem {
  if (typeof item === "string") {
    const name = item.trim();
    const team = defaultDraftItems.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());

    return {
      id: team?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      name,
      sport: "NHL",
      logo: team?.logo ?? "",
    };
  }

  if (item && typeof item === "object") {
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const logo = typeof item.logo === "string" ? item.logo.trim() : "";
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const team = defaultDraftItems.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());

    return {
      id,
      name,
      sport: typeof item.sport === "string" ? item.sport : "NHL",
      logo: logo || team?.logo || "",
    };
  }

  return {
    id: "",
    name: "",
    sport: "NHL",
    logo: "",
  };
}

export function buildSnakeOrder(participantCount: number, itemCount: number) {
  if (participantCount <= 0) {
    return [] as number[];
  }

  const order: number[] = [];

  for (let index = 0; index < itemCount; index += 1) {
    const round = Math.floor(index / participantCount);
    const positionInRound = index % participantCount;
    const participantIndex = round % 2 === 0 ? positionInRound : participantCount - 1 - positionInRound;
    order.push(participantIndex);
  }

  return order;
}

export function calculateTargetBreakPrice(boxesCount: number, boxPrice: number, margin: number) {
  return boxesCount * boxPrice + margin;
}
