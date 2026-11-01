import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser'
import { asciiAddress, isReservedInvalidAddress } from '../utils/crewAccounts'
// Mail is optional: without a host and a sender address nothing that needs it is
// switched on, so an instance with no SMTP server keeps working as before.
export const mailEnabled = Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM)

let transport: Transporter | null = null

function getTransport(): Transporter {
  if (transport) return transport

  // SMTP_SECURE means TLS from the first byte (port 465). Left off, the
  // connection starts plain and upgrades with STARTTLS when the server offers it.
  const secure = process.env.SMTP_SECURE === 'true'
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || (secure ? 465 : 587),
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined
  })
  return transport
}

// Addresses in the reserved .invalid space never receive mail (crew accounts are such
// addresses). Dropped here, whoever sent the message: no error, and nothing about the
// message is logged.
//
// The to-string is parsed with nodemailer's own address parser, so what is checked is
// what the transport would have parsed. Only the parsed addresses are kept, and the list
// handed on is rebuilt from them, never the original string.
// Only what the whitelist in crewAccounts (asciiAddress) accepts goes on, and it goes on in
// the normalised ASCII form that was checked. Reserved addresses are dropped; anything that
// does not convert to a real hostname is dropped too (fail closed).

export function deliverableRecipients(to: string): string[] {
  // A control character (line breaks, NUL, tab, the rest of the C0 set, DEL) in a recipient is a
  // header injection or a re-targeting attempt: nothing is sent.
  if ([...to].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return []
  const kept: { address: string, name: string }[] = []
  for (const entry of addressparser(to, { flatten: true })) {
    // Flattened, every entry is a mailbox; an entry without an address is nothing to send to.
    if (!('address' in entry) || !entry.address) continue
    const address = asciiAddress(entry.address)
    if (address === null || isReservedInvalidAddress(address)) continue
    // A display name is kept only when it cannot carry an address of its own.
    const name = entry.name && !/[@<>"\\\r\n]/.test(entry.name) ? entry.name : ''
    kept.push({ address, name })
  }
  if (!kept.length) return []

  const formatted = kept.map(k => (k.name ? `"${k.name}" <${k.address}>` : k.address))

  // The transport reads the joined string again. That reading must hold exactly the kept
  // addresses, each in its checked form and none reserved. If it does not, nothing is sent.
  const reread = addressparser(formatted.join(', '), { flatten: true })
  const same = reread.length === kept.length && reread.every((entry, i) =>
    'address' in entry
    && entry.address === kept[i]!.address
    && asciiAddress(entry.address) === entry.address
    && !isReservedInvalidAddress(entry.address))
  return same ? formatted : []
}
/** Sends through the given transport. Exported so the recipient rules are tested without SMTP. */
export async function sendMailWith(
  mailer: Pick<Transporter, 'sendMail'>,
  message: { to: string, subject: string, text: string, html: string }
) {
  const to = deliverableRecipients(message.to)
  if (!to.length) return
  await mailer.sendMail({ from: process.env.SMTP_FROM, ...message, to: to.join(', ') })
}

export async function sendMail(message: { to: string, subject: string, text: string, html: string }) {
  await sendMailWith(getTransport(), message)
}
