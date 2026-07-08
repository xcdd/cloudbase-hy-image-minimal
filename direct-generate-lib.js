import fs from 'node:fs'

export function resolveGenerateOptions({ argv = [], env = process.env } = {}) {
  let prompt = null
  let size = '1024x1024'
  let footnote = env.FOOTNOTE ?? ' '

  if (argv[0] === '--prompt-file') {
    const promptFile = argv[1]
    if (!promptFile) {
      throw new Error('Usage: node direct-generate.js --prompt-file <file> [size] [footnote]')
    }

    prompt = fs.readFileSync(promptFile, 'utf8').trim()
    if (argv[2]) {
      size = argv[2]
    }
    if (argv[3] !== undefined) {
      footnote = argv[3]
    }
  } else {
    prompt = argv[0]
    if (argv[1]) {
      size = argv[1]
    }
    if (argv[2] !== undefined) {
      footnote = argv[2]
    }
  }

  return { prompt, size, footnote }
}
