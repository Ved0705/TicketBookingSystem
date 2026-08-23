import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import config from '../config.js';
import { db } from '../db/index.js';

let smtpTransport = null;

function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  smtpTransport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  return smtpTransport;
}

function record({ to, subject, body, transport, status, error }) {
  try {
    db.prepare(
      `INSERT INTO email_log (to_email, subject, body, transport, status, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(to, subject, body, transport, status, error || null);
  } catch {
    /* logging must never break a booking */
  }
}

function writeToOutbox({ to, subject, html }) {
  fs.mkdirSync(config.mail.outboxDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = to.replace(/[^a-z0-9@._-]/gi, '_');
  const file = path.join(config.mail.outboxDir, `${stamp}__${safe}.html`);
  fs.writeFileSync(
    file,
    `<!-- To: ${to}\n     Subject: ${subject}\n     Sent: ${new Date().toISOString()} -->\n${html}`
  );
  return file;
}

/**
 * Send an email.
 *
 * MAIL_TRANSPORT=smtp   -> real delivery through the configured SMTP server.
 * MAIL_TRANSPORT=file   -> writes an .html file into backend/outbox  (default)
 * MAIL_TRANSPORT=console-> prints a summary to stdout
 *
 * Every attempt is written to the `email_log` table either way, so the flow is
 * verifiable without any third-party credentials.
 */
export async function sendMail({ to, subject, html, text }) {
  const mode = config.mail.transport;

  if (mode === 'smtp' && config.mail.host) {
    try {
      const info = await getSmtpTransport().sendMail({
        from: config.mail.from,
        to,
        subject,
        html,
        text,
      });
      record({ to, subject, body: html, transport: 'smtp', status: 'SENT' });
      return { transport: 'smtp', ok: true, messageId: info.messageId };
    } catch (err) {
      // Never let a mail outage roll back a confirmed booking — log and fall back.
      record({ to, subject, body: html, transport: 'smtp', status: 'FAILED', error: err.message });
      const file = writeToOutbox({ to, subject, html });
      return { transport: 'file', ok: false, error: err.message, file };
    }
  }

  if (mode === 'console') {
    console.log(`\n--- EMAIL (dev) ---\nTo: ${to}\nSubject: ${subject}\n${text || ''}\n---\n`);
    record({ to, subject, body: html, transport: 'console', status: 'SENT' });
    return { transport: 'console', ok: true };
  }

  const file = writeToOutbox({ to, subject, html });
  record({ to, subject, body: html, transport: 'file', status: 'SENT' });
  return { transport: 'file', ok: true, file };
}

const row = (label, value) =>
  `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;font:13px system-ui">${label}</td>
       <td style="padding:6px 0;color:#111827;font:600 13px system-ui">${value}</td></tr>`;

export function bookingConfirmationEmail({ booking, event, show, venue, seats, qrDataUrl }) {
  const seatList = seats.map((s) => `${s.row_label}${s.seat_number} (${s.category})`).join(', ');
  const when = new Date(show.starts_at).toUTCString();
  const html = `
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff">
    <p style="font:600 12px system-ui;letter-spacing:.12em;color:#6b7280;margin:0 0 4px">
      BOOKING CONFIRMED</p>
    <h1 style="font:700 24px system-ui;color:#111827;margin:0 0 16px">${event.title}</h1>
    <table style="border-collapse:collapse">
      ${row('Venue', `${venue.name}, ${venue.city}`)}
      ${row('Date &amp; time', when)}
      ${row('Seats', seatList)}
      ${row('Booking reference', booking.reference)}
      ${row('Total paid', `${booking.total_amount.toFixed(2)}`)}
    </table>
    <p style="font:13px system-ui;color:#374151;margin:20px 0 8px">
      Show this QR code at the entrance.</p>
    <img src="${qrDataUrl}" alt="QR code for booking ${booking.reference}" width="220" height="220"/>
    <p style="font:12px system-ui;color:#9ca3af;margin-top:20px">
      Cancel any time from your booking history before the show starts.</p>
  </div>`;
  const text = `Booking confirmed — ${event.title}
Venue: ${venue.name}, ${venue.city}
When: ${when}
Seats: ${seatList}
Reference: ${booking.reference}
Total: ${booking.total_amount.toFixed(2)}`;
  return { subject: `Your tickets for ${event.title} — ${booking.reference}`, html, text };
}

export function waitlistOfferEmail({ user, event, show, venue, seat, offer, expiresAt }) {
  const when = new Date(show.starts_at).toUTCString();
  const minutes = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 60000));
  const html = `
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff">
    <p style="font:600 12px system-ui;letter-spacing:.12em;color:#6b7280;margin:0 0 4px">
      A SEAT OPENED UP</p>
    <h1 style="font:700 24px system-ui;color:#111827;margin:0 0 16px">${event.title}</h1>
    <p style="font:14px system-ui;color:#374151">
      Hi ${user.name}, seat <b>${seat.row_label}${seat.seat_number}</b> (${seat.category})
      is reserved for you.</p>
    <table style="border-collapse:collapse">
      ${row('Venue', `${venue.name}, ${venue.city}`)}
      ${row('Date &amp; time', when)}
      ${row('Offer expires', new Date(expiresAt).toUTCString())}
    </table>
    <p style="font:14px system-ui;color:#374151">
      Accept within <b>${minutes} minute(s)</b> or the seat goes to the next person in the queue.
      Open your waitlist page to accept: <b>/waitlist</b> (offer #${offer.id}).</p>
  </div>`;
  const text = `A seat opened up for ${event.title}.
Seat ${seat.row_label}${seat.seat_number} (${seat.category}) is held for you until ${expiresAt}.
Accept it from your waitlist page (offer #${offer.id}).`;
  return { subject: `Seat available for ${event.title} — accept within ${minutes} min`, html, text };
}
