export function displayChannelName(name: string): string {
  const cleanedName = name.replace(/^\s*\d+\s*[.)|:\-–—]\s*/u, "").trim();
  return cleanedName || name.trim();
}
