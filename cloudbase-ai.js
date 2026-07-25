import crypto from 'node:crypto'

export const DEFAULT_CHAT_PROVIDER = 'hunyuan-v3'
export const DEFAULT_CHAT_MODELS = ['hy3', 'hy3-preview']
export const DEFAULT_IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0'

export function createAiOperations({
  ai,
  chatProvider = DEFAULT_CHAT_PROVIDER
}) {
  if (!ai) {
    throw new Error('`ai` is required')
  }

  let chatModel
  let imageModel

  const getChatModel = () => {
    chatModel ??= ai.createModel(chatProvider)
    return chatModel
  }

  const getImageModel = () => {
    imageModel ??= ai.createImageModel('hunyuan-image')
    return imageModel
  }

  return {
    async generateChatCompletion(input) {
      const result = await getChatModel().generateText({
        ...normalizeChatInput(input),
        // Tool execution belongs to the OpenAI client. One step returns the
        // model's tool_calls instead of asking the SDK to execute unknown tools.
        maxSteps: 1
      })
      const rawResponse = result.rawResponses?.at(-1)

      if (!rawResponse) {
        throw new Error('Chat generation succeeded but no raw response was returned')
      }

      return normalizeChatResponse(rawResponse, input)
    },

    async streamChatCompletion(input) {
      return getChatModel().streamText({
        ...normalizeChatInput(input),
        maxSteps: 1
      })
    },

    generateImage(input) {
      return getImageModel().generateImage(input)
    }
  }
}

export function normalizeChatInput(input) {
  const {
    stream: _stream,
    maxSteps: _maxSteps,
    onStepFinish: _onStepFinish,
    abortSignal: _abortSignal,
    topP,
    toolChoice,
    functions,
    function_call: functionCall,
    ...modelInput
  } = input

  if (modelInput.top_p === undefined && topP !== undefined) {
    modelInput.top_p = topP
  }
  if (modelInput.tool_choice === undefined && toolChoice !== undefined) {
    modelInput.tool_choice = toolChoice
  }
  if (modelInput.tools === undefined && Array.isArray(functions)) {
    modelInput.tools = functions.map((definition) => ({
      type: 'function',
      function: definition
    }))
  }
  if (Array.isArray(modelInput.tools)) {
    modelInput.tools = modelInput.tools.map(normalizeToolDefinition)
  }
  if (modelInput.tool_choice === undefined && functionCall !== undefined) {
    modelInput.tool_choice = normalizeLegacyFunctionCall(functionCall)
  }
  if (modelInput.tool_choice === 'none') {
    // hy3 rejects tool_choice=none when tools are present. Removing both has
    // the same OpenAI semantics: no tool is available for this model turn.
    delete modelInput.tool_choice
    delete modelInput.tools
  }
  normalizeThinkingOptions(modelInput)
  if (modelInput.enable_thinking === undefined && DEFAULT_CHAT_MODELS.includes(modelInput.model)) {
    modelInput.enable_thinking = true
  }
  if (modelInput.enable_thinking !== false && modelInput.reasoning_effort === undefined &&
      DEFAULT_CHAT_MODELS.includes(modelInput.model)) {
    modelInput.reasoning_effort = 'high'
  }

  return modelInput
}

function normalizeThinkingOptions(modelInput) {
  const thinking = modelInput.thinking
  const reasoning = modelInput.reasoning
  const enableThinking = modelInput.enable_thinking
  const reasoningEffort = modelInput.reasoning_effort
  const disabledValues = new Set(['none', 'off', 'disabled'])
  const isDisabledValue = (value) => typeof value === 'string' && disabledValues.has(value.toLowerCase())
  const disabled = enableThinking === false || enableThinking?.value === false ||
    reasoningEffort === false || isDisabledValue(reasoningEffort) ||
    thinking === false || thinking?.enabled === false || thinking?.type === 'disabled' ||
    reasoning === false || isDisabledValue(reasoning?.effort)

  delete modelInput.thinking
  delete modelInput.reasoning

  if (disabled) {
    modelInput.enable_thinking = false
    delete modelInput.reasoning_effort
    return
  }

  if (typeof enableThinking?.value === 'boolean') {
    modelInput.enable_thinking = enableThinking.value
  } else if (thinking === true || thinking?.enabled === true || thinking?.type === 'enabled') {
    modelInput.enable_thinking = true
  }

  const aliasEffort = reasoning?.effort
  if (modelInput.reasoning_effort === undefined && ['low', 'medium', 'high'].includes(aliasEffort)) {
    modelInput.reasoning_effort = aliasEffort
  }
}

export function shouldBufferToolStream(input) {
  return Array.isArray(input?.tools) || Array.isArray(input?.functions) || input?.messages?.some((message) => {
    return typeof message?.content === 'string' && /<tool_call|builtin_[a-z0-9_]+/i.test(message.content)
  })
}

export function normalizeBufferedChatChunks(chunks, input) {
  if (chunks.some(hasStructuredToolCall)) return chunks

  const content = chunks.map((chunk) => chunk?.choices?.[0]?.delta?.content || '').join('')
  const reasoningContent = chunks.map((chunk) => chunk?.choices?.[0]?.delta?.reasoning_content || '').join('')
  const parsed = parseTextToolCalls(content, input)
  if (!parsed) return chunks

  const template = chunks.find((chunk) => chunk?.choices?.length > 0) || {}
  const usageChunks = chunks.filter((chunk) => chunk?.choices?.length === 0 && chunk?.usage)
  return [{
    ...template,
    choices: [{
      index: template.choices?.[0]?.index || 0,
      delta: {
        role: 'assistant',
        content: parsed.content,
        reasoning_content: reasoningContent,
        tool_calls: parsed.toolCalls.map((toolCall, index) => ({ index, ...toolCall }))
      },
      finish_reason: 'tool_calls'
    }]
  }, ...usageChunks]
}

function normalizeChatResponse(response, input) {
  if (!Array.isArray(response?.choices)) return response

  return {
    ...response,
    choices: response.choices.map((choice) => {
      if (choice?.message?.tool_calls?.length || typeof choice?.message?.content !== 'string') return choice
      const parsed = parseTextToolCalls(choice.message.content, input)
      if (!parsed) return choice
      return {
        ...choice,
        message: {
          ...choice.message,
          content: parsed.content,
          tool_calls: parsed.toolCalls
        },
        finish_reason: 'tool_calls'
      }
    })
  }
}

function normalizeToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') return tool
  if (tool.type === 'function' && tool.function) return tool
  if (tool.function && typeof tool.function === 'object') {
    return { ...tool, type: 'function' }
  }

  const builtinName = ['web_search', 'web_search_preview', 'builtin_web_search'].includes(tool.type)
    ? 'builtin_web_search'
    : undefined
  const name = tool.name || builtinName
  if (!name) return tool

  return {
    type: 'function',
    function: {
      name,
      description: tool.description || (name === 'builtin_web_search' ? 'Search the web' : ''),
      parameters: tool.parameters || tool.input_schema || {
        type: 'object',
        properties: name === 'builtin_web_search' ? { query: { type: 'string' } } : {},
        ...(name === 'builtin_web_search' ? { required: ['query'] } : {})
      }
    }
  }
}

function parseTextToolCalls(content, input) {
  const matches = [...content.matchAll(/<tool_call(?:\s[^>]*)?>([\s\S]*?)<\/tool_call>/gi)]
  if (matches.length === 0) return null

  const definitions = normalizeChatInput(input).tools || []
  const latestUserContent = [...(input.messages || [])].reverse()
    .find((message) => message?.role === 'user' && typeof message.content === 'string')?.content || ''
  const toolCalls = matches.map((match) => parseTextToolCall(match[1], definitions, latestUserContent)).filter(Boolean)
  if (toolCalls.length === 0) return null

  return {
    content: stripTextToolCallMarkup(content),
    toolCalls
  }
}

function stripTextToolCallMarkup(content) {
  return content
    .replace(/<tool_calls(?:\s[^>]*)?>[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<tool_call(?:\s[^>]*)?>[\s\S]*?<\/tool_call>/gi, '')
    .trim()
}

function parseTextToolCall(value, definitions, latestUserContent) {
  const text = value.trim()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }

  const name = typeof parsed === 'string'
    ? parsed
    : parsed?.name || parsed?.function?.name || text.match(/^[a-zA-Z_][a-zA-Z0-9_.-]*/)?.[0]
  if (!name) return null

  const definition = definitions.find((tool) => tool?.function?.name === name)?.function
  if (definitions.length > 0 && !definition) return null
  if (definitions.length === 0 && !name.startsWith('builtin_')) return null
  let args = parsed?.arguments ?? parsed?.function?.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = undefined }
  }
  if (!args || typeof args !== 'object') {
    args = inferToolArguments(name, definition, latestUserContent)
  }

  return {
    id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  }
}

function inferToolArguments(name, definition, latestUserContent) {
  const required = definition?.parameters?.required
  const properties = definition?.parameters?.properties
  if (Array.isArray(required) && required.length === 1 && properties?.[required[0]]?.type === 'string') {
    return { [required[0]]: latestUserContent }
  }
  if (name === 'builtin_web_search') return { query: latestUserContent }
  return {}
}

function hasStructuredToolCall(chunk) {
  return chunk?.choices?.some((choice) => Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0)
}

function normalizeLegacyFunctionCall(functionCall) {
  if (functionCall === 'none' || functionCall === 'auto') {
    return functionCall
  }
  if (functionCall && typeof functionCall === 'object' && typeof functionCall.name === 'string') {
    return {
      type: 'function',
      function: { name: functionCall.name }
    }
  }
  return functionCall
}

export function getRawStreamChunk(chunk) {
  if (chunk && typeof chunk === 'object' && chunk.rawResponse) {
    return chunk.rawResponse
  }

  if (chunk && typeof chunk === 'object') {
    const { rawResponse: _rawResponse, ...standardChunk } = chunk
    return standardChunk
  }

  return chunk
}
