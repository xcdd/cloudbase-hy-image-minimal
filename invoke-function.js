import cloudbase from '@cloudbase/node-sdk'

const prompt = process.argv[2]
const size = process.argv[3] || '1024x1024'
const env = process.env.ENV_ID
const accessKey = process.env.CLOUDBASE_APIKEY
const functionName = process.env.FUNCTION_NAME || 'generateImage'

if (!env) {
  throw new Error('Please set ENV_ID before invoking the function')
}

if (!accessKey) {
  throw new Error('Please set CLOUDBASE_APIKEY before invoking the function')
}

if (!prompt) {
  throw new Error('Usage: node invoke-function.js \"your prompt\" [size]')
}

const app = cloudbase.init({ env })
const response = await app.callFunction({
  name: functionName,
  data: { prompt, size }
})

console.log(JSON.stringify(response.result, null, 2))
