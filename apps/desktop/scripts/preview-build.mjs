import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const entry = resolve('dist/main/index.js')
await access(entry)
process.stdout.write(`Unpackaged preview build ready: ${entry}\n`)
process.stdout.write('Installer generation remains blocked by the repository exotic-subdependency policy.\n')
