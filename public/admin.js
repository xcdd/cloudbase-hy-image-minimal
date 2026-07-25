const elements = {
  loginView: document.querySelector('#login-view'),
  dashboardView: document.querySelector('#dashboard-view'),
  loginForm: document.querySelector('#login-form'),
  loginError: document.querySelector('#login-error'),
  password: document.querySelector('#admin-password'),
  togglePassword: document.querySelector('#toggle-password'),
  logout: document.querySelector('#logout-button'),
  refresh: document.querySelector('#refresh-button'),
  credentialForm: document.querySelector('#credential-form'),
  credentialEnvId: document.querySelector('#credential-env-id'),
  credentialAccessKey: document.querySelector('#credential-access-key'),
  credentialMasked: document.querySelector('#credential-masked'),
  credentialStatus: document.querySelector('#credential-status'),
  credentialUpdated: document.querySelector('#credential-updated'),
  credentialError: document.querySelector('#credential-error'),
  toggleCredential: document.querySelector('#toggle-credential'),
  newKey: document.querySelector('#new-key-button'),
  search: document.querySelector('#key-search'),
  tableBody: document.querySelector('#key-table-body'),
  emptyState: document.querySelector('#empty-state'),
  metricTotal: document.querySelector('#metric-total'),
  metricActive: document.querySelector('#metric-active'),
  metricPort: document.querySelector('#metric-port'),
  loginPort: document.querySelector('#login-port'),
  keyCount: document.querySelector('#key-count'),
  keyDialog: document.querySelector('#key-dialog'),
  keyForm: document.querySelector('#key-form'),
  keyId: document.querySelector('#key-id'),
  keyName: document.querySelector('#key-name'),
  keySecret: document.querySelector('#key-secret'),
  keyEnabled: document.querySelector('#key-enabled'),
  keyRotate: document.querySelector('#key-rotate'),
  enabledRow: document.querySelector('#enabled-row'),
  rotateRow: document.querySelector('#rotate-row'),
  keyDialogCode: document.querySelector('#key-dialog-code'),
  keyDialogTitle: document.querySelector('#key-dialog-title'),
  keyFormError: document.querySelector('#key-form-error'),
  secretDialog: document.querySelector('#secret-dialog'),
  generatedSecret: document.querySelector('#generated-secret'),
  copySecret: document.querySelector('#copy-secret'),
  deleteDialog: document.querySelector('#delete-dialog'),
  deleteKeyName: document.querySelector('#delete-key-name'),
  confirmDelete: document.querySelector('#confirm-delete'),
  toast: document.querySelector('#toast')
}

const state = {
  keys: [],
  credentials: null,
  deleteId: null,
  toastTimer: null
}

const currentPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
elements.metricPort.textContent = currentPort
elements.loginPort.textContent = currentPort

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector(`#${button.dataset.close}`).close())
})

elements.loginForm.addEventListener('submit', login)
elements.logout.addEventListener('click', logout)
elements.refresh.addEventListener('click', refreshAll)
elements.credentialForm.addEventListener('submit', saveCredentials)
elements.toggleCredential.addEventListener('click', toggleCredential)
elements.newKey.addEventListener('click', () => openKeyDialog())
elements.search.addEventListener('input', renderKeys)
elements.keyForm.addEventListener('submit', saveKey)
elements.confirmDelete.addEventListener('click', deleteKey)
elements.copySecret.addEventListener('click', copySecret)
elements.togglePassword.addEventListener('click', togglePassword)
elements.secretDialog.addEventListener('close', () => {
  elements.generatedSecret.value = ''
})

await restoreSession()
refreshIcons()

async function restoreSession() {
  try {
    await request('/admin/session')
    showDashboard()
    await refreshAll()
  } catch {
    showLogin()
  }
}

async function login(event) {
  event.preventDefault()
  elements.loginError.textContent = ''
  setFormBusy(elements.loginForm, true)

  try {
    await request('/admin/login', {
      method: 'POST',
      body: { password: elements.password.value }
    })
    elements.loginForm.reset()
    showDashboard()
    await refreshAll()
  } catch (error) {
    elements.loginError.textContent = error.message
  } finally {
    setFormBusy(elements.loginForm, false)
  }
}

async function logout() {
  try {
    await request('/admin/logout', { method: 'POST' })
  } finally {
    state.keys = []
    showLogin()
  }
}

async function loadKeys() {
  try {
    const result = await request('/admin/api/keys')
    state.keys = result.keys
    renderKeys()
  } catch (error) {
    if (error.status === 401) {
      showLogin()
      return
    }
    showToast(error.message, true)
  }
}

async function refreshAll() {
  elements.refresh.disabled = true
  elements.refresh.classList.add('spinning')
  try {
    await Promise.all([loadCredentials(), loadKeys()])
  } finally {
    elements.refresh.disabled = false
    elements.refresh.classList.remove('spinning')
  }
}

async function loadCredentials() {
  try {
    const result = await request('/admin/api/credentials')
    state.credentials = result.credentials
    renderCredentials()
  } catch (error) {
    if (error.status === 401) {
      showLogin()
      return
    }
    showToast(error.message, true)
  }
}

function renderCredentials() {
  const credentials = state.credentials
  elements.credentialEnvId.value = credentials?.envId || ''
  elements.credentialAccessKey.value = ''
  elements.credentialAccessKey.placeholder = credentials?.configured
    ? '留空保持当前凭据不变'
    : '粘贴 CLOUDBASE_APIKEY'
  elements.credentialMasked.textContent = credentials?.accessKeyMasked || '未配置'
  elements.credentialStatus.textContent = credentials?.configured ? '已配置' : '未配置'
  elements.credentialStatus.className = `status-badge ${credentials?.configured ? 'enabled' : 'disabled'}`
  elements.credentialUpdated.textContent = credentials?.updatedAt
    ? `更新于 ${formatDate(credentials.updatedAt)}`
    : credentials?.source === 'environment' ? '来自环境变量' : '尚未保存'
}

async function saveCredentials(event) {
  event.preventDefault()
  elements.credentialError.textContent = ''
  setFormBusy(elements.credentialForm, true)

  try {
    const result = await request('/admin/api/credentials', {
      method: 'PUT',
      body: {
        envId: elements.credentialEnvId.value,
        accessKey: elements.credentialAccessKey.value
      }
    })
    state.credentials = result.credentials
    renderCredentials()
    showToast('CloudBase 凭据已保存')
  } catch (error) {
    elements.credentialError.textContent = error.message
  } finally {
    setFormBusy(elements.credentialForm, false)
  }
}

function renderKeys() {
  const query = elements.search.value.trim().toLocaleLowerCase()
  const visible = state.keys.filter((key) => {
    return !query || key.name.toLocaleLowerCase().includes(query) || key.prefix.toLocaleLowerCase().includes(query)
  })

  elements.tableBody.replaceChildren(...visible.map(createKeyRow))
  elements.emptyState.hidden = visible.length !== 0
  elements.metricTotal.textContent = String(state.keys.length)
  elements.metricActive.textContent = String(state.keys.filter((key) => key.enabled).length)
  elements.keyCount.textContent = `${visible.length} 项`
  refreshIcons()
}

function createKeyRow(key) {
  const row = document.createElement('tr')

  const nameCell = document.createElement('td')
  const name = document.createElement('div')
  name.className = 'key-name'
  const symbol = document.createElement('span')
  symbol.className = 'key-symbol'
  symbol.append(icon('key'))
  const nameText = document.createElement('span')
  nameText.textContent = key.name
  name.append(symbol, nameText)
  nameCell.append(name)

  const prefixCell = document.createElement('td')
  prefixCell.className = 'key-prefix'
  prefixCell.textContent = key.prefix

  const statusCell = document.createElement('td')
  const status = document.createElement('span')
  status.className = `status-badge ${key.enabled ? 'enabled' : 'disabled'}`
  status.textContent = key.enabled ? '已启用' : '已停用'
  statusCell.append(status)

  const dateCell = document.createElement('td')
  dateCell.className = 'key-date'
  dateCell.textContent = formatDate(key.updatedAt)

  const actionsCell = document.createElement('td')
  const actions = document.createElement('div')
  actions.className = 'row-actions'
  const editButton = iconButton('pencil', '编辑密钥')
  editButton.addEventListener('click', () => openKeyDialog(key))
  const deleteButton = iconButton('trash-2', '删除密钥')
  deleteButton.classList.add('delete-button')
  deleteButton.addEventListener('click', () => openDeleteDialog(key))
  actions.append(editButton, deleteButton)
  actionsCell.append(actions)

  row.append(nameCell, prefixCell, statusCell, dateCell, actionsCell)
  return row
}

function openKeyDialog(key) {
  const editing = Boolean(key)
  elements.keyForm.reset()
  elements.keyFormError.textContent = ''
  elements.keyId.value = key?.id || ''
  elements.keyName.value = key?.name || ''
  elements.keyEnabled.checked = key?.enabled ?? true
  elements.keyRotate.checked = false
  elements.enabledRow.hidden = !editing
  elements.rotateRow.hidden = !editing
  elements.keyDialogCode.textContent = editing ? 'KEY / EDIT' : 'KEY / NEW'
  elements.keyDialogTitle.textContent = editing ? '编辑密钥' : '新建密钥'
  elements.keySecret.placeholder = editing ? '留空保持不变' : '留空自动生成'
  elements.keyDialog.showModal()
  elements.keyName.focus()
}

async function saveKey(event) {
  event.preventDefault()
  elements.keyFormError.textContent = ''
  setFormBusy(elements.keyForm, true)

  const id = elements.keyId.value
  const body = {
    name: elements.keyName.value.trim(),
    secret: elements.keySecret.value
  }
  if (id) {
    body.enabled = elements.keyEnabled.checked
    body.rotate = elements.keyRotate.checked
  }

  try {
    const result = await request(id ? `/admin/api/keys/${encodeURIComponent(id)}` : '/admin/api/keys', {
      method: id ? 'PATCH' : 'POST',
      body
    })
    elements.keyDialog.close()
    await loadKeys()
    if (result.secret) showGeneratedSecret(result.secret)
    showToast(id ? '密钥已更新' : '密钥已创建')
  } catch (error) {
    elements.keyFormError.textContent = error.message
  } finally {
    setFormBusy(elements.keyForm, false)
  }
}

function openDeleteDialog(key) {
  state.deleteId = key.id
  elements.deleteKeyName.textContent = key.name
  elements.deleteDialog.showModal()
}

async function deleteKey() {
  if (!state.deleteId) return
  elements.confirmDelete.disabled = true
  try {
    await request(`/admin/api/keys/${encodeURIComponent(state.deleteId)}`, { method: 'DELETE' })
    elements.deleteDialog.close()
    state.deleteId = null
    await loadKeys()
    showToast('密钥已删除')
  } catch (error) {
    showToast(error.message, true)
  } finally {
    elements.confirmDelete.disabled = false
  }
}

function showGeneratedSecret(secret) {
  elements.generatedSecret.value = secret
  elements.secretDialog.showModal()
}

async function copySecret() {
  try {
    await navigator.clipboard.writeText(elements.generatedSecret.value)
    showToast('密钥已复制')
  } catch {
    elements.generatedSecret.select()
    document.execCommand('copy')
    showToast('密钥已复制')
  }
}

function togglePassword() {
  const visible = elements.password.type === 'text'
  elements.password.type = visible ? 'password' : 'text'
  elements.togglePassword.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码')
  elements.togglePassword.title = visible ? '显示密码' : '隐藏密码'
  elements.togglePassword.replaceChildren(icon(visible ? 'eye' : 'eye-off'))
  refreshIcons()
}

function toggleCredential() {
  const visible = elements.credentialAccessKey.type === 'text'
  elements.credentialAccessKey.type = visible ? 'password' : 'text'
  elements.toggleCredential.setAttribute('aria-label', visible ? '显示输入内容' : '隐藏输入内容')
  elements.toggleCredential.title = visible ? '显示输入内容' : '隐藏输入内容'
  elements.toggleCredential.replaceChildren(icon(visible ? 'eye' : 'eye-off'))
  refreshIcons()
}

function showDashboard() {
  elements.loginView.hidden = true
  elements.dashboardView.hidden = false
  document.title = 'CloudBase 凭据 | CloudBase AI Control'
  refreshIcons()
}

function showLogin() {
  elements.dashboardView.hidden = true
  elements.loginView.hidden = false
  elements.loginError.textContent = ''
  elements.password.focus()
  document.title = '登录 | CloudBase AI Control'
  refreshIcons()
}

function showToast(message, error = false) {
  clearTimeout(state.toastTimer)
  elements.toast.textContent = message
  elements.toast.classList.toggle('error', error)
  elements.toast.classList.add('visible')
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2400)
}

async function request(url, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) }
  const init = { method: options.method || 'GET', credentials: 'same-origin', headers }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  const response = await fetch(url, init)
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json') ? await response.json() : null

  if (!response.ok) {
    const error = new Error(result?.error?.message || `Request failed (${response.status})`)
    error.status = response.status
    error.code = result?.error?.code
    throw error
  }
  return result
}

function icon(name) {
  const element = document.createElement('i')
  element.dataset.lucide = name
  return element
}

function iconButton(name, label) {
  const button = document.createElement('button')
  button.className = 'icon-button'
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.append(icon(name))
  return button
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } })
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

function setFormBusy(form, busy) {
  form.querySelectorAll('button, input').forEach((control) => {
    control.disabled = busy
  })
}
