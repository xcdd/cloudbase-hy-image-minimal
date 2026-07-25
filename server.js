import crypto from 'node:crypto'
import cloudbase from '@cloudbase/node-sdk'

import { createHttpService } from './app.js'
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_IMAGE_MODEL
} from './cloudbase-ai.js'
import { createCredentialStore } from './credential-store.js'
import { createCloudBaseKeyStore, createFileKeyStore } from './key-store.js'

const env = process.env.ENV_ID || process.env.TCB_ENV_ID
const accessKey = process.env.CLOUDBASE_APIKEY
const generatedServiceApiKey = `cbsk_${crypto.randomBytes(24).toString('base64url')}`
const generatedAdminPassword = `admin-${crypto.randomBytes(9).toString('base64url')}`
const serviceApiKey = process.env.SERVICE_API_KEY || generatedServiceApiKey
const adminPassword = process.env.ADMIN_PASSWORD || generatedAdminPassword
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('base64url')
const port = parsePositiveInteger(process.env.PORT, 8080)
const timeout = parsePositiveInteger(process.env.AI_TIMEOUT_MS, 120000)
const credentialStore = createCredentialStore({
  filePath: process.env.CREDENTIAL_FILE,
  initialEnvId: env,
  initialAccessKey: accessKey
})
const initialCredentials = await credentialStore.get()

const ai = createCredentialAwareAi({ credentialStore, timeout, initialCredentials })
const { keyStore, bootstrapCreated, keyStoreType } = await createServiceKeyStore({
  credentials: initialCredentials,
  serviceApiKey,
  timeout
})

const app = createHttpService({
  ai,
  keyStore,
  credentialStore,
  admin: {
    password: adminPassword,
    sessionSecret: adminSessionSecret
  },
  chatProvider: process.env.AI_PROVIDER || DEFAULT_CHAT_PROVIDER,
  allowedChatModels: parseList(process.env.CHAT_MODELS, DEFAULT_CHAT_MODELS),
  allowedImageModels: parseList(process.env.IMAGE_MODELS, [DEFAULT_IMAGE_MODEL]),
  bodyLimit: process.env.BODY_LIMIT || '1mb'
})

app.listen(port, '0.0.0.0', () => {
  console.log(`CloudBase AI service listening on port ${port}`)
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Generated local admin password: ${adminPassword}`)
  }
  if (!process.env.SERVICE_API_KEY && bootstrapCreated) {
    console.log(`Generated local service API key: ${serviceApiKey}`)
  } else if (!process.env.SERVICE_API_KEY) {
    console.log(`Using persisted local service API keys from ${process.env.KEY_FILE || '.service-keys.json'}`)
  }
  console.log(`Service API key store: ${keyStoreType}`)
  if (!initialCredentials.envId || !initialCredentials.accessKey) {
    console.log('CloudBase credentials are not configured; save them in the web console before calling AI endpoints')
  }
})

function createCredentialAwareAi({ credentialStore, timeout, initialCredentials }) {
  let signature = credentialsSignature(initialCredentials)
  let currentAi = signature ? initializeAi(initialCredentials) : undefined

  function initializeAi(credentials) {
    return cloudbase.init({
      env: credentials.envId,
      accessKey: credentials.accessKey,
      timeout
    }).ai()
  }

  const resolveAi = async () => {
    const credentials = await credentialStore.get()
    if (!credentials.envId || !credentials.accessKey) {
      throw Object.assign(new Error('请先在管理后台保存 CloudBase 凭据'), {
        code: 'upstream_credentials_missing'
      })
    }

    const nextSignature = `${credentials.envId}\0${credentials.accessKey}`
    if (nextSignature !== signature) {
      currentAi = initializeAi(credentials)
      signature = nextSignature
    }
    return currentAi
  }

  return {
    createModel(provider) {
      let modelAi
      let model
      const resolveModel = async () => {
        const ai = await resolveAi()
        if (ai !== modelAi) {
          model = ai.createModel(provider)
          modelAi = ai
        }
        return model
      }
      return {
        async generateText(input) {
          return (await resolveModel()).generateText(input)
        },
        async streamText(input) {
          return (await resolveModel()).streamText(input)
        }
      }
    },
    createImageModel(provider) {
      let modelAi
      let model
      const resolveModel = async () => {
        const ai = await resolveAi()
        if (ai !== modelAi) {
          model = ai.createImageModel(provider)
          modelAi = ai
        }
        return model
      }
      return {
        async generateImage(input) {
          return (await resolveModel()).generateImage(input)
        }
      }
    }
  }
}

function credentialsSignature(credentials) {
  return credentials?.envId && credentials?.accessKey
    ? `${credentials.envId}\0${credentials.accessKey}`
    : undefined
}

async function createServiceKeyStore({ credentials, serviceApiKey, timeout }) {
  const preferCloudBase = process.env.KEY_STORE === 'cloudbase' ||
    (process.env.NODE_ENV === 'production' && process.env.KEY_STORE !== 'file')

  if (preferCloudBase && credentials.envId && credentials.accessKey && process.env.SERVICE_API_KEY) {
    try {
      const cloudbaseApp = cloudbase.init({
        env: credentials.envId,
        accessKey: credentials.accessKey,
        timeout
      })
      const keyStore = createCloudBaseKeyStore({
        db: cloudbaseApp.database(),
        collectionName: process.env.KEY_COLLECTION || 'ai_service_keys',
        cacheTtlMs: parsePositiveInteger(process.env.KEY_CACHE_TTL_MS, 10000)
      })
      await keyStore.initialize(serviceApiKey)
      return { keyStore, bootstrapCreated: false, keyStoreType: 'cloudbase' }
    } catch (error) {
      console.warn(`CloudBase key store unavailable, using local file: ${error.message}`)
    }
  }

  const keyStore = createFileKeyStore({ filePath: process.env.KEY_FILE })
  const bootstrapCreated = await keyStore.initialize(serviceApiKey)
  return { keyStore, bootstrapCreated, keyStoreType: 'file' }
}

function parseList(value, fallback) {
  if (!value) {
    return fallback
  }

  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
