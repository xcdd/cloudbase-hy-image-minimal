import cloudbase from '@cloudbase/node-sdk'
import { resolveGenerateOptions } from './direct-generate-lib.js'

const { prompt, size, footnote } = resolveGenerateOptions({
  argv: process.argv.slice(2),
  env: process.env
})
const env = process.env.ENV_ID
const accessKey = process.env.CLOUDBASE_APIKEY

if (!env) {
  throw new Error('Please set ENV_ID before generating images')
}

if (!accessKey) {
  throw new Error('Please set CLOUDBASE_APIKEY before generating images')
}

if (!prompt) {
  throw new Error('Usage: node direct-generate.js "your prompt" [size] [footnote]\n   or: node direct-generate.js --prompt-file <file> [size] [footnote]')
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
