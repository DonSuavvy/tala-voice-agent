/**
 * An error as text for a message: its own message, or the thrown value as a
 * string. The one helper the eval package and its scripts use for this.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
