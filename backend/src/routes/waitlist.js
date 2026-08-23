import { Router } from 'express';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  joinWaitlist,
  leaveWaitlist,
  myWaitlist,
  acceptOffer,
  declineOffer,
  sweepExpired,
} from '../services/seatService.js';

const router = Router();
router.use(requireAuth);

/** POST /api/waitlist — join the FIFO queue for a sold-out seat category. */
router.post(
  '/',
  requireRole('CUSTOMER'),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      showId: { type: 'int', required: true },
      categoryId: { type: 'int', required: true },
    });
    res.status(201).json(
      joinWaitlist({ userId: req.user.id, showId: body.showId, categoryId: body.categoryId })
    );
  })
);

/** GET /api/waitlist — my queue positions and any pending offer. */
router.get(
  '/',
  requireRole('CUSTOMER'),
  asyncHandler(async (req, res) => {
    res.json({ entries: myWaitlist(req.user.id) });
  })
);

router.delete(
  '/:id',
  requireRole('CUSTOMER'),
  asyncHandler(async (req, res) => {
    res.json(leaveWaitlist({ userId: req.user.id, waitlistId: Number(req.params.id) }));
  })
);

/** Accept an offer — converts the reserved seat into a normal hold. */
router.post(
  '/offers/:id/accept',
  requireRole('CUSTOMER'),
  asyncHandler(async (req, res) => {
    res.json(acceptOffer({ userId: req.user.id, offerId: Number(req.params.id) }));
  })
);

router.post(
  '/offers/:id/decline',
  requireRole('CUSTOMER'),
  asyncHandler(async (req, res) => {
    res.json(declineOffer({ userId: req.user.id, offerId: Number(req.params.id) }));
  })
);

/**
 * Force an expiry sweep. The background scheduler already does this every few
 * seconds; the endpoint exists so tests and demos can trigger it on demand.
 */
router.post(
  '/sweep',
  requireRole('ADMIN'),
  asyncHandler(async (_req, res) => {
    const result = sweepExpired();
    res.json({
      showsTouched: [...result.changedShows.keys()],
      seatsChanged: [...result.changedShows.values()].reduce((n, s) => n + s.length, 0),
      offersCreated: result.newOffers.length,
    });
  })
);

export default router;
