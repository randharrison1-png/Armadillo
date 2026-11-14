const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
export const pasteDate = (d: Date | string) => DATE.format(new Date(d));
export const pasteDateTime = (d: Date | string) => `${DATE_TIME.format(new Date(d))} UTC`;
export const pasteTitle = (title: string | null) => (title && title.trim() ? title : 'Untitled paste');
