import 'server-only';
import { cache } from 'react';
import { getPaste } from './service';

/** Memoised per request: the paste layout (404 gate), generateMetadata and the page share one query. */
export const loadPaste = cache(getPaste);
