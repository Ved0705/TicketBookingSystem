import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap,
} from './helpers.js';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Poll email_log briefly for a row that has landed asynchronously. */
async function waitForEmailLogRow(db, toEmail, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = db
        .prepare('SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1')
        .get(toEmail);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

let admin, organiser;

before(async () => {
  await startServer();
  admin = await createAdmin();
  organiser = await register('ORGANISER');
});
after(async () => { await stopServer(); });

async function bookOneSeat(customer) {
  const f = await buildShow({
    admin, organiser,
    rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }],
    prices: { Premium: 750 },
  });
  const seat = (await seatMap(f.show.id)).seats[0];
  const hold = await api('/api/holds', {
    method: 'POST', token: customer.token, body: { showId: f.show.id, seatIds: [seat.id] },
  });
  const res = await api('/api/bookings', {
    method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
  });
  assert.equal(res.status, 201);
  return { fixture: f, booking: res.body.booking };
}

describe('booking reference and QR code', () => {
  test('every booking gets a unique, readable reference', async () => {
    const seen = new Set();
    for (let i = 0; i < 3; i += 1) {
      const customer = await register('CUSTOMER');
      const { booking } = await bookOneSeat(customer);
      assert.match(booking.reference, /^TBS-[A-Z2-9]{8}$/);
      // Ambiguous glyphs are excluded so the code can be read aloud.
      assert.ok(!/[IO01]/.test(booking.reference.slice(4)));
      assert.equal(seen.has(booking.reference), false, 'references must be unique');
      seen.add(booking.reference);
    }
  });

  test('the QR code is a real PNG and encodes exactly the booking reference', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    assert.ok(booking.qrDataUrl.startsWith('data:image/png;base64,'));
    const bytes = Buffer.from(booking.qrDataUrl.split(',')[1], 'base64');
    assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        'must carry a valid PNG signature'
    );
    assert.ok(bytes.length > 200, 'must not be an empty image');

    // What the QR encodes is stored alongside the booking; assert it matches.
    const { db } = await import('../src/db/index.js');
    const row = db.prepare('SELECT qr_payload FROM bookings WHERE id = ?').get(booking.id);
    assert.equal(row.qr_payload, booking.reference);

    // Re-encoding the reference reproduces the same image, which confirms the
    // payload that went into the QR is the reference and nothing else.
    const { qrDataUrl } = await import('../src/utils/qr.js');
    assert.equal(await qrDataUrl(booking.reference), booking.qrDataUrl);
  });

  test('the QR is available again when re-reading the booking', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);
    const res = await api(`/api/bookings/${booking.id}`, { token: customer.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.qrDataUrl, booking.qrDataUrl);
  });
});

describe('ticket email', () => {
  test('confirming a booking sends a ticket email and records it', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    // Mail delivery runs in the background so a slow/unreachable provider
    // never makes checkout hang — the booking response only reports that
    // delivery has been kicked off, not its outcome.
    assert.deepEqual(booking.email, { pending: true });

    const { db } = await import('../src/db/index.js');
    const row = await waitForEmailLogRow(db, customer.email);

    assert.ok(row, 'the send is recorded in email_log');
    assert.equal(row.status, 'SENT');
    assert.match(row.subject, new RegExp(booking.reference));
  });

  test('the email body carries the event, venue, seats, reference and QR image', async () => {
    const customer = await register('CUSTOMER');
    const { fixture, booking } = await bookOneSeat(customer);

    const { db } = await import('../src/db/index.js');
    const row = await waitForEmailLogRow(db, customer.email);

    assert.match(row.body, new RegExp(fixture.event.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(row.body, new RegExp(fixture.venue.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(row.body, new RegExp(booking.reference));
    assert.match(row.body, /A1/, 'seat label');
    assert.match(row.body, /data:image\/png;base64,/, 'inline QR image');
  });

  test('the developer outbox endpoint exposes what was sent', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    const { db } = await import('../src/db/index.js');
    await waitForEmailLogRow(db, customer.email);

    const list = await api('/api/dev/emails?limit=5');
    assert.equal(list.status, 200);
    assert.ok(list.body.emails.length > 0);

    const mine = list.body.emails.find((e) => e.to_email === customer.email);
    assert.ok(mine, 'the ticket email is listed');
    assert.match(mine.subject, new RegExp(booking.reference));

    const html = await fetch(`${(await startServer())}/api/dev/emails/${mine.id}`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), new RegExp(booking.reference));
  });

  test('a customer can re-send their own ticket but not someone else\'s', async () => {
    const customer = await register('CUSTOMER');
    const stranger = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    const resend = await api(`/api/bookings/${booking.id}/resend-ticket`, {
      method: 'POST', token: customer.token,
    });
    assert.equal(resend.status, 200);
    assert.equal(resend.body.email.ok, true);

    const stolen = await api(`/api/bookings/${booking.id}/resend-ticket`, {
      method: 'POST', token: stranger.token,
    });
    assert.equal(stolen.status, 403);
  });

  test('a waitlist offer sends an email to the offered customer', async () => {
    const f = await buildShow({
      admin, organiser,
      rows: [{ rowLabel: 'A', seats: 1, category: 'Premium' }],
      prices: { Premium: 500 },
    });
    const buyer = await register('CUSTOMER');
    const seat = (await seatMap(f.show.id)).seats[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: buyer.token, body: { showId: f.show.id, seatIds: [seat.id] },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: buyer.token, body: { holdId: hold.body.holdId },
    })).body.booking;

    const waiter = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    // The offer email is dispatched without blocking the cancellation response.
    await new Promise((r) => setTimeout(r, 250));

    const { db } = await import('../src/db/index.js');
    const row = db
        .prepare('SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1')
        .get(waiter.email);
    assert.ok(row, 'the waitlist offer email was sent');
    assert.match(row.subject, /accept within/i);
    assert.match(row.body, /A1/);
  });
});

describe('SMTP delivery path', () => {
  /**
   * The dev transports never exercise nodemailer itself. This spins up a
   * throwaway SMTP server and runs the send in a child process (config.js is a
   * module singleton, so the transport has to be chosen before it loads).
   * It then asserts on the raw MIME that arrives — in particular that the QR is
   * an inline CID attachment rather than a `data:` URI, which Gmail and Outlook
   * silently block.
   */
  function smtpSink() {
    const received = [];
    const server = net.createServer((sock) => {
      let buf = '';
      let inData = false;
      let msg = '';
      sock.write('220 localhost ESMTP test\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') { inData = false; received.push(msg); msg = ''; sock.write('250 OK\r\n'); }
            else msg += line + '\n';
            continue;
          }
          const cmd = line.toUpperCase();
          if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (cmd === 'DATA') { inData = true; sock.write('354 Go ahead\r\n'); }
          else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    return { server, received };
  }

  /** Run one send in a child process with the given mail environment. */
  function sendInChild(env) {
    const file = path.join(os.tmpdir(), `tbs-mail-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(file, `
      const mailer = await import(${JSON.stringify(pathToFileURL(path.resolve('src/utils/mailer.js')).href)});
      const { qrDataUrl } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/utils/qr.js')).href)});
      const dataUrl = await qrDataUrl('TBS-SMTPTEST');
      const mail = mailer.bookingConfirmationEmail({
        booking: { reference: 'TBS-SMTPTEST', total_amount: 500 },
        event: { title: 'SMTP Test Show' },
        show: { starts_at: new Date().toISOString() },
        venue: { name: 'Test Venue', city: 'Testville' },
        seats: [{ row_label: 'A', seat_number: 1, category: 'Premium' }],
        qrDataUrl: dataUrl,
      });
      const res = await mailer.sendMail({ to: 'reviewer@test.local', ...mail });
      process.send({
        res,
        attachmentCount: mail.attachments.length,
        cid: mail.attachments[0］?.cid,
        htmlUsesCid: /cid:booking-qr/.test(mail.html),
        htmlUsesDataUri: /<img[^>]+src="data:/.test(mail.html),
      });
    `.replace('［', '[').replace('］', ']'));

    return new Promise((resolve) => {
      const child = fork(file, [], {
        stdio: 'ignore',
        env: { ...process.env, DATABASE_FILE: ':memory:', ...env },
      });
      child.on('message', (m) => { fs.rmSync(file, { force: true }); resolve(m); });
      child.on('exit', () => resolve(null));
    });
  }

  test('sends real MIME with the QR as an inline CID attachment', async () => {
    const { server, received } = smtpSink();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
      const out = await sendInChild({
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_SECURE: 'false',
      });

      assert.ok(out, 'the child reported a result');
      assert.equal(out.attachmentCount, 1);
      assert.equal(out.cid, 'booking-qr');
      assert.equal(out.htmlUsesCid, true);
      assert.equal(out.htmlUsesDataUri, false, 'must not inline the QR as a data URI');
      assert.equal(out.res.transport, 'smtp');
      assert.equal(out.res.ok, true);

      const raw = received.join('\n');
      assert.match(raw, /Content-Type: multipart\/related/);
      assert.match(raw, /Content-ID: <booking-qr>/);
      assert.match(raw, /Content-Disposition: inline/);
      assert.match(raw, /image\/png/);
      assert.match(raw, /TBS-SMTPTEST/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('a failed SMTP send falls back to a file instead of losing the ticket', async () => {
    const out = await sendInChild({
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1', // nothing is listening here
      SMTP_SECURE: 'false',
    });
    assert.ok(out);
    assert.equal(out.res.ok, false, 'the failure is reported honestly');
    assert.equal(out.res.transport, 'file', 'but the ticket is still preserved');
    assert.ok(out.res.error);
  });
});