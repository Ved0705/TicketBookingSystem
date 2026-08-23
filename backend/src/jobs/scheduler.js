import config from '../config.js';
import { sweepExpired } from '../services/seatService.js';

let timer = null;

/**
 * TTL enforcement lives here, not in the browser.
 *
 * Every SWEEP_INTERVAL_MS the sweeper asks the database for holds and offers
 * whose `expires_at` has passed and reconciles them: seats go back to
 * AVAILABLE, waitlist offers roll on to the next customer, and the changes are
 * broadcast to connected seat maps. Closing the tab, killing the frontend, or
 * losing the network changes nothing — the expiry still happens.
 */
export function startScheduler() {
  if (timer) return timer;
  timer = setInterval(() => {
    try {
      sweepExpired();
    } catch (err) {
      console.error('[scheduler] sweep failed:', err.message);
    }
  }, config.sweepIntervalMs);
  timer.unref?.();
  console.log(`[scheduler] expiry sweep running every ${config.sweepIntervalMs}ms`);
  return timer;
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
