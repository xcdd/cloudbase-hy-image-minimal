import cloudbase from '@cloudbase/node-sdk'

const prompt = process.argv[2]
const size = process.argv[3] || '1024x1024'
const footnote = process.argv[4] ?? process.env.FOOTNOTE ?? ' '
const env = process.env.ENV_ID
const accessKey = process.env.CLOUDBASE_APIKEY

if (!env) {
  throw new Error('Please set ENV_ID before generating images')
}

if (!accessKey) {
  throw new Error('Please set CLOUDBASE_APIKEY before generating images')
}

if (!prompt) {
  throw new Error('Usage: node direct-generate.js "your prompt" [size]')
}

const app = cloudbase.init({ env })
const ai = app.ai()
const imageModel = ai.createImageModel('hunyuan-image')

const result = await imageModel.generateImage({
  model: 'HY-Image-3.0-Plus-4090-Tob-v1.0',
  prompt,
  size,
  revise: { value: true },
  ...(footnote !== undefined ? { footnote } : {})
})

console.log(JSON.stringify(result, null, 2))
