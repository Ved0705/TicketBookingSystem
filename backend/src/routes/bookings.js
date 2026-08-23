import { Router } from 'express';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import config from '../config.js';
import {
  holdSeats,
  getHold,
  releaseHold,
  confirmBooking,
  getBooking,
  listBookings,
  cancelBooking,
  deliverTicket,
} from '../services/seatService.js';

const router = Router();
router.use(requireAuth, requireRole('CUSTOMER'));

/* --------------------------------------------------------------- holds */

/** POST /api/holds — place a temporary hold on seats for a show. */
router.post(
  '/holds',
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      showId: { type: 'int', required: true },
      seatIds: { type: 'array', of: 'int', required: true, minLength: 1, maxLength: config.maxSeatsPerHold },
      ttlSeconds: { type: 'int', min: 1, max: 3600 },
    });
    res.status(201).json(
      holdSeats({
        userId: req.user.id,
        showId: body.showId,
        seatIds: body.seatIds,
        ttlSeconds: body.ttlSeconds,
      })
    );
  })
);

router.get(
  '/holds/:id',
  asyncHandler(async (req, res) => {
    res.json(getHold({ userId: req.user.id, holdId: Number(req.params.id) }));
  })
);

router.delete(
  '/holds/:id',
  asyncHandler(async (req, res) => {
    res.json(releaseHold({ userId: req.user.id, holdId: Number(req.params.id) }));
  })
);

/* ------------------------------------------------------------ bookings */

/** POST /api/bookings — turn an active hold into a confirmed booking. */
router.post(
  '/bookings',
  asyncHandler(async (req, res) => {
    const body = validate(req.body, { holdId: { type: 'int', required: true } });
    const booking = await confirmBooking({ userId: req.user.id, holdId: body.holdId });
    res.status(201).json({ booking });
  })
);

router.get(
  '/bookings',
  asyncHandler(async (req, res) => {
    res.json({ bookings: listBookings(req.user.id) });
  })
);

router.get(
  '/bookings/:id',
  asyncHandler(async (req, res) => {
    res.json({ booking: await getBooking({ userId: req.user.id, bookingId: Number(req.params.id) }) });
  })
);

router.post(
  '/bookings/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(cancelBooking({ userId: req.user.id, bookingId: Number(req.params.id) }));
  })
);

/** Re-send the ticket email (useful for demoing the QR/email flow). */
router.post(
  '/bookings/:id/resend-ticket',
  asyncHandler(async (req, res) => {
    await getBooking({ userId: req.user.id, bookingId: Number(req.params.id) }); // ownership check
    res.json({ email: await deliverTicket(Number(req.params.id)) });
  })
);

export default router;
