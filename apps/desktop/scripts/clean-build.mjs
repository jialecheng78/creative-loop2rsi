import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const generatedDirectories = [
  'apps/desktop/dist',
  'packages/controller-bridge/dist',
  'packages/model-gateway/dist',
  'packages/runtime-dsh/dist',
]

for (const relative of generatedDirectories) {
  await rm(new URL(`../../../${relative}`, import.meta.url), { force: true, recursive: true })
}

process.stdout.write(`Cleaned ${generatedDirectories.length} generated build directories below ${repositoryRoot}\n`)
