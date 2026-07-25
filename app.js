import { fileURLToPath } from 'node:url'
import express from 'express'

import { registerAdminRoutes } from './admin.js'
import {
  createAiOperations,
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_IMAGE_MODEL,
  getRawStreamChunk,
  normalizeBufferedChatChunks,
  shouldBufferToolStream
} from './cloudbase-ai.js'
import { createMemoryKeyStore } from './key-store.js'

const DEFAULT_BODY_LIMIT = '1mb'
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url))
const lucideScript = fileURLToPath(new URL('./node_modules/lucide/dist/umd/lucide.min.js', import.meta.url))

export function createHttpService({
  ai,
  serviceApiKey,
  keyStore = createMemoryKeyStore(serviceApiKey),
  credentialStore,
  admin,
  chatProvider = DEFAULT_CHAT_PROVIDER,
  allowedChatModels = DEFAULT_CHAT_MODELS,
  allowedImageModels = [DEFAULT_IMAGE_MODEL],
  bodyLimit = DEFAULT_BODY_LIMIT
}) {
  if (!keyStore) {
    throw new Error('`keyStore` is required')
  }

  const operations = createAiOperations({ ai, chatProvider })
  const chatModels = new Set(allowedChatModels)
  const imageModels = new Set(allowedImageModels)
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: bodyLimit }))

  app.get('/vendor/lucide.js', (_req, res) => {
    res.sendFile(lucideScript)
  })
  app.use('/assets', express.static(publicDirectory, { index: false, maxAge: 0 }))
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile(`${publicDirectory}/index.html`)
  })

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  if (admin) {
    registerAdminRoutes(app, { keyStore, credentialStore, ...admin })
  }

  app.use('/v1', authenticate(keyStore))

  const models = createModelRecords([...chatModels, ...new Set(allowedImageModels)])

  app.get('/v1/models', (_req, res) => {
    res.json({ object: 'list', data: models })
  })

  app.get('/v1/models/:model', (req, res, next) => {
    const model = models.find((item) => item.id === req.params.model)
    if (!model) {
      next(new HttpError(404, 'model_not_found', 'The requested model does not exist'))
      return
    }
    res.json(model)
  })

  const chatHandler = asyncHandler(async (req, res) => {
    validateChatRequest(req.body, chatModels)

    if (req.body.stream === true) {
      await streamChatResponse({ operations, input: req.body, res })
      return
    }

    const result = await operations.generateChatCompletion(req.body)
    res.json(result)
  })

  app.post('/v1/chat/completions', chatHandler)
  app.post('/v1/ai/cloudbase/chat/completions', chatHandler)

  app.post('/v1/images/generations', asyncHandler(async (req, res) => {
    validateImageRequest(req.body, imageModels)

    const result = await operations.generateImage({
      ...req.body,
      model: req.body.model || DEFAULT_IMAGE_MODEL,
      size: req.body.size || '1024x1024',
      revise: req.body.revise ?? { value: true },
      footnote: req.body.footnote ?? ' '
    })

    res.json(result)
  }))

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'route_not_found', 'Route not found'))
  })

  app.use((error, _req, res, next) => {
    if (res.headersSent) {
      next(error)
      return
    }

    const { status, body } = formatError(error)
    res.status(status).json(body)
  })

  return app
}

function createModelRecords(modelIds) {
  return [...new Set(modelIds)].map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'cloudbase'
  }))
}

function authenticate(keyStore) {
  return asyncHandler(async (req, _res, next) => {
    const authorization = req.get('authorization') || ''
    const match = authorization.match(/^Bearer\s+(.+)$/i)

    if (!match || !await keyStore.verify(match[1])) {
      next(new HttpError(401, 'invalid_api_key', 'Invalid API key'))
      return
    }

    next()
  })
}

function validateChatRequest(body, allowedModels) {
  if (!isObject(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object')
  }

  if (typeof body.model !== 'string' || !allowedModels.has(body.model)) {
    throw new HttpError(400, 'model_not_allowed', 'The requested chat model is not allowed')
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, 'invalid_messages', '`messages` must be a non-empty array')
  }

  const invalidMessage = body.messages.some((message) => {
    return !isObject(message) || typeof message.role !== 'string' ||
      (!Object.hasOwn(message, 'content') && !Object.hasOwn(message, 'tool_calls'))
  })

  if (invalidMessage) {
    throw new HttpError(400, 'invalid_messages', 'Each message must contain a role and content or tool_calls')
  }
}

function validateImageRequest(body, allowedModels) {
  if (!isObject(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object')
  }

  const model = body.model || DEFAULT_IMAGE_MODEL
  if (typeof model !== 'string' || !allowedModels.has(model)) {
    throw new HttpError(400, 'model_not_allowed', 'The requested image model is not allowed')
  }

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new HttpError(400, 'invalid_prompt', '`prompt` must be a non-empty string')
  }
}

async function streamChatResponse({ operations, input, res }) {
  let disconnected = false
  res.on('close', () => {
    disconnected = !res.writableEnded
  })

  try {
    const result = await operations.streamChatCompletion(input)

    res.status(200)
    res.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders()

    const bufferedChunks = shouldBufferToolStream(input) ? [] : null

    for await (const chunk of result.dataStream) {
      if (disconnected) {
        break
      }

      const rawChunk = getRawStreamChunk(chunk)
      if (bufferedChunks) {
        bufferedChunks.push(rawChunk)
      } else {
        res.write(`data: ${JSON.stringify(rawChunk)}\n\n`)
      }
    }

    if (bufferedChunks && !disconnected) {
      for (const chunk of normalizeBufferedChatChunks(bufferedChunks, input)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    }

    if (!disconnected && !res.writableEnded) {
      res.end('data: [DONE]\n\n')
    }
  } catch (error) {
    if (!res.headersSent) {
      throw error
    }

    if (!disconnected && !res.writableEnded) {
      const { body } = formatError(error)
      res.write(`data: ${JSON.stringify(body)}\n\n`)
      res.end('data: [DONE]\n\n')
    }
  }
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

function formatError(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: openAiError(error.message, error.code)
    }
  }

  if (error?.type === 'entity.parse.failed') {
    return {
      status: 400,
      body: openAiError('Request body must contain valid JSON', 'invalid_json')
    }
  }

  if (error?.type === 'entity.too.large') {
    return {
      status: 413,
      body: openAiError('Request body is too large', 'request_too_large')
    }
  }

  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    return {
      status: error.status,
      body: openAiError(error.message, error.code || 'invalid_request')
    }
  }

  const code = typeof error?.code === 'string' ? error.code : 'upstream_error'
  const numericStatus = /^[45]\d{2}$/.test(code) ? Number(code) : undefined
  const status = numericStatus || (code.includes('CONCURRENT') || code.includes('RATE_LIMIT') ? 429 : 502)
  const message = error instanceof Error ? error.message : 'CloudBase AI request failed'

  return {
    status,
    body: openAiError(message, code, error?.requestId)
  }
}

function openAiError(message, code, requestId) {
  return {
    error: {
      message,
      type: 'cloudbase_error',
      code,
      ...(requestId ? { request_id: requestId } : {})
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}
