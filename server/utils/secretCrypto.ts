import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// Project secrets are encrypted with AES-256-GCM under a key that lives in the
// environment, not in the database: a copy of the database alone reads as noise.
// The key is 32 random bytes written as 64 hex characters or as base64, e.g.
//   openssl rand -hex 32
// Losing or changing it makes every stored secret unreadable, so it is kept
// with the other deployment secrets and backed up apart from the database.
const KEY_VARIABLE = 'SECRETS_ENCRYPTION_KEY'
const FORMAT = 'v1'

function readKey(): { key: Buffer } | { problem: string } {
  const raw = process.env[KEY_VARIABLE]?.trim()
  if (!raw) return { problem: `${KEY_VARIABLE} is not set, so secrets cannot be stored. Set it to 32 random bytes (openssl rand -hex 32) and restart.` }

  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) return { problem: `${KEY_VARIABLE} must be 32 bytes, as 64 hex characters or base64 (openssl rand -hex 32).` }
  return { key }
}

/** Why secrets cannot be stored on this install, or null when they can. */
export function secretsUnavailableReason(): string | null {
  const found = readKey()
  return 'problem' in found ? found.problem : null
}

function requireKey(): Buffer {
  const found = readKey()
  if ('problem' in found) throw createError({ statusCode: 503, message: found.problem })
  return found.key
}

/**
 * Encrypts one value. `context` is bound into the ciphertext as additional
 * authenticated data, so a stored value copied onto another secret's row fails
 * to decrypt instead of quietly reading as that secret.
 */
export function encryptSecret(plain: string, context: string): string {
  const key = requireKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [FORMAT, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':')
}

export function decryptSecret(stored: string, context: string): string {
  const key = requireKey()
  const [format, iv, tag, body] = stored.split(':')
  if (format !== FORMAT || !iv || !tag || body === undefined) {
    throw createError({ statusCode: 500, message: 'A stored secret is in a format this version cannot read' })
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw createError({ statusCode: 500, message: `A stored secret could not be decrypted. Was ${KEY_VARIABLE} changed?` })
  }
}
