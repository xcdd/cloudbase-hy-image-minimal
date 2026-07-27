import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHttpService } from '../app.js'
import { createAiOperations, normalizeChatInput } from '../cloudbase-ai.js'
import { createMemoryCredentialStore } from '../credential-store.js'
import { createFileKeyStore, createMemoryKeyStore } from '../key-store.js'

const API_KEY = 'test-service-api-key'

test('thinking defaults on and recognizes common client disable formats', () => {
  const base = { model: 'hy3', messages: [{ role: 'user', content: 'hello' }] }
  assert.deepEqual(normalizeChatInput(base), {
    ...base,
    enable_thinking: true,
    reasoning_effort: 'high'
  })

  for (const option of [
    { enable_thinking: false, reasoning_effort: 'high' },
    { enable_thinking: { value: false } },
    { reasoning_effort: 'none' },
    { thinking: false },
    { thinking: { type: 'disabled' } },
    { reasoning: { effort: 'none' } }
  ]) {
    assert.deepEqual(normalizeChatInput({ ...base, ...option }), {
      ...base,
      enable_thinking: false
    })
  }
})

test('chat operations retry one opaque 429 but not explicit quota errors', async () => {
  const upstream = {
    id: 'chatcmpl-retried',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
  }
  let calls = 0
  const operations = createAiOperations({
    ai: createFakeAi({
      createModel() {
        return {
          async generateText() {
            calls += 1
            if (calls === 1) {
              throw Object.assign(new Error('Request failed with status code 429'), { code: '429' })
            }
            return { rawResponses: [upstream] }
          }
        }
      }
    }),
    retryDelayMs: 0
  })

  assert.deepEqual(await operations.generateChatCompletion({
    model: 'hy3',
    messages: [{ role: 'user', content: 'hello' }]
  }), upstream)
  assert.equal(calls, 2)

  let streamCalls = 0
  const streamResult = { dataStream: asyncIterable([]) }
  const streamOperations = createAiOperations({
    ai: createFakeAi({
      createModel() {
        return {
          async streamText() {
            streamCalls += 1
            if (streamCalls === 1) {
              throw Object.assign(new Error('Request failed with status code 429'), { code: '429' })
            }
            return streamResult
          }
        }
      }
    }),
    retryDelayMs: 0
  })

  assert.equal(await streamOperations.streamChatCompletion({
    model: 'hy3',
    messages: [{ role: 'user', content: 'hello' }]
  }), streamResult)
  assert.equal(streamCalls, 2)

  const quotaError = Object.assign(new Error('daily quota exhausted'), {
    code: 'EXCEED_RATE_LIMIT'
  })
  let quotaCalls = 0
  const quotaOperations = createAiOperations({
    ai: createFakeAi({
      createModel() {
        return {
          async generateText() {
            quotaCalls += 1
            throw quotaError
          }
        }
      }
    }),
    retryDelayMs: 0
  })

  await assert.rejects(() => quotaOperations.generateChatCompletion({
    model: 'hy3',
    messages: [{ role: 'user', content: 'hello' }]
  }), quotaError)
  assert.equal(quotaCalls, 1)
})

test('file key store preserves keys across service restarts without storing plaintext', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudbase-key-store-'))
  const filePath = path.join(directory, 'keys.json')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))

  const firstStore = createFileKeyStore({ filePath })
  assert.equal(await firstStore.initialize(API_KEY), true)
  const createdSecret = 'persisted-test-service-key-1234'
  const created = await firstStore.create({ name: 'Persistent key', secret: createdSecret })
  assert.equal(await firstStore.verify(API_KEY), true)
  assert.equal(await firstStore.verify(createdSecret), true)

  const restartedStore = createFileKeyStore({ filePath })
  assert.equal(await restartedStore.initialize('replacement-test-service-key-1234'), false)
  assert.equal(await restartedStore.verify(API_KEY), true)
  assert.equal(await restartedStore.verify(createdSecret), true)
  assert.equal((await restartedStore.list()).length, 2)

  const fileContent = await fs.readFile(filePath, 'utf8')
  assert.equal(fileContent.includes(API_KEY), false)
  assert.equal(fileContent.includes(createdSecret), false)
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600)

  await restartedStore.update(created.record.id, { enabled: false })
  const secondRestart = createFileKeyStore({ filePath })
  assert.equal(await secondRestart.verify(createdSecret), false)
})

test('chat completion preserves the upstream OpenAI response', async (t) => {
  let capturedProvider
  let capturedInput
  const upstream = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 123,
    model: 'hy3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
  const ai = createFakeAi({
    createModel(provider) {
      capturedProvider = provider
      return {
        async generateText(input) {
          capturedInput = input
          return { rawResponses: [upstream] }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))

  const response = await fetch(`${baseUrl}/v1/ai/cloudbase/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      max_tokens: 100,
      maxSteps: 99
    })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), upstream)
  assert.equal(capturedProvider, 'hunyuan-v3')
  assert.deepEqual(capturedInput, {
    model: 'hy3',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 100,
    enable_thinking: true,
    reasoning_effort: 'high',
    maxSteps: 1
  })
})

test('model endpoints list and retrieve the configured OpenAI-compatible models', async (t) => {
  const baseUrl = await listen(t, createHttpService({
    ai: createFakeAi(),
    serviceApiKey: API_KEY
  }))

  const listResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  })
  assert.equal(listResponse.status, 200)
  assert.deepEqual(await listResponse.json(), {
    object: 'list',
    data: [
      { id: 'hy3', object: 'model', created: 0, owned_by: 'cloudbase' },
      { id: 'hy3-preview', object: 'model', created: 0, owned_by: 'cloudbase' },
      { id: 'HY-Image-3.0-Plus-4090-Tob-v1.0', object: 'model', created: 0, owned_by: 'cloudbase' }
    ]
  })

  const modelResponse = await fetch(`${baseUrl}/v1/models/hy3-preview`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  })
  assert.equal(modelResponse.status, 200)
  assert.equal((await modelResponse.json()).id, 'hy3-preview')

  const missingResponse = await fetch(`${baseUrl}/v1/models/not-a-model`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  })
  assert.equal(missingResponse.status, 404)
  assert.equal((await missingResponse.json()).error.code, 'model_not_found')
})

test('chat completion preserves tool calls and normalizes legacy function options', async (t) => {
  let capturedInput
  const upstream = {
    id: 'chatcmpl-tool',
    object: 'chat.completion',
    model: 'hy3-preview',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'I need current weather data.',
        tool_calls: [{
          id: 'call-weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  }
  const ai = createFakeAi({
    createModel() {
      return {
        async generateText(input) {
          capturedInput = input
          return { rawResponses: [upstream] }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))
  const definition = {
    name: 'get_weather',
    description: 'Get current weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: 'hy3-preview',
      messages: [{ role: 'user', content: 'weather' }],
      functions: [definition],
      function_call: { name: 'get_weather' },
      topP: 0.8
    })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), upstream)
  assert.deepEqual(capturedInput, {
    model: 'hy3-preview',
    messages: [{ role: 'user', content: 'weather' }],
    top_p: 0.8,
    tools: [{ type: 'function', function: definition }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    enable_thinking: true,
    reasoning_effort: 'high',
    maxSteps: 1
  })
})

test('chat completion removes tools upstream when tool_choice is none', async (t) => {
  let capturedInput
  const upstream = {
    id: 'chatcmpl-tool-result',
    choices: [{ message: { role: 'assistant', content: '深圳当前多云。' }, finish_reason: 'stop' }]
  }
  const ai = createFakeAi({
    createModel() {
      return {
        async generateText(input) {
          capturedInput = input
          return { rawResponses: [upstream] }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))
  const messages = [
    { role: 'user', content: '查询深圳天气' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-search',
        type: 'function',
        function: { name: 'builtin_web_search', arguments: '{"query":"深圳天气"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call-search', content: '{"temperature":31}' }
  ]

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: 'hy3-preview',
      messages,
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'none'
    })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), upstream)
  assert.deepEqual(capturedInput.messages, messages)
  assert.equal(capturedInput.tools, undefined)
  assert.equal(capturedInput.tool_choice, undefined)
})

test('chat completion converts textual built-in tool markup to OpenAI tool_calls', async (t) => {
  let capturedInput
  const ai = createFakeAi({
    createModel() {
      return {
        async generateText(input) {
          capturedInput = input
          return {
            rawResponses: [{
              id: 'chatcmpl-text-tool',
              object: 'chat.completion',
              model: 'hy3',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: '我来帮您查询深圳的天气情况。<tool_calls><tool_call>builtin_web_search</tool_call></tool_calls>'
                },
                finish_reason: 'stop'
              }]
            }]
          }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: '查询深圳天气' }],
      tools: [{ type: 'web_search_preview' }]
    })
  })
  const result = await response.json()
  const message = result.choices[0].message

  assert.equal(response.status, 200)
  assert.equal(capturedInput.tools[0].type, 'function')
  assert.equal(capturedInput.tools[0].function.name, 'builtin_web_search')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(message.content, '我来帮您查询深圳的天气情况。')
  assert.equal(message.tool_calls[0].function.name, 'builtin_web_search')
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { query: '查询深圳天气' })
})

test('chat completion buffers textual tool markup in SSE and emits a structured call', async (t) => {
  const ai = createFakeAi({
    createModel() {
      return {
        async streamText() {
          return {
            dataStream: asyncIterable([
              { id: 'chatcmpl-text-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '我来查询。<tool_', reasoning_content: '需要搜索' }, finish_reason: null }] },
              { id: 'chatcmpl-text-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'calls><tool_call>builtin_web_search</tool_call></tool_calls>', reasoning_content: '实时天气。' }, finish_reason: 'stop' }] }
            ])
          }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: 'hy3-preview',
      messages: [{ role: 'user', content: '查询深圳天气' }],
      tools: [{
        type: 'builtin_function',
        name: 'builtin_web_search',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }],
      stream: true
    })
  })
  const events = (await response.text()).split('\n\n').filter((event) => event.startsWith('data: {'))
  const chunk = JSON.parse(events[0].slice(6))

  assert.equal(events.length, 1)
  assert.equal(chunk.choices[0].finish_reason, 'tool_calls')
  assert.equal(chunk.choices[0].delta.content, '我来查询。')
  assert.equal(chunk.choices[0].delta.reasoning_content, '需要搜索实时天气。')
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.name, 'builtin_web_search')
  assert.deepEqual(JSON.parse(chunk.choices[0].delta.tool_calls[0].function.arguments), { query: '查询深圳天气' })
})

test('chat completion streams reasoning and tool call chunks without rewriting them', async (t) => {
  const firstChunk = {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '', reasoning_content: '需要查询天气。' }, finish_reason: null }]
  }
  const secondChunk = {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        content: '',
        reasoning_content: '',
        tool_calls: [{
          index: 0,
          id: 'call-weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"上海"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  }
  const ai = createFakeAi({
    createModel() {
      return {
        async streamText() {
          return {
            dataStream: asyncIterable([
              { ...firstChunk, rawResponse: firstChunk },
              { ...secondChunk, rawResponse: secondChunk }
            ])
          }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: 'hy3-preview',
      messages: [{ role: 'user', content: '你好' }],
      stream: true
    })
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(
    await response.text(),
    `data: ${JSON.stringify(firstChunk)}\n\ndata: ${JSON.stringify(secondChunk)}\n\ndata: [DONE]\n\n`
  )
})

test('service rejects missing credentials and disallowed models', async (t) => {
  const ai = createFakeAi()
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))

  const unauthorized = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hello' }] })
  })
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).error.code, 'invalid_api_key')

  const disallowed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({ model: 'other-model', messages: [{ role: 'user', content: 'hello' }] })
  })
  assert.equal(disallowed.status, 400)
  assert.equal((await disallowed.json()).error.code, 'model_not_allowed')
})

test('service returns OpenAI errors for invalid JSON and upstream limits', async (t) => {
  const upstreamError = Object.assign(new Error('too many concurrent requests'), {
    code: 'EXCEED_CONCURRENT_REQUEST_LIMIT',
    requestId: 'request-test'
  })
  const ai = createFakeAi({
    createModel() {
      return {
        async generateText() {
          throw upstreamError
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))

  const invalidJson = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: '{'
  })
  assert.equal(invalidJson.status, 400)
  assert.equal((await invalidJson.json()).error.code, 'invalid_json')

  const limited = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hello' }] })
  })
  assert.equal(limited.status, 429)
  assert.deepEqual(await limited.json(), {
    error: {
      message: 'too many concurrent requests',
      type: 'cloudbase_error',
      code: 'EXCEED_CONCURRENT_REQUEST_LIMIT',
      request_id: 'request-test'
    }
  })
})

test('service preserves numeric HTTP status codes returned by CloudBase', async (t) => {
  const upstreamError = Object.assign(new Error('Request failed with status code 429'), {
    code: '429',
    requestId: 'request-rate-limit'
  })
  const ai = createFakeAi({
    createModel() {
      return {
        async generateText() {
          throw upstreamError
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hello' }] })
  })

  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'Request failed with status code 429',
      type: 'cloudbase_error',
      code: '429',
      request_id: 'request-rate-limit'
    }
  })
})

test('image generation is served by the same application', async (t) => {
  let capturedInput
  const upstream = {
    id: 'image-test',
    created: 123,
    data: [{ url: 'https://example.com/image.png' }]
  }
  const ai = createFakeAi({
    createImageModel() {
      return {
        async generateImage(input) {
          capturedInput = input
          return upstream
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({ ai, serviceApiKey: API_KEY }))

  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: authorizedHeaders(),
    body: JSON.stringify({ prompt: 'a cat', size: '1280x720' })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), upstream)
  assert.deepEqual(capturedInput, {
    prompt: 'a cat',
    size: '1280x720',
    model: 'HY-Image-3.0-Plus-4090-Tob-v1.0',
    revise: { value: true },
    footnote: ' '
  })
})

test('admin creates, rotates, and removes API keys in the same application', async (t) => {
  const keyStore = createMemoryKeyStore(API_KEY)
  const ai = createFakeAi({
    createModel() {
      return {
        async generateText() {
          return {
            rawResponses: [{
              id: 'chatcmpl-admin',
              choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
            }]
          }
        }
      }
    }
  })
  const baseUrl = await listen(t, createHttpService({
    ai,
    keyStore,
    admin: {
      password: 'admin-password-123',
      sessionSecret: 'admin-session-secret-that-is-long-enough'
    }
  }))

  const page = await fetch(baseUrl)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /CloudBase AI Control/)

  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin-password-123' })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]

  const created = await adminRequest(`${baseUrl}/admin/api/keys`, cookie, {
    method: 'POST',
    body: { name: 'Desktop client' }
  })
  assert.equal(created.response.status, 201)
  assert.match(created.result.secret, /^cbsk_/)

  const apiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authorizedHeaders(created.result.secret),
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hello' }] })
  })
  assert.equal(apiResponse.status, 200)

  const rotated = await adminRequest(`${baseUrl}/admin/api/keys/${created.result.record.id}`, cookie, {
    method: 'PATCH',
    body: { name: 'Desktop client v2', enabled: true, rotate: true }
  })
  assert.equal(rotated.response.status, 200)
  assert.notEqual(rotated.result.secret, created.result.secret)
  assert.equal(await keyStore.verify(created.result.secret), false)
  assert.equal(await keyStore.verify(rotated.result.secret), true)

  const removed = await adminRequest(`${baseUrl}/admin/api/keys/${created.result.record.id}`, cookie, {
    method: 'DELETE'
  })
  assert.equal(removed.response.status, 204)
  assert.equal(await keyStore.verify(rotated.result.secret), false)
})

test('admin saves CloudBase credentials and only returns a masked access key', async (t) => {
  const credentialStore = createMemoryCredentialStore()
  const baseUrl = await listen(t, createHttpService({
    ai: createFakeAi(),
    serviceApiKey: API_KEY,
    credentialStore,
    admin: {
      password: 'admin-password-123',
      sessionSecret: 'admin-session-secret-that-is-long-enough'
    }
  }))

  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin-password-123' })
  })
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]
  const accessKey = 'test-cloudbase-access-key-1234567890'

  const saved = await adminRequest(`${baseUrl}/admin/api/credentials`, cookie, {
    method: 'PUT',
    body: { envId: 'cloud1-test', accessKey }
  })

  assert.equal(saved.response.status, 200)
  assert.equal(saved.result.credentials.configured, true)
  assert.equal(saved.result.credentials.envId, 'cloud1-test')
  assert.equal(saved.result.credentials.accessKeyMasked, 'test-clo****7890')
  assert.equal(JSON.stringify(saved.result).includes(accessKey), false)
  assert.deepEqual(await credentialStore.get(), {
    envId: 'cloud1-test',
    accessKey,
    updatedAt: (await credentialStore.get()).updatedAt,
    source: 'saved'
  })

  const fetched = await adminRequest(`${baseUrl}/admin/api/credentials`, cookie)
  assert.equal(fetched.result.credentials.accessKeyMasked, 'test-clo****7890')
})

function createFakeAi(overrides = {}) {
  return {
    createModel: overrides.createModel || (() => {
      throw new Error('chat model should not be called')
    }),
    createImageModel: overrides.createImageModel || (() => {
      throw new Error('image model should not be called')
    })
  }
}

function asyncIterable(values) {
  return {
    async *[Symbol.asyncIterator]() {
      yield * values
    }
  }
}

function authorizedHeaders(apiKey = API_KEY) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
}

async function adminRequest(url, cookie, { method, body } = {}) {
  const headers = { Cookie: cookie }
  const init = { method: method || 'GET', headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(url, init)
  const result = response.status === 204 ? null : await response.json()
  return { response, result }
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}
