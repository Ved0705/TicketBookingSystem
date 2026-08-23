import QRCode from 'qrcode';

/**
 * The QR encodes the booking reference and nothing else, so a door scanner
 * can look the booking up server-side rather than trusting the payload.
 */
export const qrPayloadFor = (reference) => reference;

export async function qrDataUrl(reference) {
  return QRCode.toDataURL(qrPayloadFor(reference), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}

export async function qrSvg(reference) {
  return QRCode.toString(qrPayloadFor(reference), { type: 'svg', margin: 1 });
}
