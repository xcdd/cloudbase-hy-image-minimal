import test from 'node:test'
import assert from 'node:assert/strict'
import { createGenerateImage } from '../generateImage/index.js'

test('createGenerateImage sends the expected model payload', async () => {
  let capturedProvider = null
  let capturedInput = null

  const handler = createGenerateImage({
    createApp: () => ({
      ai() {
        return {
          createImageModel(provider) {
            capturedProvider = provider
            return {
              async generateImage(input) {
                capturedInput = input
                return {
                  data: [
                    {
                      url: 'https://example.com/generated.png',
                      revised_prompt: 'revised prompt'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    }),
    env: 'env-id'
  })

  const result = await handler({ prompt: 'cat in rain', size: '1280x720' })

  assert.equal(capturedProvider, 'hunyuan-image')
  assert.deepEqual(capturedInput, {
    model: 'HY-Image-3.0-Plus-4090-Tob-v1.0',
    prompt: 'cat in rain',
    size: '1280x720',
    revise: { value: true }
  })
  assert.deepEqual(result, {
    url: 'https://example.com/generated.png',
    revisedPrompt: 'revised prompt'
  })
})

test('createGenerateImage rejects missing prompt', async () => {
  const handler = createGenerateImage({
    createApp: () => ({
      ai() {
        throw new Error('should not reach ai')
      }
    }),
    env: 'env-id'
  })

  await assert.rejects(() => handler({}), /`prompt` is required/)
})
