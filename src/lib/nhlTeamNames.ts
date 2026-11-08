import { defaultDraftItems, type DraftItem } from "@/lib/snakeDraft";

const nhlNames: Record<string, readonly [string, string]> = {
  "anaheim-ducks": ["Anaheim", "Ducks"],
  "boston-bruins": ["Boston", "Bruins"],
  "buffalo-sabres": ["Buffalo", "Sabres"],
  "calgary-flames": ["Calgary", "Flames"],
  "carolina-hurricanes": ["Carolina", "Hurricanes"],
  "chicago-blackhawks": ["Chicago", "Blackhawks"],
  "colorado-avalanche": ["Colorado", "Avalanche"],
  "columbus-blue-jackets": ["Columbus", "Blue Jackets"],
  "dallas-stars": ["Dallas", "Stars"],
  "detroit-red-wings": ["Detroit", "Red Wings"],
  "edmonton-oilers": ["Edmonton", "Oilers"],
  "florida-panthers": ["Florida", "Panthers"],
  "los-angeles-kings": ["Los Angeles", "Kings"],
  "minnesota-wild": ["Minnesota", "Wild"],
  "montreal-canadiens": ["Montreal", "Canadiens"],
  "nashville-predators": ["Nashville", "Predators"],
  "new-jersey-devils": ["New Jersey", "Devils"],
  "new-york-islanders": ["New York", "Islanders"],
  "new-york-rangers": ["New York", "Rangers"],
  "ottawa-senators": ["Ottawa", "Senators"],
  "philadelphia-flyers": ["Philadelphia", "Flyers"],
  "pittsburgh-penguins": ["Pittsburgh", "Penguins"],
  "san-jose-sharks": ["San Jose", "Sharks"],
  "seattle-kraken": ["Seattle", "Kraken"],
  "st-louis-blues": ["St. Louis", "Blues"],
  "tampa-bay-lightning": ["Tampa Bay", "Lightning"],
  "toronto-maple-leafs": ["Toronto", "Maple Leafs"],
  "utah-mammoth": ["Utah", "Mammoth"],
  "vancouver-canucks": ["Vancouver", "Canucks"],
  "vegas-golden-knights": ["Vegas", "Golden Knights"],
  "washington-capitals": ["Washington", "Capitals"],
  "winnipeg-jets": ["Winnipeg", "Jets"],
};

export function getNhlTeamNameLines(item: DraftItem): readonly string[] {
  if (item.sport !== "NHL") return [item.name];
  const catalogId = defaultDraftItems.find((team) => team.name === item.name)?.id;
  return nhlNames[item.id] ?? (catalogId ? nhlNames[catalogId] : undefined) ?? [item.name];
}
