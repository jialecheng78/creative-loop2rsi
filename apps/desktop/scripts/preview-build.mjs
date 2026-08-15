import { fileURLToPath } from 'node:url'

import { buildPreview } from './preview-build-lib.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const result = await buildPreview({ root })
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  output: result.outputRoot,
  manifest: result.manifestPath,
  tree_sha256: result.treeSha256,
  source_commit: result.source.git_commit,
  unsigned: true,
}, null, 2)}\n`)
