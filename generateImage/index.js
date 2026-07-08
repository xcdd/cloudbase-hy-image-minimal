export function createGenerateImage({
  createApp = async ({ env }) => {
    const { default: cloudbase } = await import('@cloudbase/node-sdk')
    return cloudbase.init({ env })
  },
  env = process.env.ENV_ID
} = {}) {
  return async function generateImage(event = {}) {
    const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
    if (!prompt) {
      throw new Error('`prompt` is required')
    }

    if (!env) {
      throw new Error('`ENV_ID` is required')
    }

    const size = typeof event.size === 'string' && event.size ? event.size : '1024x1024'
    const app = await createApp({ env })
    const ai = app.ai()
    const imageModel = ai.createImageModel('hunyuan-image')

    const res = await imageModel.generateImage({
      model: 'HY-Image-3.0-Plus-4090-Tob-v1.0',
      prompt,
      size,
      revise: { value: true }
    })

    const first = res?.data?.[0]
    if (!first?.url) {
      throw new Error('Image generation succeeded but no URL was returned')
    }

    return {
      url: first.url,
      revisedPrompt: first.revised_prompt ?? null
    }
  }
}

export const main = createGenerateImage()
