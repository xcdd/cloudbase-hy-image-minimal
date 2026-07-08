import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveGenerateOptions } from '../direct-generate-lib.js'

test('resolveGenerateOptions keeps the original positional prompt usage', () => {
  const result = resolveGenerateOptions({
    argv: ['一只橘猫坐在窗边看雨', '1024x1024'],
    env: {}
  })

  assert.deepEqual(result, {
    prompt: '一只橘猫坐在窗边看雨',
    size: '1024x1024',
    footnote: ' '
  })
})

test('resolveGenerateOptions reads prompt text from a UTF-8 file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-file-'))
  const promptFile = path.join(tempDir, 'prompt.txt')
  fs.writeFileSync(promptFile, '欢迎来到上海', 'utf8')

  const result = resolveGenerateOptions({
    argv: ['--prompt-file', promptFile, '1024x1024'],
    env: {}
  })

  assert.deepEqual(result, {
    prompt: '欢迎来到上海',
    size: '1024x1024',
    footnote: ' '
  })
})
