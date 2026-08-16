import { fileURLToPath } from 'node:url'

import { buildMacRelease } from './release-build-lib.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const result = await buildMacRelease({ root })
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  output: result.outputRoot,
  artifacts: [result.mainArchive, result.evidenceArchive, result.checksums],
  source_commit: result.source.git_commit,
  main_sha256: result.mainArtifact.sha256,
  evidence_sha256: result.evidenceArtifact.sha256,
}, null, 2)}\n`)
