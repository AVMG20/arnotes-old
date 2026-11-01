// Mail recipients: the reserved .invalid space never reaches the transport, and only a
// whitelisted address in its normalised ASCII form is ever sent. Each case asserts the exact
// string deliverableRecipients returns and the exact `to` a mocked transport is handed; the
// re-read compares addresses, not counts. Unit tests, no SMTP:
//   node --import tsx --test tests/mail-recipients.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import addressparser from 'nodemailer/lib/addressparser'
import { deliverableRecipients, sendMailWith } from '../server/lib/mailer'
import { asciiAddress, isReservedInvalidAddress } from '../server/utils/crewAccounts'

const MESSAGE = { subject: 's', text: 'body', html: '<p>body</p>' }

/** What the transport is handed for a to-string, or null when nothing is sent. */
async function handedTo(to: string): Promise<string | null> {
  const sent: { to: string }[] = []
  const mailer = {
    sendMail: async (m: { to: string }) => {
      sent.push(m)
    }
  }
  await sendMailWith(mailer as unknown as Parameters<typeof sendMailWith>[0], { to, ...MESSAGE })
  return sent.length ? sent[0]!.to : null
}

/** The addresses a list names, read the way the transport reads it. */
function addressesOf(list: string[]): string[] {
  return addressparser(list.join(', '), { flatten: true }).map(entry => ('address' in entry ? entry.address : ''))
}

/** Each case: the to-string, and the exact list deliverableRecipients returns for it. */
const EXACT: [string, string[]][] = [
  // Kept, in the form that was checked.
  ['a@example.com', ['a@example.com']],
  // The domain is sent in its lower-case ASCII form.
  ['A@EXAMPLE.COM', ['A@example.com']],
  ['a@example.invalidation.com', ['a@example.invalidation.com']],
  ['a@foo.invalid.example.com', ['a@foo.invalid.example.com']],
  ['Name <a@example.com>', ['"Name" <a@example.com>']],
  ['a+tag@example.com', ['a+tag@example.com']],
  ['a@example.com.', ['a@example.com']],
  ['a@xn--bcher-kva.example', ['a@xn--bcher-kva.example']],
  ['a@bücher.example', ['a@xn--bcher-kva.example']],
  ['a@' + 'a'.repeat(63) + '.example', ['a@' + 'a'.repeat(63) + '.example']],
  // Dropped: the reserved space, in every spelling.
  ['x@crew.invalid', []],
  ['Name <x@crew.invalid>', []],
  ['x@foo.invalid', []],
  ['x@crew.invalid.', []],
  ['X@CREW.INVALID', []],
  ['x@CREW.INVALID。', []],
  ['x@crew.invalid．', []],
  ['x@crew.invalid。', []],
  ['invalid@invalid', []],
  // Nina round 6: fail closed on unconvertible or bracketed domains.
  ['x@crew.invalid%', []],
  ['x@crew.invalid＞', []],
  ['[x@crew.invalid]', []],
  ['x@[crew.invalid]', []],
  ['a@[1.2.3.4]', []],
  ['a@' + 'a'.repeat(64) + '.example', []],
  // Lists keep their deliverable address only.
  ['a@example.com, x@crew.invalid', ['a@example.com']],
  ['x@crew.invalid, Name <a@example.com>', ['"Name" <a@example.com>']],
  // A reserved address hidden in a missing comma, a comment, a quoted name or group syntax.
  ['<a@b.com>;<x@crew.invalid>', ['a@b.com']],
  ['<a@b.com>(<x@crew.invalid>)', ['a@b.com']],
  ['<a@b.com>"<x@crew.invalid>"', ['a@b.com']],
  ['a@b.com<x@crew.invalid>', []],
  ['"<x@crew.invalid>" <a@b.com>', ['a@b.com']],
  ['Team: a@example.com, x@crew.invalid;', ['a@example.com']],
  ['Team: x@crew.invalid;', []],
  // Quoted local parts and brackets around a reserved address: refused.
  ['<"x@crew.invalid">', []],
  ['<"x@crew.invalid">@b.com', []],
  ['"x@crew.invalid"@b.com', []],
  ['"a"@crew.invalid', []],
  ['"x@crew.invalid"@example.com', []],
  // Nothing at all.
  ['', []],
  ['   ', []],
  ['hello', []],
  ['Name <x@crew.invalid', []]
]

for (const [to, expected] of EXACT) {
  test(`deliverableRecipients(${JSON.stringify(to)}) is ${JSON.stringify(expected)}`, () => {
    const result = deliverableRecipients(to)
    assert.deepEqual(result, expected)
    // The transport reads the same addresses that were checked.
    assert.deepEqual(addressesOf(result), addressesOf(expected))
  })
}

test('the transport is handed exactly the checked string, or nothing', async () => {
  assert.equal(await handedTo('<a@b.com>;<x@crew.invalid>'), 'a@b.com')
  assert.equal(await handedTo('<a@b.com>(<x@crew.invalid>)'), 'a@b.com')
  assert.equal(await handedTo('a@b.com<x@crew.invalid>'), null)
  assert.equal(await handedTo('Name <a@example.com>'), '"Name" <a@example.com>')
  assert.equal(await handedTo('A@EXAMPLE.COM'), 'A@example.com')
  assert.equal(await handedTo('a@bücher.example'), 'a@xn--bcher-kva.example')
  assert.equal(await handedTo('x@crew.invalid, Name <y@foo.invalid>'), null)
  assert.equal(await handedTo('<x@crew.invalid>;<y@foo.invalid>'), null)
})

test('Nina rounds 4 to 6: no reserved or unconvertible address reaches the transport', async () => {
  for (const to of ['"<\\"x@crew.invalid\\">"', '"<\\"x@crew.invalid\\">@b.com"', '<"x@crew.invalid">', '<"x@crew.invalid">@b.com',
    '"x@crew.invalid"@b.com', 'x@crew.invalid。', 'x@crew.invalid%', 'x@crew.invalid＞', '[x@crew.invalid]', 'x@[crew.invalid]', 'a@[1.2.3.4]']) {
    assert.equal(await handedTo(to), null, to)
  }
})

test('a line break in the to-string sends nothing (no header injection)', async () => {
  assert.equal(await handedTo('a@example.com\r\nBcc: x@crew.invalid'), null)
  assert.equal(await handedTo('a@example.com\nBcc: b@example.com'), null)
  assert.deepEqual(deliverableRecipients('a@example.com\r\nBcc: b@example.com'), [])
})

test('the whitelist: ASCII form of a plain address, or nothing', () => {
  assert.equal(asciiAddress('a+tag@example.com'), 'a+tag@example.com')
  assert.equal(asciiAddress('a@bücher.example'), 'a@xn--bcher-kva.example')
  assert.equal(asciiAddress('a@example.com.'), 'a@example.com')
  assert.equal(asciiAddress('a@'), null)
  assert.equal(asciiAddress('a b@example.com'), null)
  assert.equal(asciiAddress('a@[1.2.3.4]'), null)
})

test('fail closed: anything not a plain, convertible address is reserved for the purpose of sending', () => {
  assert.equal(isReservedInvalidAddress('a@'), true)
  assert.equal(isReservedInvalidAddress('plain text'), true)
  assert.equal(isReservedInvalidAddress('a@example.com'), false)
  assert.equal(isReservedInvalidAddress('x@crew.invalid．'), true)
})

test('a control character anywhere in the to-string sends nothing', async () => {
  for (const to of ['x@crew.in\tvalid', 'a@example.com\x00', 'a@example.com\x7f', 'a@example.com\x01', 'a@example.com\r', 'a@example.com\n', 'a@example.com\x1f, b@example.com']) {
    assert.deepEqual(deliverableRecipients(to), [], JSON.stringify(to))
    assert.equal(await handedTo(to), null, JSON.stringify(to))
  }
})

test('the local part is at most 64 octets: 64 kept, 65 dropped', () => {
  const sixtyFour = 'a'.repeat(64)
  const sixtyFive = 'a'.repeat(65)
  assert.deepEqual(deliverableRecipients(`${sixtyFour}@example.com`), [`${sixtyFour}@example.com`])
  assert.deepEqual(deliverableRecipients(`${sixtyFive}@example.com`), [])
  assert.equal(asciiAddress(`${sixtyFive}@example.com`), null)
})
