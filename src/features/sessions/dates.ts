// Pure date formatting shared by the session UI. UTC so server and client render the same text.
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export const formatDate = (d: Date | string) => `${DATE.format(new Date(d))} UTC`;
export const formatDateTime = (d: Date | string) => `${DATE_TIME.format(new Date(d))} UTC`;
