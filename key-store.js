import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_COLLECTION = 'ai_service_keys'
const DEFAULT_CACHE_TTL_MS = 10000
const DEFAULT_KEY_FILE = '.service-keys.json'

export function createCloudBaseKeyStore({
  db,
  collectionName = DEFAULT_COLLECTION,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS
}) {
  if (!db) {
    throw new Error('`db` is required')
  }

  const collection = db.collection(collectionName)
  let activeHashes = new Set()
  let cacheExpiresAt = 0
  let refreshPromise

  const refresh = async () => {
    refreshPromise ??= collection.where({ enabled: true }).limit(100).get()
      .then((result) => {
        activeHashes = new Set(result.data.map((item) => item.keyHash))
        cacheExpiresAt = Date.now() + cacheTtlMs
      })
      .finally(() => {
        refreshPromise = undefined
      })

    await refreshPromise
  }

  const invalidate = async () => {
    cacheExpiresAt = 0
    await refresh()
  }

  return {
    async initialize(bootstrapKey) {
      await ensureCollection(db, collection)
      const existing = await collection.limit(1).get()

      if (existing.data.length === 0) {
        if (!bootstrapKey) {
          throw new Error('SERVICE_API_KEY is required to initialize the first access key')
        }
        await collection.add(createKeyDocument({ name: 'Bootstrap key', secret: bootstrapKey }))
      }

      await refresh()
    },

    async verify(secret) {
      if (typeof secret !== 'string' || !secret) {
        return false
      }
      if (Date.now() >= cacheExpiresAt) {
        await refresh()
      }
      return activeHashes.has(hashSecret(secret))
    },

    async list() {
      const result = await collection.orderBy('createdAt', 'desc').limit(100).get()
      return result.data.map(toPublicRecord)
    },

    async create(input) {
      const secret = normalizeSecret(input.secret) || generateSecret()
      const document = createKeyDocument({ name: input.name, secret })
      const result = await collection.add(document)
      await invalidate()
      return { record: toPublicRecord({ ...document, _id: result.id }), secret }
    },

    async update(id, input) {
      const patch = {
        updatedAt: new Date().toISOString()
      }
      let rotatedSecret

      if (input.name !== undefined) {
        patch.name = normalizeName(input.name)
      }
      if (input.enabled !== undefined) {
        patch.enabled = Boolean(input.enabled)
      }
      if (input.rotate || (input.secret !== undefined && input.secret !== '')) {
        rotatedSecret = normalizeSecret(input.secret) || generateSecret()
        patch.keyHash = hashSecret(rotatedSecret)
        patch.prefix = keyPrefix(rotatedSecret)
      }

      await collection.doc(id).update(patch)
      await invalidate()
      const result = await collection.doc(id).get()
      const record = result.data?.[0]
      if (!record) {
        throw createStoreError('key_not_found', 'Access key not found')
      }
      return { record: toPublicRecord(record), secret: rotatedSecret }
    },

    async remove(id) {
      await collection.doc(id).remove()
      await invalidate()
    }
  }
}

export function createMemoryKeyStore(initialSecret) {
  const records = new Map()

  if (initialSecret) {
    const document = createKeyDocument({ name: 'Bootstrap key', secret: initialSecret })
    records.set('bootstrap', { ...document, _id: 'bootstrap' })
  }

  return {
    async initialize() {},
    async verify(secret) {
      const hash = hashSecret(secret || '')
      return [...records.values()].some((record) => record.enabled && record.keyHash === hash)
    },
    async list() {
      return [...records.values()].map(toPublicRecord)
    },
    async create(input) {
      const id = crypto.randomUUID()
      const secret = normalizeSecret(input.secret) || generateSecret()
      const document = { ...createKeyDocument({ name: input.name, secret }), _id: id }
      records.set(id, document)
      return { record: toPublicRecord(document), secret }
    },
    async update(id, input) {
      const record = records.get(id)
      if (!record) {
        throw createStoreError('key_not_found', 'Access key not found')
      }
      if (input.name !== undefined) record.name = normalizeName(input.name)
      if (input.enabled !== undefined) record.enabled = Boolean(input.enabled)
      let rotatedSecret
      if (input.rotate || (input.secret !== undefined && input.secret !== '')) {
        rotatedSecret = normalizeSecret(input.secret) || generateSecret()
        record.keyHash = hashSecret(rotatedSecret)
        record.prefix = keyPrefix(rotatedSecret)
      }
      record.updatedAt = new Date().toISOString()
      return { record: toPublicRecord(record), secret: rotatedSecret }
    },
    async remove(id) {
      if (!records.delete(id)) {
        throw createStoreError('key_not_found', 'Access key not found')
      }
    }
  }
}

export function createFileKeyStore({ filePath = path.resolve(DEFAULT_KEY_FILE) } = {}) {
  const records = new Map()
  let loaded = false
  let writeQueue = Promise.resolve()

  const load = async () => {
    if (loaded) return

    try {
      const stored = JSON.parse(await fs.readFile(filePath, 'utf8'))
      if (stored?.version !== 1 || !Array.isArray(stored.keys)) {
        throw new Error('Invalid service key file format')
      }
      for (const item of stored.keys) {
        const record = normalizeStoredRecord(item)
        records.set(record._id, record)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    loaded = true
  }

  const persist = async () => {
    const content = `${JSON.stringify({
      version: 1,
      keys: [...records.values()]
    }, null, 2)}\n`

    writeQueue = writeQueue.then(async () => {
      const directory = path.dirname(filePath)
      const temporaryFile = `${filePath}.tmp-${process.pid}`
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(temporaryFile, content, { mode: 0o600 })
      await fs.rename(temporaryFile, filePath)
      await fs.chmod(filePath, 0o600)
    })
    await writeQueue
  }

  return {
    async initialize(bootstrapKey) {
      await load()
      if (records.size > 0) return false
      if (!bootstrapKey) {
        throw new Error('A bootstrap service API key is required')
      }
      const document = createKeyDocument({ name: 'Bootstrap key', secret: bootstrapKey })
      records.set('bootstrap', { ...document, _id: 'bootstrap' })
      await persist()
      return true
    },
    async verify(secret) {
      await load()
      const hash = hashSecret(secret || '')
      return [...records.values()].some((record) => record.enabled && record.keyHash === hash)
    },
    async list() {
      await load()
      return [...records.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(toPublicRecord)
    },
    async create(input) {
      await load()
      const id = crypto.randomUUID()
      const secret = normalizeSecret(input.secret) || generateSecret()
      const document = { ...createKeyDocument({ name: input.name, secret }), _id: id }
      records.set(id, document)
      await persist()
      return { record: toPublicRecord(document), secret }
    },
    async update(id, input) {
      await load()
      const record = records.get(id)
      if (!record) {
        throw createStoreError('key_not_found', 'Access key not found')
      }
      if (input.name !== undefined) record.name = normalizeName(input.name)
      if (input.enabled !== undefined) record.enabled = Boolean(input.enabled)
      let rotatedSecret
      if (input.rotate || (input.secret !== undefined && input.secret !== '')) {
        rotatedSecret = normalizeSecret(input.secret) || generateSecret()
        record.keyHash = hashSecret(rotatedSecret)
        record.prefix = keyPrefix(rotatedSecret)
      }
      record.updatedAt = new Date().toISOString()
      await persist()
      return { record: toPublicRecord(record), secret: rotatedSecret }
    },
    async remove(id) {
      await load()
      if (!records.delete(id)) {
        throw createStoreError('key_not_found', 'Access key not found')
      }
      await persist()
    }
  }
}

async function ensureCollection(db, collection) {
  try {
    await collection.limit(1).get()
    return
  } catch {
    try {
      await db.createCollection(collection.name)
    } catch {
      // Another instance may have created the collection concurrently.
    }
    await collection.limit(1).get()
  }
}

function createKeyDocument({ name, secret }) {
  const normalizedSecret = normalizeSecret(secret)
  const now = new Date().toISOString()
  return {
    name: normalizeName(name),
    prefix: keyPrefix(normalizedSecret),
    keyHash: hashSecret(normalizedSecret),
    enabled: true,
    createdAt: now,
    updatedAt: now
  }
}

function normalizeName(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value || value.length > 80) {
    throw createStoreError('invalid_key_name', 'Key name must be between 1 and 80 characters')
  }
  return value
}

function normalizeSecret(secret) {
  if (secret === undefined || secret === null || secret === '') {
    return ''
  }
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 256) {
    throw createStoreError('invalid_key_secret', 'Key secret must be between 16 and 256 characters')
  }
  return secret
}

function generateSecret() {
  return `cbsk_${crypto.randomBytes(24).toString('base64url')}`
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

function keyPrefix(secret) {
  if (secret.length <= 12) {
    return `${secret.slice(0, 4)}...`
  }
  return `${secret.slice(0, 7)}...${secret.slice(-4)}`
}

function toPublicRecord(record) {
  return {
    id: String(record._id),
    name: record.name,
    prefix: record.prefix,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function normalizeStoredRecord(record) {
  if (!record || typeof record !== 'object' || typeof record._id !== 'string' ||
      typeof record.name !== 'string' || typeof record.prefix !== 'string' ||
      typeof record.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.keyHash) ||
      typeof record.enabled !== 'boolean' || typeof record.createdAt !== 'string' ||
      typeof record.updatedAt !== 'string') {
    throw new Error('Invalid record in service key file')
  }
  return { ...record }
}

function createStoreError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 })
}
