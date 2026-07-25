import crypto from 'node:crypto'

const COOKIE_NAME = 'cloudbase_ai_admin'
const SESSION_TTL_SECONDS = 8 * 60 * 60
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_ATTEMPTS = 5

export function registerAdminRoutes(app, {
  keyStore,
  credentialStore,
  password,
  sessionSecret,
  secureCookies = process.env.NODE_ENV === 'production'
}) {
  if (!password || password.length < 12) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters')
  }
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters')
  }

  const loginAttempts = new Map()

  app.post('/admin/login', async (req, res) => {
    enforceSameOrigin(req)
    const ip = req.ip || 'unknown'
    const attempt = loginAttempts.get(ip)

    if (attempt && attempt.resetAt > Date.now() && attempt.count >= LOGIN_ATTEMPTS) {
      res.status(429).json({ error: { code: 'login_rate_limited', message: 'Too many login attempts' } })
      return
    }

    if (!safeEqual(req.body?.password, password)) {
      const current = attempt?.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS }
      current.count += 1
      loginAttempts.set(ip, current)
      res.status(401).json({ error: { code: 'invalid_credentials', message: 'Invalid credentials' } })
      return
    }

    loginAttempts.delete(ip)
    res.setHeader('Set-Cookie', createSessionCookie(sessionSecret, secureCookies))
    res.json({ authenticated: true })
  })

  app.post('/admin/logout', requireAdmin(sessionSecret), (req, res) => {
    enforceSameOrigin(req)
    res.setHeader('Set-Cookie', clearSessionCookie(secureCookies))
    res.json({ authenticated: false })
  })

  app.get('/admin/session', requireAdmin(sessionSecret), (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ authenticated: true })
  })

  app.get('/admin/api/keys', requireAdmin(sessionSecret), asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ keys: await keyStore.list() })
  }))

  app.post('/admin/api/keys', requireAdmin(sessionSecret), asyncHandler(async (req, res) => {
    enforceSameOrigin(req)
    const result = await keyStore.create({ name: req.body?.name, secret: req.body?.secret })
    res.status(201).json(result)
  }))

  app.patch('/admin/api/keys/:id', requireAdmin(sessionSecret), asyncHandler(async (req, res) => {
    enforceSameOrigin(req)
    const result = await keyStore.update(req.params.id, {
      name: req.body?.name,
      enabled: req.body?.enabled,
      secret: req.body?.secret,
      rotate: req.body?.rotate === true
    })
    res.json(result)
  }))

  app.delete('/admin/api/keys/:id', requireAdmin(sessionSecret), asyncHandler(async (req, res) => {
    enforceSameOrigin(req)
    await keyStore.remove(req.params.id)
    res.status(204).end()
  }))

  if (credentialStore) {
    app.get('/admin/api/credentials', requireAdmin(sessionSecret), asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store')
      res.json({ credentials: await credentialStore.getPublic() })
    }))

    app.put('/admin/api/credentials', requireAdmin(sessionSecret), asyncHandler(async (req, res) => {
      enforceSameOrigin(req)
      const credentials = await credentialStore.save({
        envId: req.body?.envId,
        accessKey: req.body?.accessKey
      })
      res.json({ credentials })
    }))
  }

  app.use('/admin/api', (_req, res) => {
    res.status(404).json({ error: { code: 'route_not_found', message: 'Route not found' } })
  })
}

function requireAdmin(sessionSecret) {
  return (req, res, next) => {
    const token = parseCookies(req.get('cookie') || '')[COOKIE_NAME]
    if (!verifySessionToken(token, sessionSecret)) {
      res.status(401).json({ error: { code: 'admin_unauthorized', message: 'Authentication required' } })
      return
    }
    next()
  }
}

function createSessionCookie(sessionSecret, secure) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_SECONDS * 1000 })).toString('base64url')
  const signature = sign(payload, sessionSecret)
  return cookieValue(`${payload}.${signature}`, SESSION_TTL_SECONDS, secure)
}

function clearSessionCookie(secure) {
  return cookieValue('', 0, secure)
}

function cookieValue(value, maxAge, secure) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}

function verifySessionToken(token, sessionSecret) {
  if (typeof token !== 'string') return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature || !safeEqual(signature, sign(payload, sessionSecret))) return false

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number.isFinite(session.exp) && session.exp > Date.now()
  } catch {
    return false
  }
}

function sign(payload, sessionSecret) {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url')
}

function safeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((item) => {
    const index = item.indexOf('=')
    if (index < 0) return [item.trim(), '']
    return [item.slice(0, index).trim(), item.slice(index + 1)]
  }))
}

function enforceSameOrigin(req) {
  const origin = req.get('origin')
  if (!origin) return

  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    throw Object.assign(new Error('Invalid request origin'), { code: 'invalid_origin', status: 403 })
  }
  if (originHost !== req.get('host')) {
    throw Object.assign(new Error('Invalid request origin'), { code: 'invalid_origin', status: 403 })
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}
