/**
 * Demo friends: tap-to-add invitee names for judges (demo mode only). Plain
 * constants, importable from client components.
 */
export const DEMO_FRIEND_NAMES: readonly string[] = ["Ben", "Freya", "Jules", "Noor", "Maya", "Leo", "Ida", "Omar", "Kai", "Sofia"];

const normalize = (name: string): string => name.trim().toLocaleLowerCase();

/** Friends not yet in the outing and not already typed (case-insensitive). */
export function availableDemoFriends(takenNames: readonly string[]): string[] {
  const taken = new Set(takenNames.map(normalize));
  return DEMO_FRIEND_NAMES.filter((name) => !taken.has(normalize(name)));
}

/** Names typed in the invite field: one per line or comma-separated (same split the form submits). */
export function splitTypedNames(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((n) => n.trim())
    .filter(Boolean);
}
