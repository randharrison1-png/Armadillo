const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
export const pasteDate = (d: Date | string) => DATE.format(new Date(d));
export const pasteDateTime = (d: Date | string) => `${DATE_TIME.format(new Date(d))} UTC`;
export const pasteTitle = (title: string | null) => (title && title.trim() ? title : 'Untitled paste');

/** "Try again in 5 minutes" from whole seconds (rounded up to a whole minute, at least 1). */
export function retryMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
