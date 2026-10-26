const stateLevelAliases = new Set([
  "state-wide / not stated",
  "state wide / not stated",
  "statewide / not stated",
  "state-wide",
  "state wide",
  "statewide",
  "not stated",
]);

export function displayLocation(value: string | null | undefined): string {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "";

  const normalized = trimmed
    .replace(/^[([{]+|[)\]}]+$/g, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ");

  return stateLevelAliases.has(normalized) ? "No district/region" : trimmed;
}
