import { Redis } from '@upstash/redis'

export const runtime = 'nodejs'

/**
 * Zápis e-mailu do Redis listu "waitlist". Best-effort ako celá cache vrstva:
 * ak Redis nie je, vrátime 200 a nič neuložíme — používateľ nemá vidieť chybu
 * za niečo, čo si neobjednal.
 */
export async function POST(req: Request) {
  let email = ''
  try {
    const body = (await req.json()) as { email?: unknown }
    email = String(body.email ?? '').trim().toLowerCase()
  } catch {
    return Response.json({ ok: false }, { status: 400 })
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 254) {
    return Response.json({ ok: false }, { status: 400 })
  }

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return Response.json({ ok: true })

  try {
    const redis = new Redis({ url, token })
    await redis.rpush('waitlist', JSON.stringify({ email, ts: Date.now() }))
  } catch {
    // ticho — e-mail sa nestratí natoľko, aby to stálo za chybovú hlášku
  }
  return Response.json({ ok: true })
}
