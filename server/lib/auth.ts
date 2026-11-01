import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import { organization } from 'better-auth/plugins/organization'
import { twoFactor } from 'better-auth/plugins/two-factor'
import { passkey } from '@better-auth/passkey'
import { db } from '../db'
import * as schema from '../db/schema'
import { mailEnabled, sendMail } from './mailer'
import { eq } from 'drizzle-orm'
import { ensureOwnerOrganization, invitationTokenFrom, isFirstUser, isLiveInvitation } from '../utils/ownerOrganization'
import { isInvalidDomain } from '../utils/crewAccounts'

const baseURL = process.env.BETTER_AUTH_URL || 'http://localhost:3000'

// One switch for every way an account can be created, enforced in the user
// creation hook below rather than per method: a sign-in method that ignored it
// would turn a private instance back into an open one, and a per-method switch
// could not let an invited customer contact through.
const signUpDisabled = process.env.ALLOW_SIGN_UP === 'false'

const discordEnabled = process.env.NUXT_PUBLIC_DISCORD_ENABLED === 'true'
  && Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET)
const githubEnabled = process.env.NUXT_PUBLIC_GITHUB_ENABLED === 'true'
  && Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
const googleEnabled = process.env.NUXT_PUBLIC_GOOGLE_ENABLED === 'true'
  && Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
const oidcEnabled = process.env.NUXT_PUBLIC_OIDC_ENABLED === 'true'
  && Boolean(process.env.OIDC_DISCOVERY_URL && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET)
const emailCodeEnabled = process.env.NUXT_PUBLIC_EMAIL_CODE_ENABLED === 'true' && mailEnabled
// Passkeys need nothing from outside, so they are on unless switched off.
const passkeysEnabled = process.env.NUXT_PUBLIC_PASSKEYS_ENABLED !== 'false'

const SIGN_IN_CODE_MINUTES = 10

function signInCodeMail(otp: string) {
  const text = `Your Taskmanager sign-in code is ${otp}.\n\nIt expires in ${SIGN_IN_CODE_MINUTES} minutes. If you did not try to sign in, you can ignore this email.`
  const html = `<p>Your Taskmanager sign-in code is</p>`
    + `<p style="font-size:28px;font-weight:600;letter-spacing:6px;font-family:monospace">${otp}</p>`
    + `<p>It expires in ${SIGN_IN_CODE_MINUTES} minutes. If you did not try to sign in, you can ignore this email.</p>`
  return { subject: `${otp} is your Taskmanager sign-in code`, text, html }
}

export const auth = betterAuth({
  appName: 'Taskmanager',
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
      passkey: schema.passkey,
      twoFactor: schema.twoFactor
    }
  }),
  plugins: [
    organization({
      // Owning an organisation is handed out by the instance admin; everyone else
      // joins one with a code or works in a customer's portal.
      async allowUserToCreateOrganization(candidate) {
        const [row] = await db
          .select({ isInstanceAdmin: schema.user.isInstanceAdmin, canCreateOrganizations: schema.user.canCreateOrganizations })
          .from(schema.user)
          .where(eq(schema.user.id, candidate.id))
        return Boolean(row?.isInstanceAdmin || row?.canCreateOrganizations)
      },
      // Better Auth only returns columns it knows about, so `joinCode` has to be
      // declared here or it is stripped from every organization response.
      // `input: false` keeps it server-issued — clients can never set their own.
      schema: {
        organization: {
          additionalFields: {
            joinCode: { type: 'string', required: false, input: false }
          }
        }
      }
    }),
    // Asks for an authenticator code after a correct password. Better Auth only
    // applies it to password sign-in; the hook below covers email codes.
    twoFactor({ issuer: 'Taskmanager' }),
    ...(passkeysEnabled
      ? [passkey({
          // A passkey is bound to this hostname, so one created on localhost
          // does not work on the production domain and vice versa.
          rpID: new URL(baseURL).hostname,
          rpName: 'Taskmanager',
          origin: new URL(baseURL).origin
        })]
      : []),
    ...(emailCodeEnabled
      ? [emailOTP({
          expiresIn: SIGN_IN_CODE_MINUTES * 60,
          async sendVerificationOTP({ email, otp, type }) {
            if (type !== 'sign-in') return
            // Not awaited: the response would otherwise take longer for an address
            // that has an account than for one that does not.
            sendMail({ to: email, ...signInCodeMail(otp) })
              .catch(error => console.error('[auth] sign-in code email failed', error))
          }
        })]
      : []),
    ...(oidcEnabled
      ? [genericOAuth({
          config: [{
            providerId: 'oidc',
            discoveryUrl: process.env.OIDC_DISCOVERY_URL!,
            clientId: process.env.OIDC_CLIENT_ID!,
            clientSecret: process.env.OIDC_CLIENT_SECRET!,
            scopes: ['openid', 'email', 'profile'],
            pkce: true
          }]
        })]
      : [])
  ],
  hooks: {
    // An email code proves only access to the inbox. For an account that turned on
    // two-factor, letting it in on that alone would make the second factor optional.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email-otp') return
      const email = typeof ctx.body?.email === 'string' ? ctx.body.email.toLowerCase() : ''
      const found = email ? await ctx.context.internalAdapter.findUserByEmail(email) : null
      if ((found?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled) {
        throw new APIError('FORBIDDEN', {
          message: 'This account uses two-factor authentication. Sign in with your password or a passkey.'
        })
      }
    })
  },
  user: {
    // Read by the client to decide what to offer; never settable from it.
    additionalFields: {
      isInstanceAdmin: { type: 'boolean', required: false, defaultValue: false, input: false },
      canCreateOrganizations: { type: 'boolean', required: false, defaultValue: false, input: false }
    }
  },
  databaseHooks: {
    user: {
      update: {
        // A change of address meets the same rule as a sign-up, so a future change-email
        // feature cannot reach an .invalid address around the creation check above.
        async before(data) {
          if (data.email && isInvalidDomain(data.email)) {
            throw new APIError('BAD_REQUEST', { message: 'That address cannot be used.' })
          }
        }
      },
      create: {
        // Every way of creating an account ends here: password, email code,
        // OAuth, OIDC. The first account always gets in and runs the instance;
        // after that a closed instance admits only someone holding a live
        // customer invitation, carried in a cookie through the sign-up or the
        // OAuth round trip.
        async before(user, ctx) {
          // The reserved .invalid space is for crew accounts, which the crew provisioning
          // makes in-process (utils/crewAccounts.ts). No public route may make one.
          if (isInvalidDomain(user.email)) {
            throw new APIError('BAD_REQUEST', { message: 'That address cannot be used.' })
          }
          const first = await isFirstUser()
          if (!first && signUpDisabled && !(await isLiveInvitation(invitationTokenFrom(ctx?.headers ?? ctx?.request?.headers)))) {
            throw new APIError('FORBIDDEN', { message: 'Sign-up is closed here. Ask for an invitation link.' })
          }
          return {
            data: {
              ...user,
              // Signing up with an email code asks for no name, and an empty one
              // leaves the avatar and team member lists with nothing to show.
              name: user.name?.trim() || user.email.split('@')[0],
              ...(first && { isInstanceAdmin: true, canCreateOrganizations: true })
            }
          }
        },
        async after(user) {
          if ((user as { isInstanceAdmin?: boolean }).isInstanceAdmin) {
            await ensureOwnerOrganization(user.id, user.name)
          }
        }
      }
    }
  },
  emailAndPassword: {
    enabled: true
  },
  socialProviders: {
    ...(discordEnabled
      ? {
          discord: {
            clientId: process.env.DISCORD_CLIENT_ID!,
            clientSecret: process.env.DISCORD_CLIENT_SECRET!
          }
        }
      : {}),
    ...(githubEnabled
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID!,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!
          }
        }
      : {}),
    ...(googleEnabled
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!
          }
        }
      : {})
  },
  // More than one address can serve the app, such as a dev tunnel next to localhost.
  trustedOrigins: [baseURL, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean)]
})
