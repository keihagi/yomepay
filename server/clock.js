// The app's clock. YOMEPAY_NOW lets you test deadlines: the clock starts at that time and keeps moving.
import { config } from './config.js';

const startedAt = Date.now();
const fakeStart = config.fakeNow ? Date.parse(config.fakeNow) : NaN;
if (config.fakeNow && Number.isNaN(fakeStart)) console.warn(`YOMEPAY_NOW (${config.fakeNow}) is not a valid date; using the real clock.`);

export const now = () => (Number.isNaN(fakeStart) ? Date.now() : fakeStart + (Date.now() - startedAt));
export const isFake = () => !Number.isNaN(fakeStart);
