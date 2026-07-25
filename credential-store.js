import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_FILE = '.cloudbase-credentials.json'

export function createCredentialStore({
  filePath = path.resolve(DEFAULT_FILE),
  initialEnvId = '',
  initialAccessKey = ''
} = {}) {
  let loaded = false
  let state
  let writeQueue = Promise.resolve()

  const load = async () => {
    if (loaded) return

    try {
      const content = await fs.readFile(filePath, 'utf8')
      const stored = JSON.parse(content)
      state = normalizeCredentials(stored)
      state.updatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : null
      state.source = 'saved'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      state = {
        ...normalizeCredentials({ envId: initialEnvId, accessKey: initialAccessKey }, false),
        updatedAt: null,
        source: initialEnvId || initialAccessKey ? 'environment' : 'unset'
      }
    }

    loaded = true
  }

  return {
    async get() {
      await load()
      return { ...state }
    },

    async getPublic() {
      await load()
      return toPublicCredentials(state)
    },

    async save(input) {
      await load()
      const accessKey = typeof input.accessKey === 'string' && input.accessKey.length > 0
        ? input.accessKey
        : state.accessKey
      const next = {
        ...normalizeCredentials({ envId: input.envId, accessKey }),
        updatedAt: new Date().toISOString(),
        source: 'saved'
      }

      writeQueue = writeQueue.then(async () => {
        const directory = path.dirname(filePath)
        const temporaryFile = `${filePath}.tmp-${process.pid}`
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(temporaryFile, `${JSON.stringify({
          envId: next.envId,
          accessKey: next.accessKey,
          updatedAt: next.updatedAt
        }, null, 2)}\n`, { mode: 0o600 })
        await fs.rename(temporaryFile, filePath)
        await fs.chmod(filePath, 0o600)
      })
      await writeQueue
      state = next
      return toPublicCredentials(state)
    }
  }
}

export function createMemoryCredentialStore(initial = {}) {
  let state = {
    ...normalizeCredentials(initial, false),
    updatedAt: null,
    source: initial.envId || initial.accessKey ? 'environment' : 'unset'
  }

  return {
    async get() {
      return { ...state }
    },
    async getPublic() {
      return toPublicCredentials(state)
    },
    async save(input) {
      const accessKey = input.accessKey || state.accessKey
      state = {
        ...normalizeCredentials({ envId: input.envId, accessKey }),
        updatedAt: new Date().toISOString(),
        source: 'saved'
      }
      return toPublicCredentials(state)
    }
  }
}

function normalizeCredentials(input, requireComplete = true) {
  const envId = typeof input?.envId === 'string' ? input.envId.trim() : ''
  const accessKey = typeof input?.accessKey === 'string' ? input.accessKey.trim() : ''

  if (envId && !/^[a-z0-9_-]{1,40}$/.test(envId)) {
    throw storeError('invalid_env_id', 'ENV_ID 格式不正确')
  }
  if (accessKey && (accessKey.length < 16 || accessKey.length > 4096)) {
    throw storeError('invalid_access_key', 'CLOUDBASE_APIKEY 长度必须在 16 到 4096 个字符之间')
  }
  if (requireComplete && (!envId || !accessKey)) {
    throw storeError('credentials_incomplete', 'ENV_ID 和 CLOUDBASE_APIKEY 都必须填写')
  }

  return { envId, accessKey }
}

function toPublicCredentials(credentials) {
  return {
    configured: Boolean(credentials.envId && credentials.accessKey),
    envId: credentials.envId,
    accessKeyMasked: maskSecret(credentials.accessKey),
    updatedAt: credentials.updatedAt,
    source: credentials.source
  }
}

function maskSecret(secret) {
  if (!secret) return ''
  if (secret.length <= 12) return `${secret.slice(0, 3)}****${secret.slice(-2)}`
  return `${secret.slice(0, 8)}****${secret.slice(-4)}`
}

function storeError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 })
}
